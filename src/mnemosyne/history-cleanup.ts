import { Library, type Transaction, type StoreIndex } from './db';
import { STORES, check, equal, fingerprint, row, type Store, type Row, type Branch, type Memory, type MemoryRevision,
    type MemoryView, type MemorySelectionNode, type Snapshot, type Block, type Revision, type SourceBody, type TableDef } from './model';
import { snapshotWithStamp, assertWriteStamp } from './archive-package';
import { validateCurrentData, type Package } from './migration';
import { SharedPayloads, SHARED_META, sharedStore } from './shared-payloads';
import { materializeMemoryView, publishMemoryView } from './memory-selections';
import { EVIDENCE_STORES, isEvidenceStore, rowRetentionRoots } from './retention-roots';
import { snapshotRefs, statusesInTransaction, sameNarrativeRevision } from './canonical';
import { retireSupersededSummaries, retireAbandonedTableHistory, retireEventDependencies } from './summary-retention';
import { purgeTables } from './table-history';
import { unreferencedStorage } from './shared-garbage';
import { utf8ByteLength } from './json';
import type { ReorganizationProgress } from './core-reorganization';

type RootCounts = { snapshotRoots: Map<string, number>; sourceRoots: Map<string, number>; memoryRoots: Map<string, number> };
const emptyCounts = (): RootCounts => ({ snapshotRoots: new Map(), sourceRoots: new Map(), memoryRoots: new Map() });
/** Worker-only plan: maps share unchanged immutable rows with the original read.
 * Only changed rows are replaced. Secondary ID indexes avoid repeated whole-array scans. */
