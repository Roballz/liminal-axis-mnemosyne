import type { Transaction } from './db';
import { rowRetentionRoots } from './retention-roots';
import { row, type Branch, type EventReceipt, type MemoryRevision, type MemoryView, type Review, type EventRevision,
    type Row, type TableCommit, type TableRow, type TableDef, type Membership } from './model';

/** Only superseded selections are candidates. Current selections and real incoming
 * dependencies (including another branch) remain roots. Work is proportional to
 * the replaced versions; shared payload/node deletion uses transaction refcounts. */
export async function retireSupersededSummaries(tx: Transaction, branch: Branch, previous: MemoryView | undefined,
    selected: MemoryView, candidates: Iterable<string> = Object.values(previous?.selections ?? {})) {
    const current = new Set(Object.values(selected.selections));
    const receipts = await tx.all<EventReceipt>('event_processing_receipts', 'branch', branch.id);
    const views = new Set([branch.view]);
    for (const receipt of receipts) {
        // A receipt authorizes only its explicit memory IDs. Unchanged receipts
        // can point to the current selection without pinning unrelated old versions.
        if (receipt.memories.some(id => !current.has(id))) await tx.delete('event_processing_receipts', receipt.id);
        else if (receipt.view !== branch.view)
            await tx.put('event_processing_receipts', { ...receipt, view: branch.view } as EventReceipt);
    }
    for (const view of await tx.rawAll<MemoryView>('memory_views', 'branch', branch.id))
        if (!views.has(view.id)) await tx.delete('memory_views', view.id);
    const pending = new Set([...candidates].filter(id => !current.has(id))), removed = new Set<string>();
    const examined = new Set<string>();
    for (const id of pending) {
        const candidate = await tx.get<MemoryRevision>('memory_revisions', id);
        if (!candidate || candidate.branch !== branch.id || examined.has(candidate.owner)) continue;
        examined.add(candidate.owner);
        // Explicit repair/manual confirmation may have retained an earlier proof
        // before this edit. All superseded versions in the affected family are
        // candidates; real incoming dependencies still protect the ones in use.
        for (const version of await tx.all<MemoryRevision>('memory_revisions', 'owner', candidate.owner))
            if (version.branch === branch.id && !current.has(version.id)) pending.add(version.id);
    }
    let changed = true;
    while (pending.size && changed) {
        changed = false;
        const counts = (await tx.retentionRoots(branch.story)).memoryReferenceCounts;
        // An old connection/test provider without this evidence cannot safely collect.
        if (!counts) break;
        for (const id of pending) {
            const revision = await tx.get<MemoryRevision>('memory_revisions', id);
            if (!revision || revision.branch !== branch.id) { pending.delete(id); continue; }
            const reviews = await tx.all<Review>('reviews', 'owner', id);
            const ownReviews = reviews.filter(r => rowRetentionRoots(r)?.memoryRoots.has(id)).length;
            if ((counts.get(id) ?? 0) > ownReviews) continue;
            for (const review of reviews) await tx.delete('reviews', review.id);
            await tx.delete('memory_revisions', id);
            pending.delete(id); removed.add(id); changed = true;
            for (const dependency of revision.dependencies) if (!current.has(dependency)) pending.add(dependency);
        }
    }
    tx.collectStorageGarbage();
    return removed;
}

/** Discard abandoned table audit branches after source rollback. The adopted
 * ancestry still supports forks at earlier floors; current values stay exact. */
