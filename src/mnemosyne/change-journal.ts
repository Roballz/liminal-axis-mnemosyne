import { sourceSnapshot, sameSourceSnapshot } from '@/memory/source-snapshot';
import type { Branch, Row, Store } from './model';

export type EventStore = 'event_chains' | 'event_revisions' | 'event_memberships' | 'event_progress';
const eventStores = new Set<Store>(['event_chains', 'event_revisions', 'event_memberships', 'event_progress']);
const tableStores = new Set<Store>(['custom_table_defs', 'custom_table_rows', 'table_receipts', 'table_history']);
const neutralStores = new Set<Store>(['branches', ...eventStores, ...tableStores, 'event_processing_receipts']);
export interface LibraryCommit {
    version: number;
    stores: ReadonlySet<Store>;
    branches: { id: string; before?: Branch; after?: Branch }[];
    events: { store: EventStore; key: string; value?: Row }[];
    complete: boolean;
}

/** Temporary evidence of writes made through one connection, never an archive or
 * a substitute for the database's live branch/CAS check. Aborted writes publish nothing. */
export class TransactionChanges {
    readonly stores = new Set<Store>();
    readonly branches = new Map<string, { id: string; before?: Branch; after?: Branch }>();
    readonly events: LibraryCommit['events'] = [];
    complete = true;
    read(store: Store, value: Row | undefined) {
        if (store === 'branches' && value && !this.branches.has(value.id)) {
            if (this.branches.size >= 128) { this.complete = false; return; }
            this.branches.set(value.id, { id: value.id, before: sourceSnapshot(value) as Branch });
        }
    }
    write(store: Store, key: string, value?: Row) {
        this.stores.add(store);
        if (store === 'branches') {
            if (!this.branches.has(key) && this.branches.size >= 128) { this.complete = false; return; }
            const change = this.branches.get(key) ?? { id: key };
            change.after = value ? sourceSnapshot(value) as Branch : undefined;
            this.branches.set(key, change);
        }
        if (eventStores.has(store)) {
            if (this.events.length >= 128) { this.complete = false; return; }
            this.events.push({ store: store as EventStore, key, ...(value ? { value: sourceSnapshot(value) as Row } : {}) });
        }
    }
}

export class LibraryChanges {
    version = 0;
    private floor = 0;
    private entries: LibraryCommit[] = [];
    private evidenceCount = 0;
    commit(changes: TransactionChanges) {
        if (!changes.stores.size) return;
        const entry: LibraryCommit = { version: ++this.version, stores: changes.stores,
            branches: [...changes.branches.values()].filter(change => change.after || changes.stores.has('branches')),
            events: changes.events, complete: changes.complete };
        this.entries.push(entry);
        this.evidenceCount += entry.events.length + entry.branches.length;
        while (this.entries.length > 64 || this.evidenceCount > 512) {
            const removed = this.entries.shift()!;
            this.floor = removed.version;
            this.evidenceCount -= removed.events.length + removed.branches.length;
        }
    }
    since(version: number): readonly LibraryCommit[] | null {
        if (version < this.floor || version > this.version) return null;
        return this.entries.filter(entry => entry.version > version);
    }
}

/** Only continuous, committed event/table edits can preserve source validity.
 * Missing observations (including another connection) deliberately return null. */
export function sourceNeutralChanges(changes: LibraryChanges, version: number, before: Branch, after: Branch): { events: boolean; tables: boolean } | null {
    const entries = changes.since(version);
    if (!entries) return null;
    let cursor = before, events = false, tables = false;
    for (const entry of entries) {
        if (!entry.complete || [...entry.stores].some(store => !neutralStores.has(store))) return null;
        const transition = entry.branches.find(change => change.id === before.id && change.after);
        if (transition) {
            if (!transition.before || !transition.after || !sameSourceSnapshot(cursor, transition.before)) return null;
            const { epoch: oldEpoch, tableHead: _oldTable, tableHistoryGap: _oldGap, ...oldSource } = transition.before;
            const { epoch: newEpoch, tableHead: _newTable, tableHistoryGap: _newGap, ...newSource } = transition.after;
            if (newEpoch < oldEpoch || !sameSourceSnapshot(oldSource, newSource)) return null;
            tables ||= _oldTable !== _newTable || _oldGap !== _newGap;
            cursor = transition.after;
        }
        events ||= [...entry.stores].some(store => eventStores.has(store) || store === 'event_processing_receipts');
        tables ||= [...entry.stores].some(store => tableStores.has(store));
    }
    return sameSourceSnapshot(cursor, after) ? { events, tables } : null;
}