class HistoryPlan {
    readonly sharedWrites = true;
    private rows = new Map<Store, Map<string, Row>>();
    private indexes = new Map<Store, Map<string, Map<string, Set<string>>>>();
    private roots = new Map<string, RootCounts>();
    private payloads = new SharedPayloads(async id => this.rows.get('memory_payloads')!.get(id) as any,
        async value => { this.store('memory_payloads', value); });
    readonly tx = this as unknown as Transaction;
    constructor(data: Package['data']) {
        for (const store of STORES) { this.rows.set(store, new Map()); this.indexes.set(store, new Map());
            for (const value of data[store]) this.store(store, value); }
    }
    private keys(value: Row) {
        return Object.entries({ story: value.story, branch: value.branch, owner: value.owner,
            ...(value.branch && 'hostId' in value ? { branch_host: [value.branch, (value as any).hostId] } : {}) })
            .filter(([, value]) => value !== undefined).map(([field, value]) => [field, JSON.stringify(value)]);
    }
    private store(store: Store, value: Row) {
        const prior = this.rows.get(store)!.get(value.id);
        if (prior) for (const [field, key] of this.keys(prior)) this.indexes.get(store)!.get(field)?.get(key)?.delete(prior.id);
        this.rows.get(store)!.set(value.id, value);
        for (const [field, key] of this.keys(value)) {
            const fields = this.indexes.get(store)!;
            if (!fields.has(field)) fields.set(field, new Map());
            if (!fields.get(field)!.has(key)) fields.get(field)!.set(key, new Set());
            fields.get(field)!.get(key)!.add(value.id);
        }
    }
    private count(value: Row, amount: 1 | -1) {
        const evidence = rowRetentionRoots(value);
        if (!evidence?.story) return;
        let counts = this.roots.get(evidence.story);
        if (!counts) this.roots.set(evidence.story, counts = emptyCounts());
        for (const field of ['snapshotRoots', 'sourceRoots', 'memoryRoots'] as const) for (const id of evidence[field]) {
            const n = (counts[field].get(id) ?? 0) + amount;
            check(n >= 0, '历史清理引用计数不一致');
            if (n) counts[field].set(id, n); else counts[field].delete(id);
        }
    }
    async initialize() {
        for (const store of EVIDENCE_STORES) for (const value of await this.all(store)) this.count(value, 1);
    }
    async rawGet<T extends Row>(store: Store, id: string) { return this.rows.get(store)!.get(id) as T | undefined; }
    async get<T extends Row>(store: Store, id: string): Promise<T | undefined> {
        const value = this.rows.get(store)!.get(id); if (!value) return;
        if (store === 'memory_views') return await materializeMemoryView(value as any,
            id => this.rawGet<MemorySelectionNode>('memory_selection_nodes', id)) as unknown as T;
        const logical = sharedStore(store) ? await this.payloads.unpack(store, value) : value;
        return { ...logical } as T;
    }
    async rawAll<T extends Row>(store: Store, index?: StoreIndex, key?: IDBValidKey): Promise<T[]> {
        const rows = this.rows.get(store)!;
        return (index ? [...(this.indexes.get(store)!.get(index)?.get(JSON.stringify(key)) ?? [])].map(id => rows.get(id)!)
            : [...rows.values()]) as T[];
    }
    async all<T extends Row>(store: Store, index?: StoreIndex, key?: IDBValidKey): Promise<T[]> {
        const result: T[] = [];
        for (const value of await this.rawAll(store, index, key)) result.push((await this.get<T>(store, value.id))!);
        return result;
    }
    async put(store: Store, value: Row) {
        if (isEvidenceStore(store)) { const old = await this.get(store, value.id); if (old) this.count(old, -1); this.count(value, 1); }
        this.store(store, sharedStore(store) ? await this.payloads.pack(store, value) : value); return value.id;
    }
    async add(store: Store, value: Row) { check(!this.rows.get(store)!.has(value.id), '历史清理生成了重复身份'); return this.put(store, value); }
    async delete(store: Store, id: string) {
        const value = this.rows.get(store)!.get(id); if (!value) return;
        if (isEvidenceStore(store)) this.count((await this.get(store, id))!, -1);
        for (const [field, key] of this.keys(value)) this.indexes.get(store)!.get(field)?.get(key)?.delete(id);
        this.rows.get(store)!.delete(id);
    }
    async retentionRoots(story: string) {
        const roots = this.roots.get(story) ?? emptyCounts();
        return { snapshotRoots: new Set(roots.snapshotRoots.keys()), sourceRoots: new Set(roots.sourceRoots.keys()),
            memoryRoots: new Set(roots.memoryRoots.keys()), memoryReferenceCounts: new Map(roots.memoryRoots) };
    }
    collectStorageGarbage() { /* One complete reachability pass at the end of the plan. */ }
    data(): Package['data'] {
        return Object.fromEntries(STORES.map(store => [store, [...this.rows.get(store)!.values()]
            .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)])) as Package['data'];
    }
}

const validation = (data: Package['data']) => ({ format: 'mnemosyne-daily' as const, version: 18 as const, schema: 1 as const,
    created: Date.now(), excluded: [], counts: Object.fromEntries(STORES.map(s => [s, data[s].length])) as Package['counts'], data });
const bytes = (data: Package['data']) => STORES.reduce((sum, store) => sum + 2 +
    data[store].reduce((n, row) => n + utf8ByteLength(JSON.stringify(row)) + 1, 0), 0);
export interface HistoryCleanupReport {
    beforeBytes: number; afterBytes: number; removed: Record<Store, number>; changed: number; archives: number;
}

/** Existing v1-v17 history can be reclaimed in place. Build and fully validate a
 * plan off the UI thread; a single compare-and-write transaction commits it. */
