import type { Transaction } from './db';
import { rowRetentionRoots } from './retention-roots';
import { sameNarrativeRevision } from './memory-equivalence';
import { row, type Branch, type EventReceipt, type MemoryRevision, type MemoryView, type Review, type EventRevision,
    type Row, type TableCommit, type TableRow, type TableDef, type Membership, type Progress } from './model';

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

/** Storage cleanup is not a new source edit. Keep event prose and its exact
 * provenance, including text already awaiting review. Only demonstrably equivalent
 * prose dependencies can move; associations follow the selected summary family.
 * Runs in the cleanup Worker against its indexed, write-stamped in-memory plan. */
export async function preserveEventReferences(tx: Transaction, branch: Branch,
    selected: ReadonlyMap<string, MemoryRevision>) {
    const known = new Map([...selected.values()].map(m => [m.id, Promise.resolve<MemoryRevision | undefined>(m)]));
    const equivalents = new Map<string, Promise<string>>();
    const memory = (id: string) => {
        if (!known.has(id)) known.set(id, tx.get<MemoryRevision>('memory_revisions', id));
        return known.get(id)!;
    };
    const replacement = async (id: string) => {
        const prior = await memory(id);
        return prior?.branch === branch.id && prior.story === branch.story ? selected.get(prior.owner) : undefined;
    };
    const equivalent = (id: string) => {
        if (!equivalents.has(id)) equivalents.set(id, (async () => {
            const next = await replacement(id);
            return next && (next.id === id || sameNarrativeRevision((await memory(id))!, next)) ? next.id : id;
        })());
        return equivalents.get(id)!;
    };
    const references = async (ids: string[]) => {
        const next = await Promise.all(ids.map(equivalent));
        return next.some((id, i) => id !== ids[i]) ? next : ids;
    };
    let changed = false;
    for (const member of await tx.all<Membership>('event_memberships', 'branch', branch.id)) {
        const next = await replacement(member.memory);
        if (!next || next.id === member.memory) continue;
        // Preserve operation order: moving an old unlink to the current epoch
        // could override a later relink. Cutoffs also govern historical forks.
        await tx.put('event_memberships', { ...member, memory: next.id } as Membership);
        changed = true;
    }
    for (const meta of await tx.all<EventRevision>('event_revisions', 'branch', branch.id)) {
        const refs = await references(meta.refs);
        const summarized = meta.summarized && await references(meta.summarized);
        const latest = meta.latestProgress, id = latest && await equivalent(latest.memory);
        const latestProgress = latest && id !== latest.memory ? { ...latest, memory: id! } : latest;
        if (refs === meta.refs && summarized === meta.summarized && latestProgress === latest) continue;
        await tx.put('event_revisions', { ...meta, refs,
            ...(summarized === undefined ? {} : { summarized }),
            ...(latestProgress === undefined ? {} : { latestProgress }) } as EventRevision);
        changed = true;
    }
    for (const progress of await tx.all<Progress>('event_progress', 'branch', branch.id)) {
        const memories = await references(progress.memories);
        if (memories === progress.memories) continue;
        await tx.put('event_progress', { ...progress, memories } as Progress);
        changed = true;
    }
    return changed;
}

/** A replaced body invalidates its old derived prose, never the event's title,
 * keywords, archive organization or another branch's copy. */
export async function retireEventDependencies(tx: Transaction, branch: Branch, retired: Set<string>, cutoff: number,
    replacements: ReadonlyMap<string, MemoryRevision>, manualReplacements: ReadonlySet<string>) {
    if (!retired.size) return false;
    const families = new Set<string>(), known = new Map<string, MemoryRevision | undefined>();
    const memory = async (id: string) => {
        if (!known.has(id)) known.set(id, await tx.get<MemoryRevision>('memory_revisions', id));
        return known.get(id);
    };
    for (const id of retired) { const prior = await memory(id); if (prior?.branch === branch.id) families.add(prior.owner); }
    const obsolete = new Map<string, boolean>();
    const isObsolete = async (id: string) => {
        if (obsolete.has(id)) return obsolete.get(id)!;
        const source = await memory(id), next = source && replacements.get(source.owner);
        // A historical family member never makes the currently selected version
        // (or an equivalent tag-only revision) obsolete.
        const current = source && next && (source.id === next.id || sameNarrativeRevision(source, next));
        const affected = !current && (retired.has(id) || source?.branch === branch.id && families.has(source.owner));
        obsolete.set(id, affected); return affected;
    };
    const revisions = await tx.all<EventRevision>('event_revisions', 'branch', branch.id);
    const latest = new Map<string, EventRevision>();
    for (const r of revisions) if (!latest.has(r.owner) || latest.get(r.owner)!.epoch <= r.epoch) latest.set(r.owner, r);
    let changed = false;
    for (const store of ['event_revisions', 'event_memberships', 'event_progress', 'event_processing_receipts', 'table_receipts'] as const) {
        const records = store === 'event_revisions' ? revisions : await tx.all<Row>(store, 'branch', branch.id);
        for (const record of records) {
            let affected = false;
            for (const id of rowRetentionRoots(record)?.memoryRoots ?? []) {
                if (await isObsolete(id)) {
                    affected = true; retired.add(id);
                }
            }
            if (!affected) continue;
            if (store === 'event_memberships') {
                const member = record as Membership, prior = await memory(member.memory);
                const replacement = prior && replacements.get(prior.owner);
                // Link operations keep their order and original cutoff across a wording edit.
                // Explicit unlinks also survive regeneration.
                if (replacement && !retired.has(replacement.id) &&
                    (manualReplacements.has(replacement.id) || !member.active && member.locked)) {
                    await tx.put(store, { ...member, memory: replacement.id } as Membership);
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