export async function retireAbandonedTableHistory(tx: Transaction, branch: Branch) {
    if (!branch.tableHead) return;
    const history = await tx.all<TableCommit>('table_history', 'branch', branch.id);
    const byId = new Map(history.map(r => [r.id, r])), live = new Set<string>();
    let id: string | null = branch.tableHead;
    while (id && !live.has(id)) { live.add(id); id = byId.get(id)?.parent ?? null; }
    for (const commit of history) {
        if (!live.has(commit.id)) await tx.delete('table_history', commit.id);
        else {
            const emptyPrefix = commit.cutoff === 0 && !commit.defs.length && !commit.rows.length;
            if (commit.previous !== commit.parent || emptyPrefix && commit.snapshot !== branch.head)
                await tx.put('table_history', { ...commit, previous: commit.parent, ...(emptyPrefix ? { snapshot: branch.head } : {}) } as TableCommit);
        }
    }
    const rowRoots = new Set(history.filter(c => live.has(c.id)).flatMap(c => c.rows.map(r => r.id)));
    const defRoots = new Set(history.filter(c => live.has(c.id)).flatMap(c => c.defs.map(r => r.id)));
    for (const record of await tx.all<TableRow>('custom_table_rows', 'branch', branch.id)) {
        if (record.deleted && !rowRoots.has(record.id)) await tx.delete('custom_table_rows', record.id);
        else defRoots.add(record.owner);
    }
    for (const def of await tx.all<TableDef>('custom_table_defs', 'branch', branch.id)) if (def.deleted && !defRoots.has(def.id)) {
        for (const receipt of await tx.all<Row>('table_receipts', 'owner', def.id)) await tx.delete('table_receipts', receipt.id);
        await tx.delete('custom_table_defs', def.id);
    }
}

/** A replaced body invalidates its old derived prose, never the event's title,
 * keywords, archive organization or another branch's copy. */
export async function retireEventDependencies(tx: Transaction, branch: Branch, retired: Set<string>, cutoff: number,
    replacements: ReadonlyMap<string, MemoryRevision> = new Map()) {
    if (!retired.size) return false;
    const families = new Set<string>(), known = new Map<string, MemoryRevision | undefined>();
    const memory = async (id: string) => {
        if (!known.has(id)) known.set(id, await tx.get<MemoryRevision>('memory_revisions', id));
        return known.get(id);
    };
    for (const id of retired) { const prior = await memory(id); if (prior?.branch === branch.id) families.add(prior.owner); }
    const revisions = await tx.all<EventRevision>('event_revisions', 'branch', branch.id);
    const latest = new Map<string, EventRevision>();
    for (const r of revisions) if (!latest.has(r.owner) || latest.get(r.owner)!.epoch <= r.epoch) latest.set(r.owner, r);
    let changed = false;
    for (const store of ['event_revisions', 'event_memberships', 'event_progress', 'event_processing_receipts', 'table_receipts'] as const) {
        const records = store === 'event_revisions' ? revisions : await tx.all<Row>(store, 'branch', branch.id);
        for (const record of records) {
            let affected = false;
            for (const id of rowRetentionRoots(record)?.memoryRoots ?? []) {
                const source = await memory(id);
                if (retired.has(id) || source?.branch === branch.id && families.has(source.owner)) {
                    affected = true; retired.add(id);
                }
            }
            if (!affected) continue;
            if (store === 'event_memberships') {
                const member = record as Membership, prior = await memory(member.memory);
                const replacement = prior && replacements.get(prior.owner);
                // A manual unlink is a current user setting, not historical prose.
                // Carry it onto the replacement without retaining the old summary.
                if (!member.active && member.locked && replacement && !retired.has(replacement.id)) {
                    await tx.put(store, { ...member, memory: replacement.id, snapshot: branch.head,
                        cutoff, epoch: branch.epoch + 1 } as Membership);
                    changed = true; continue;
                }
            }
            await tx.delete(store, record.id); changed = true;
            if (store === 'event_revisions' && latest.get(record.owner!)?.id === record.id) {
                const prior = record as EventRevision;
                const { overviewCoverage, overviewMaterialMode, ...metadata } = prior;
                await tx.add(store, { ...metadata, ...row('er'), eventSchema: 2, overview: '', summarized: [],
                    latestProgress: null, refs: [], snapshot: branch.head, cutoff, epoch: branch.epoch + 1, created: Date.now() } as EventRevision);
            }
        }
    }
    return changed;
}