export async function cleanLibraryHistory(lib: Library, guard: () => Promise<boolean>,
    progress: (value: ReorganizationProgress) => void = () => {}): Promise<HistoryCleanupReport> {
    check(await guard(), '清理页面已改变');
    const before = await snapshotWithStamp(lib);
    await validateCurrentData(validation(before.data));
    const beforeBytes = bytes(before.data), plan = new HistoryPlan(before.data);
    await plan.initialize();
    const branches = await plan.all<Branch>('branches');
    let archives = 0;
    for (const branch of branches) {
        check(await guard(), '清理期间聊天或页面改变，未删除任何数据');
        const snapshot = await plan.get<Snapshot>('history_snapshots', branch.head); check(snapshot, '档案正文快照缺失');
        const refs = await snapshotRefs(plan.tx, snapshot), selection = (await plan.get<MemoryView>('memory_views', branch.view))!;
        const history = await plan.all<MemoryRevision>('memory_revisions', 'branch', branch.id);
        const byId = new Map(history.map(m => [m.id, m])), selected = Object.values(selection.selections).map(id => byId.get(id)!);
        check(selected.every(Boolean), '档案当前摘要缺失');
        const states = await statusesInTransaction(plan.tx, { branch, snapshot, refs, cutoff: refs.length,
            memories: selected.map(m => ({ ...m, recall: true, visibility: 'public' as const })) });
        const next: MemoryView = { ...row('mv'), branch: branch.id, selections: { ...selection.selections } };
        for (const memory of selected) if (!memory.sourceRecovery && ['needs_review', 'needs_rebuild', 'out_of_scope'].includes(states.get(memory.id)!)) {
            delete next.selections[memory.owner];
            const family = await plan.get<Memory>('memories', memory.owner); check(family, '摘要身份缺失');
            await plan.put('memories', { ...family, retiredFingerprint: memory.fingerprint } as Memory);
        }
        if (!equal(selection.selections, next.selections)) {
            await publishMemoryView(plan.tx, next, selection); branch.view = next.id;
        }
        const current = branch.view === selection.id ? selection : next;
        const active = new Set<string>(), pending = Object.values(current.selections);
        while (pending.length) {
            const id = pending.pop()!; if (active.has(id)) continue; active.add(id);
            const memory = byId.get(id) ?? await plan.get<MemoryRevision>('memory_revisions', id); check(memory, '保留摘要的依赖缺失');
            pending.push(...memory.dependencies);
        }
        const currentFamilies = new Map(selected.filter(m => active.has(m.id)).map(m => [m.owner, m]));
        const retired = new Set(history.filter(m => !active.has(m.id) &&
            !(currentFamilies.has(m.owner) && sameNarrativeRevision(m, currentFamilies.get(m.owner)!))).map(m => m.id));
        const eventChanges = await retireEventDependencies(plan.tx, branch, retired, refs.length, currentFamilies);
        const deletedTables = new Set((await plan.all<TableDef>('custom_table_defs', 'branch', branch.id)).filter(t => t.deleted).map(t => t.id));
        await purgeTables(plan.tx, branch, deletedTables);
        await retireAbandonedTableHistory(plan.tx, branch);
        for (const receipt of await plan.all<Row>('table_receipts', 'branch', branch.id))
            if ([...(rowRetentionRoots(receipt)?.memoryRoots ?? [])].some(id => retired.has(id))) await plan.delete('table_receipts', receipt.id);
        delete branch.legacyHead;
        if (branch.view !== selection.id || eventChanges || deletedTables.size) branch.epoch++;
        await plan.put('branches', branch);
        await retireSupersededSummaries(plan.tx, branch, selection, current, history.map(m => m.id));
        if (!branch.archiveSupport) archives++;
        progress({ phase: 'copy', store: 'memory_revisions', records: archives });
    }
    // Cross-branch DAG edges can postpone a candidate until its former owner was
    // processed. Reach a fixed point in memory without rereading the database.
    let remaining = Infinity;
    while ((await plan.rawAll('memory_revisions')).length < remaining) {
        remaining = (await plan.rawAll('memory_revisions')).length;
        for (const branch of await plan.all<Branch>('branches')) {
            const selection = (await plan.get<MemoryView>('memory_views', branch.view))!;
            await retireSupersededSummaries(plan.tx, branch, selection, selection,
                (await plan.rawAll('memory_revisions', 'branch', branch.id)).map(m => m.id));
        }
    }
    await retireSourceHistory(plan);
    // Existing unchanged events and summaries join the same immutable content pool;
    // child branches now reference that content and add payloads only on a real edit.
    for (const store of ['memory_revisions', 'reviews', 'event_revisions', 'event_progress'] as const)
        for (const value of await plan.all(store)) await plan.put(store, value);
    await plan.put('library_meta', { id: SHARED_META, schema: 1, value: { version: 1 } } as Row);
    const garbage = unreferencedStorage(plan.data());
    for (const store of ['memory_payloads', 'memory_selection_nodes'] as const)
        for (const id of garbage[store]) await plan.delete(store, id);
    const data = plan.data();
    progress({ phase: 'validate', store: '', records: archives });
    await validateCurrentData(validation(data));
    const removed = Object.fromEntries(STORES.map(s => [s, 0])) as Record<Store, number>;
    const puts: [Store, Row][] = [], deletes: [Store, string][] = [];
    for (const store of STORES) {
        const prior = new Map(before.data[store].map(r => [r.id, r])), after = new Map(data[store].map(r => [r.id, r]));
        for (const row of before.data[store]) if (!after.has(row.id)) { deletes.push([store, row.id]); removed[store]++; }
        for (const row of data[store]) if (!equal(prior.get(row.id), row)) puts.push([store, row]);
    }
    const report = { beforeBytes, afterBytes: bytes(data), removed, changed: puts.length, archives };
    check(await guard(), '清理期间聊天或页面改变，未删除任何数据');
    const compact = lib.compactWrites, physical = lib.preservePhysicalWrites;
    lib.compactWrites = false; lib.preservePhysicalWrites = true;
    try {
        await lib.transaction(STORES, 'readwrite', async tx => {
            await assertWriteStamp(tx, before.stamp);
            for (const [store, row] of puts) await tx.put(store, row);
            for (const [store, id] of deletes) if (store !== 'memory_payloads') await tx.delete(store, id);
            await tx.flushEvidenceReads();
            for (const [store, id] of deletes) if (store === 'memory_payloads') await tx.delete(store, id);
            tx.rebuildStorageReferences(data);
        });
        lib.compactWrites = true;
    } catch (error) { lib.compactWrites = compact; throw error; }
    finally { lib.preservePhysicalWrites = physical; }
    return report;
}

