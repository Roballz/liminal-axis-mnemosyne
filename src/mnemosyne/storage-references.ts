import { check, type Row, type Store } from './model';
import { SHARED_FIELDS } from './shared-payloads';
import { RETENTION_CONTROL_STORE } from './retention-roots';

export const STORAGE_REFS_READY = 'storage-references-v1';
const PREFIX = 'storage-ref:';
const stores = new Set<Store>(['memory_revisions', 'reviews', 'event_revisions', 'event_progress', 'memory_payloads', 'memory_views', 'memory_selection_nodes']);
export const hasStorageReferences = (store: Store) => stores.has(store);
type Read = <T>(request: IDBRequest<T>) => Promise<T>;
type Key = `memory_payloads:${string}` | `memory_selection_nodes:${string}`;

export function storageReferences(store: Store, value: Row | undefined): Set<Key> {
    const result = new Set<Key>(), row = value as any;
    if (!row) return result;
    for (const field of (SHARED_FIELDS as any)[store] ?? [])
        if (typeof row[field]?.shared === 'string') result.add(`memory_payloads:${row[field].shared}`);
    if (store === 'memory_payloads' && row.kind === 'node')
        for (const id of row.value) result.add(`memory_payloads:${id}`);
    if (store === 'memory_views' && row.selectionSchema === 2 && row.root)
        result.add(`memory_selection_nodes:${row.root}`);
    if (store === 'memory_selection_nodes')
        for (const id of Object.values(row.children)) result.add(`memory_selection_nodes:${id}`);
    return result;
}

/** Derived reference counts, excluded from exports. All changes and reclamation
 * share the publishing IDB transaction; never read all payload text on an edit. */
export class StorageReferences {
    private operations: Promise<{ before: Set<Key>; after: Set<Key> }>[] = [];
    private collecting = false;
    private rebuilt?: Record<Store, Row[]>;
    private ready: Promise<boolean>;
    constructor(private native: IDBTransaction, private read: Read,
        private removed: (store: Store, id: string) => void) {
        this.ready = read<any>(native.objectStore(RETENTION_CONTROL_STORE).get(STORAGE_REFS_READY)).then(row => row?.version === 1);
        void this.ready.catch(() => {});
    }
    record(store: Store, before: Promise<Row | undefined> | undefined, after: Row | undefined, written: Promise<unknown>) {
        const task = Promise.all([before, written]).then(([prior]) => ({ before: storageReferences(store, prior), after: storageReferences(store, after) }));
        void task.catch(() => {}); this.operations.push(task);
    }
    collect() { this.collecting = true; }
    rebuild(data: Record<Store, Row[]>) { this.rebuilt = data; }

    async finish() {
        const operations = await Promise.all(this.operations), control = this.native.objectStore(RETENTION_CONTROL_STORE);
        if (this.rebuilt) {
            const old = await this.read(control.getAllKeys(IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`)));
            for (const key of old) await this.read(control.delete(key));
            const counts = new Map<Key, number>();
            for (const store of stores) for (const row of this.rebuilt[store]) for (const key of storageReferences(store, row))
                counts.set(key, (counts.get(key) ?? 0) + 1);
            for (const [key, count] of counts) await this.read(control.put({ id: PREFIX + key, count }));
            await this.read(control.put({ id: STORAGE_REFS_READY, version: 1 }));
            return;
        }
        if (!await this.ready) return; // Old libraries bootstrap in the explicit/background Worker, once.
        const delta = new Map<Key, number>();
        for (const { before, after } of operations) {
            for (const key of before) if (!after.has(key)) delta.set(key, (delta.get(key) ?? 0) - 1);
            for (const key of after) if (!before.has(key)) delta.set(key, (delta.get(key) ?? 0) + 1);
        }
        const zero: Key[] = [];
        const update = async (key: Key, change: number) => {
            if (!change) return;
            const previous = await this.read<any>(control.get(PREFIX + key)), count = (previous?.count ?? 0) + change;
            check(Number.isSafeInteger(count) && count >= 0, '共享数据引用计数不一致，已撤销本次操作');
            if (count) await this.read(control.put({ id: PREFIX + key, count }));
            else { await this.read(control.delete(PREFIX + key)); zero.push(key); }
        };
        for (const [key, change] of delta) await update(key, change);
        if (!this.collecting) return;
        const removed = new Set<Key>();
        while (zero.length) {
            const key = zero.pop()!;
            if (removed.has(key)) continue;
            const [store, ...parts] = key.split(':'), id = parts.join(':');
            if ((await this.read<any>(control.get(PREFIX + key)))?.count) continue;
            check(this.native.objectStoreNames.contains(store), '回收事务缺少共享数据存储');
            const objectStore = this.native.objectStore(store), row = await this.read<Row | undefined>(objectStore.get(id));
            if (!row) continue;
            await this.read(objectStore.delete(id)); removed.add(key); this.removed(store as Store, id);
            for (const child of storageReferences(store as Store, row)) await update(child, -1);
        }
    }
}
