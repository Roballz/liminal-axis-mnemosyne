import type { Transaction } from './db';
import { check, type Block, type Branch, type CurrentRevision, type MemoryRevision, type Revision, type Row, type Snapshot, type SourceBody, type SourceRef, type Store, type TableCommit } from './model';

/** A descriptor is evidence, not permission to substitute a different revision's text. */
export async function readSource(tx: Transaction, id: string): Promise<CurrentRevision | undefined> {
    const source = await tx.get<Revision>('source_revisions', id);
    if (!source) return undefined;
    if (source.bodySchema !== 1) return typeof source.content === 'string' ? { ...source, content: source.content } : undefined;
    const body = await tx.get<SourceBody>('source_bodies', id);
    if (!body) return undefined;
    check(body.owner === source.owner && body.story === source.story && body.content.length === source.bodyLength, '当前正文与来源身份不一致');
    return { ...source, content: body.content };
}

export async function snapshotVariants(tx: Transaction, snapshot: Snapshot): Promise<number[]> {
    if (snapshot.snapshotSchema !== 2) return snapshot.variants ?? Array(snapshot.length).fill(0);
    const result: number[] = [];
    for (const key of snapshot.blocks) {
        const block = await tx.get<Block>('manifest_blocks', key);
        check(block && block.variants && block.variants.length === block.entries.length, '当前来源块缺少变体身份');
        result.push(...block.variants);
    }
    check(result.length === snapshot.length, '变体清单计数错误');
    return result;
}

const evidenceStores: Store[] = ['memory_revisions', 'reviews', 'event_revisions', 'event_memberships',
    'event_progress', 'event_processing_receipts', 'custom_table_rows', 'table_receipts', 'table_history'];

/** Reclaim only records born under this policy, inside the same transaction as head publication.
 * Legacy rows are not converted or removed. Metadata evidence is a descriptor root, never a body root.
 * Read reference metadata, not historical text; scope deletion to this branch's superseded snapshots.
 */
export async function retireCurrentBodies(tx: Transaction, branch: Branch, previousRefs: SourceRef[], current?: {
    refs: SourceRef[]; memories: MemoryRevision[];
}) {
    if (current) {
        const live = new Map(current.refs.map(ref => [ref.message, ref.revision]));
        if (previousRefs.every(ref => live.get(ref.message) === ref.revision)) {
            // An additive head cannot retire a prior body. Skip the history sweep
            // only if every old current-policy snapshot has a positive, live root.
            // Merely being an append is insufficient: unrooted blocks still need cleanup.
            const roots = new Set([branch.head, branch.legacyHead, branch.fork?.snapshot,
                ...current.memories.flatMap(memory => [memory.basis, memory.sourceRecovery?.snapshot])]);
            if (branch.tableHead) {
                const table = await tx.get<TableCommit>('table_history', branch.tableHead);
                if (table) roots.add(table.snapshot);
            }
            const owned = await tx.all<Snapshot>('history_snapshots', 'branch', branch.id);
            if (owned.every(snapshot => snapshot.snapshotSchema !== 2 || roots.has(snapshot.id))) return;
        }
    }
    const branches = await tx.all<Branch>('branches', 'story', branch.story);
    const snapshots = await tx.all<Snapshot>('history_snapshots', 'story', branch.story);
    const blockRows = await Promise.all([...new Set(snapshots.flatMap(s => s.blocks))].map(id => tx.get<Block>('manifest_blocks', id)));
    check(blockRows.every(Boolean), '来源清单块缺失');
    const blocks = blockRows as Block[];
    const byBlock = new Map(blocks.map(block => [block.id, block]));
    const bySnapshot = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
    const refs = (snapshot: Snapshot) => snapshot.blocks.flatMap(key => {
        const block = byBlock.get(key); check(block, '来源清单块缺失'); return block.entries;
    });
    const snapshotRoots = new Set(branches.flatMap(b => [b.head, ...(b.fork ? [b.fork.snapshot] : []), ...(b.legacyHead ? [b.legacyHead] : [])]));
    const sourceRoots = new Set<string>();
    const currentBodies = new Set<string>();
    for (const b of branches) {
        const head = bySnapshot.get(b.head); check(head, '当前分支快照缺失');
        for (const ref of refs(head)) currentBodies.add(ref.revision);
        for (const pair of b.sourceRoleRepairs ?? []) {
            for (const ref of [pair.before, pair.after]) {
                sourceRoots.add(ref.revision);
                // A single branch-local witness suffices; do not pin every later swipe observation.
                const witness = snapshots.find(s => s.branch === b.id && refs(s).some(r => r.message === ref.message && r.revision === ref.revision));
                check(witness, '角色修复来源证明缺失'); snapshotRoots.add(witness.id);
            }
        }
    }
    const collect = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const item = value as { message?: unknown; revision?: unknown; basis?: unknown; snapshot?: unknown };
        if (typeof item.message === 'string' && typeof item.revision === 'string') sourceRoots.add(item.revision);
        if (typeof item.basis === 'string') snapshotRoots.add(item.basis);
        if (typeof item.snapshot === 'string') snapshotRoots.add(item.snapshot);
        for (const child of Object.values(value)) if (child && typeof child === 'object') collect(child);
    };
    for (const store of evidenceStores) for (const item of await tx.all<Row>(store, 'story', branch.story)) collect(item);
    const remove = snapshots.filter(s => s.snapshotSchema === 2 && s.branch === branch.id && !snapshotRoots.has(s.id));
    const removedIds = new Set(remove.map(s => s.id));
    const remaining = snapshots.filter(s => !removedIds.has(s.id));
    const keptBlocks = new Set(remaining.flatMap(s => s.blocks));
    const candidates = new Set([...previousRefs.map(r => r.revision), ...remove.flatMap(s => refs(s).map(r => r.revision))]);
    for (const snapshot of remaining) for (const ref of refs(snapshot)) sourceRoots.add(ref.revision);
    for (const snapshot of remove) await tx.delete('history_snapshots', snapshot.id);
    const removedBlocks = new Set(remove.flatMap(s => s.blocks));
    for (const key of removedBlocks) if (!keptBlocks.has(key) && byBlock.get(key)?.variants) await tx.delete('manifest_blocks', key);
    for (const id of candidates) {
        if (currentBodies.has(id)) continue;
        const source = await tx.get<Revision>('source_revisions', id);
        if (source?.bodySchema !== 1) continue;
        if (!currentBodies.has(id)) await tx.delete('source_bodies', id);
        // A deleted originating archive may have a retained provenance receipt. Keep its tiny
        // descriptor as that receipt's witness; never keep the retired body for this reason.
        if (!sourceRoots.has(id) && await tx.get('host_bindings', source.provenance.binding))
            await tx.delete('source_revisions', id);
    }
}