async function retireSourceHistory(plan: HistoryPlan) {
    const branches = await plan.all<Branch>('branches'), snapshots = await plan.all<Snapshot>('history_snapshots');
    const blocks = new Map((await plan.all<Block>('manifest_blocks')).map(b => [b.id, b]));
    const refs = (snapshot: Snapshot) => snapshot.blocks.flatMap(id => { const b = blocks.get(id); check(b, '正文索引缺失'); return b.entries; });
    const roots = new Set(branches.flatMap(b => [b.head, ...(b.fork ? [b.fork.snapshot] : [])]));
    const sources = new Set<string>(), bodies = new Set<string>();
    for (const story of new Set(branches.map(b => b.story))) {
        const evidence = await plan.retentionRoots(story);
        for (const id of evidence.snapshotRoots) roots.add(id);
        for (const id of evidence.sourceRoots) sources.add(id);
    }
    const bySnapshot = new Map(snapshots.map(s => [s.id, s]));
    const witnesses = new Map<string, Map<string, string>>();
    const repairs = new Map(branches.filter(b => b.sourceRoleRepairs?.length).map(b => [b.id,
        new Set(b.sourceRoleRepairs!.flatMap(pair => [pair.before.revision, pair.after.revision]))]));
    for (const snapshot of snapshots) if (repairs.has(snapshot.branch)) {
        if (!witnesses.has(snapshot.branch)) witnesses.set(snapshot.branch, new Map());
        for (const ref of refs(snapshot)) if (repairs.get(snapshot.branch)!.has(ref.revision) && !witnesses.get(snapshot.branch)!.has(ref.revision))
            witnesses.get(snapshot.branch)!.set(ref.revision, snapshot.id);
    }
    for (const branch of branches) {
        for (const ref of refs(bySnapshot.get(branch.head)!)) bodies.add(ref.revision);
        for (const pair of branch.sourceRoleRepairs ?? []) for (const ref of [pair.before, pair.after]) {
            sources.add(ref.revision);
            const witness = witnesses.get(branch.id)?.get(ref.revision);
            check(witness, '角色修复来源证明缺失'); roots.add(witness);
        }
    }
    const liveBlocks = new Set<string>(), convertedBlocks = new Map<string, string>();
    for (const snapshot of snapshots) {
        if (!roots.has(snapshot.id)) { await plan.delete('history_snapshots', snapshot.id); continue; }
        for (const ref of refs(snapshot)) sources.add(ref.revision);
        if (snapshot.snapshotSchema !== 2) {
            // Retained legacy evidence becomes an independently pinned descriptor.
            // Preserve its identity and exact variants, without its predecessor chain.
            const ids: string[] = []; let offset = 0;
            for (const id of snapshot.blocks) {
                const original = blocks.get(id)!, variants = snapshot.variants?.slice(offset, offset + original.entries.length)
                    ?? Array(original.entries.length).fill(0);
                offset += original.entries.length;
                const key = JSON.stringify([snapshot.branch, id, variants]);
                let converted = convertedBlocks.get(key);
                if (!converted) {
                    const block: Block = { ...row('block'), story: snapshot.story, owner: `current:${snapshot.branch}`, entries: original.entries, variants };
                    await plan.add('manifest_blocks', block); blocks.set(block.id, block); converted = block.id; convertedBlocks.set(key, converted);
                }
                ids.push(converted); liveBlocks.add(converted);
            }
            const { variants: _variants, ...identity } = snapshot;
            await plan.put('history_snapshots', { ...identity, snapshotSchema: 2, owner: `current:${snapshot.branch}`, previous: null, blocks: ids } as Snapshot);
        } else for (const id of snapshot.blocks) liveBlocks.add(id);
    }
    for (const id of blocks.keys()) if (!liveBlocks.has(id)) await plan.delete('manifest_blocks', id);
    for (const body of await plan.rawAll('source_bodies')) if (!bodies.has(body.id)) await plan.delete('source_bodies', body.id);
    const origins = new Set<string>();
    for (const revision of await plan.all<Revision>('source_revisions')) {
        if (!sources.has(revision.id)) { await plan.delete('source_revisions', revision.id); continue; }
        origins.add(revision.provenance.binding);
        if (revision.bodySchema === 1) continue;
        check(typeof revision.content === 'string', '旧正文数据缺失，停止清理');
        const { content, ...identity } = revision;
        const bodyHash = await fingerprint(content), digest = await fingerprint([revision.role, content]);
        check(digest === revision.fingerprint, '旧正文校验失败，停止清理');
        await plan.put('source_revisions', { ...identity, bodySchema: 1, bodyHash, bodyLength: content.length } as Revision);
        if (bodies.has(revision.id)) await plan.put('source_bodies', { id: revision.id, schema: 1, owner: revision.owner,
            story: revision.story, content } as SourceBody);
    }
    const retired = await plan.get<Row>('library_meta', 'retired-source-bindings');
    if (retired) await plan.put('library_meta', { ...retired, value: { version: 1,
        bindings: (retired as any).value.bindings.filter((b: Row) => origins.has(b.id)) } } as Row);
    const identities = new Set((await plan.rawAll('source_revisions')).map(r => r.owner!));
    for (const mapping of await plan.rawAll('message_mappings')) identities.add((mapping as any).message);
    for (const memory of await plan.rawAll('memory_revisions')) if ((memory as any).anchor) identities.add((memory as any).anchor);
    for (const message of await plan.rawAll('source_messages')) if (!identities.has(message.id)) await plan.delete('source_messages', message.id);
}
