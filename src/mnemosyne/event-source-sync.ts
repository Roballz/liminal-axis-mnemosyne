import type { Library, Transaction } from './db';
import { row, type Branch, type MemoryRevision, type Membership, type EventRevision } from './model';

// Derived scan cache only. Durable unlink records use the existing membership log.
// Publish cache entries after commit so a rolled-back transaction is always retried.
const checked = new WeakMap<Library, Map<string, string>>();
const deletionKey = (removed: Set<string>) => JSON.stringify([...removed].sort());
export function eventSourcesChecked(lib: Library, branch: Branch, removed: Set<string>) {
    if (!checked.has(lib)) checked.set(lib, new Map());
    checked.get(lib)!.set(branch.id, deletionKey(removed));
}

/** Reconcile only proven deleted source identities in this branch; never infer deletion from review status. */
export async function unlinkDeletedEventSources(lib: Library, tx: Transaction, branch: Branch, removed: Set<string>, cutoff: number) {
    if (!removed.size) return false;
    if (checked.get(lib)?.get(branch.id) === deletionKey(removed)) return false;
    const memories = new Map<string, MemoryRevision | undefined>();
    const latest = new Map<string, { link: Membership; memory: MemoryRevision }>();
    const links = await tx.all<Membership>('event_memberships', 'branch', branch.id);
    for (const link of links) {
        if (!memories.has(link.memory)) memories.set(link.memory, await tx.get<MemoryRevision>('memory_revisions', link.memory));
        const memory = memories.get(link.memory);
        if (!memory) continue;
        const key = `${link.owner}:${memory.owner}`, prior = latest.get(key);
        if (!prior || prior.link.epoch < link.epoch) latest.set(key, { link, memory });
    }
    const changed = new Set<string>();
    for (const { link, memory } of latest.values()) {
        // A deleted earlier input can invalidate a surviving summary: keep it for review.
        // Auto-unlink only the summary whose own anchor/covered source was deleted.
        const deleted = memory.anchor ? removed.has(memory.anchor) : memory.coverage.some(ref => removed.has(ref.message));
        if (!link.active || !deleted) continue;
        await tx.add('event_memberships', { ...link, ...row('link'), active: false, locked: true, origin: 'manual',
            snapshot: branch.head, cutoff, epoch: branch.epoch + 1 } as Membership);
        changed.add(link.owner);
    }
    for (const event of changed) {
        const revisions = await tx.all<EventRevision>('event_revisions', 'owner', event);
        const meta = revisions.sort((a, b) => b.epoch - a.epoch)[0];
        if (meta) await tx.add('event_revisions', { ...meta, ...row('er'), snapshot: branch.head,
            cutoff, epoch: branch.epoch + 1, created: Date.now() } as EventRevision);
    }
    return changed.size > 0;
}
