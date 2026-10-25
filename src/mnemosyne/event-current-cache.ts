import type { Library, Transaction } from './db';
import { sourceNeutralChanges } from './change-journal';
import { equal, type Branch, type CapturedView, type EventChain, type EventRevision, type Membership, type Progress, type MemoryRevision } from './model';
import type { EventView } from './events';

export interface CurrentEventRows {
    revision?: EventRevision;
    /** Latest record of each summary family, including explicit removals. */
    members: Map<string, Membership>;
    progress: Map<string, Progress>;
}
export interface CurrentEventCache {
    branch: Branch;
    snapshot: string;
    selection: string;
    cutoff: number;
    version: number;
    rows: Map<string, CurrentEventRows>;
    families: Map<string, string>;
    chains?: EventChain[];
    projection?: EventView;
}

// One current branch per connection. Historical/cutoff views never enter this cache;
// old event revisions remain solely in IndexedDB and are read on demand.
const cached = new WeakMap<Library, CurrentEventCache>();

function empty(lib: Library, view: CapturedView, branch: Branch): CurrentEventCache {
    return { branch, snapshot: view.snapshot.id, selection: view.selection.id, cutoff: view.cutoff,
        version: lib.changes.version, rows: new Map(), families: new Map() };
}

/** Only committed, fully observed writes can advance a compact current projection.
 * A missed/foreign-connection epoch or source change deliberately takes the cold path.
 * Call within the event read transaction, which includes branches and all event stores. */
export async function currentEventCache(lib: Library, tx: Transaction, view: CapturedView): Promise<CurrentEventCache | undefined> {
    const branch = await tx.get<Branch>('branches', view.branch.id);
    if (!branch || !equal(branch, view.branch)) return undefined;
    const prior = cached.get(lib);
    if (!prior || prior.branch.id !== branch.id || prior.snapshot !== view.snapshot.id ||
        prior.selection !== view.selection.id || prior.cutoff !== view.cutoff ||
        !sourceNeutralChanges(lib.changes, prior.version, prior.branch, branch)) return empty(lib, view, branch);
    const entries = lib.changes.since(prior.version)!;
    const next: CurrentEventCache = { ...prior, branch, version: lib.changes.version,
        rows: new Map(prior.rows), families: new Map(prior.families) };
    const selected = new Map(view.memories.map(memory => [memory.id, memory]));
    const edited = new Set<string>();
    const mutable = (owner: string) => {
        const rows = next.rows.get(owner);
        if (!rows || edited.has(owner)) return rows;
        const copy = { ...rows, members: new Map(rows.members), progress: new Map(rows.progress) };
        next.rows.set(owner, copy); edited.add(owner);
        return copy;
    };
    for (const entry of entries) for (const change of entry.events) {
        if (!change.value) {
            // Deletion can remove a historical row not present in the compact cache.
            // Its former owner is unknown here, so reread instead of guessing.
            if (change.store !== 'event_chains') return empty(lib, view, branch);
            next.rows.delete(change.key); next.projection = undefined;
            continue;
        }
        if (change.value.branch !== branch.id) continue;
        next.projection = undefined;
        if (change.store === 'event_chains') continue; // Always reread lightweight organization flags.
        const owner = change.value.owner;
        if (!owner) return empty(lib, view, branch);
        const rows = mutable(owner);
        if (!rows) continue; // An unobserved/new chain will be read normally below.
        if (change.store === 'event_revisions') {
            const value = change.value as EventRevision, previous = rows.revision;
            if (previous && value.epoch === previous.epoch && value.id !== previous.id) {
                next.rows.delete(owner); // Preserve the database's ordering of unusual same-epoch rows.
            } else if (!previous || value.epoch >= previous.epoch) rows.revision = value;
        } else if (change.store === 'event_memberships') {
            const value = change.value as Membership;
            let family = next.families.get(value.memory) ?? selected.get(value.memory)?.owner;
            if (!family) family = (await tx.get<MemoryRevision>('memory_revisions', value.memory))?.owner;
            if (!family) { next.rows.delete(owner); continue; }
            next.families.set(value.memory, family);
            const previous = rows.members.get(family);
            if (previous && value.epoch === previous.epoch && value.id !== previous.id) next.rows.delete(owner);
            else if (!previous || value.epoch >= previous.epoch) rows.members.set(family, value);
        } else rows.progress.set(change.key, change.value as Progress);
    }
    return next;
}

/** Publishing follows a successful readonly transaction. Aborted writes were never
 * in the journal; a slower old read cannot replace a later committed cache. */
export function publishCurrentEvents(lib: Library, next: CurrentEventCache) {
    const prior = cached.get(lib);
    if (!prior || prior.version <= next.version) cached.set(lib, next);
}

export function sameEventValidity(a: Map<string, unknown>, b: Map<string, unknown>) {
    return a === b || a.size === b.size && [...a].every(([id, status]) => b.get(id) === status);
}
