import { STORES, type Store, type Row, check, id } from './model';
import { readDailySettings, settings } from './event-settings';
import { LibraryChanges, TransactionChanges } from './change-journal';
import { materializeMemoryView } from './memory-selections';
import type { CompactMemoryView, MemoryView, MemorySelectionNode } from './model';
import { isEvidenceStore, rowRetentionRoots, RetentionRootsCache, RetentionTransaction, RETENTION_CONTROL_STORE } from './retention-roots';
export const DB_PREFIX = 'mnemosyne_daily_';
export const ACTIVE_KEY = 'mnemosyne_daily_active_v1';
export const DB_VERSION = 5;
export type StoreIndex = 'story' | 'branch' | 'owner' | 'branch_host';
export function request<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
export class Transaction {
    // Immutable projections share reads only inside this IndexedDB snapshot.
    // Explicit writes invalidate the key, including maintenance/import operations.
    private readonly immutableRows = new Map<Store, Map<string, Promise<Row | undefined>>>();
    private readCache(store: Store) {
        if (store !== 'memory_selection_nodes' && store !== 'manifest_blocks') return undefined;
        let cache = this.immutableRows.get(store);
        if (!cache) { cache = new Map(); this.immutableRows.set(store, cache); }
        return cache;
    }
    constructor(readonly native: IDBTransaction, private readonly changes?: TransactionChanges,
        private readonly retention?: RetentionTransaction) { }
    retentionRoots(story: string, refresh = false) {
        check(this.retention, '当前事务未包含历史证据存储');
        return this.retention.roots(story, refresh, store => this.all<Row>(store, 'story', story));
    }
    get<T extends Row>(store: Store, key: string): Promise<T | undefined> {
        if (store === 'memory_views') return this.rawGet<MemoryView | CompactMemoryView>(store, key).then(value =>
            value ? materializeMemoryView(value, id => this.rawGet<MemorySelectionNode>('memory_selection_nodes', id)) as Promise<unknown> as Promise<T> : undefined);
        return this.rawGet<T>(store, key);
    }
    rawGet<T extends Row>(store: Store, key: string): Promise<T | undefined> {
        const cache = this.readCache(store), cached = cache?.get(key);
        if (cached) return cached as Promise<T | undefined>;
        const pending = request<T | undefined>(this.native.objectStore(store).get(key)).then(value => {
            this.changes?.read(store, value);
            return value;
        });
        cache?.set(key, pending);
        return pending;
    }
    all<T extends Row>(store: Store, index?: StoreIndex, key?: IDBValidKey): Promise<T[]> {
        if (store === 'memory_views') return this.rawAll<MemoryView | CompactMemoryView>(store, index, key).then(values =>
            Promise.all(values.map(value => materializeMemoryView(value,
                id => this.rawGet<MemorySelectionNode>('memory_selection_nodes', id)))) as Promise<unknown> as Promise<T[]>);
        return this.rawAll<T>(store, index, key);
    }
    rawAll<T extends Row>(store: Store, index?: StoreIndex, key?: IDBValidKey): Promise<T[]> {
        const s = this.native.objectStore(store);
        return request<T[]>(index ? s.index(index).getAll(key) : s.getAll()).then(values => {
            if (store === 'branches') for (const value of values) this.changes?.read(store, value);
            return values;
        });
    }
    put(store: Store, value: Row): Promise<IDBValidKey> {
        this.immutableRows.get(store)?.delete(value.id);
        const objectStore = this.native.objectStore(store), evidence = isEvidenceStore(store);
        if (evidence) { check(this.retention, '证据写入缺少事务标记'); this.retention.assertWritable(); }
        const after = evidence ? rowRetentionRoots(value) : undefined;
        const before = evidence ? request<Row | undefined>(objectStore.get(value.id)).then(rowRetentionRoots) : undefined;
        // A synchronous DataCloneError below can abort this already-enqueued read
        // before record() is reached. Observe it without hiding ledger failures.
        void before?.catch(() => {});
        // Keep old get and write adjacent in the native request queue. Awaiting
        // the old value here would reorder consecutive put/delete/add calls.
        const write = objectStore.put(value);
        this.changes?.write(store, value.id, value);
        const pending = request(write);
        if (evidence) this.retention!.record(store, before, after, pending);
        return pending;
    }
    delete(store: Store, key: string): Promise<undefined> {
        this.immutableRows.get(store)?.delete(key);
        const objectStore = this.native.objectStore(store), evidence = isEvidenceStore(store);
        if (evidence) { check(this.retention, '证据写入缺少事务标记'); this.retention.assertWritable(); }
        const before = evidence ? request<Row | undefined>(objectStore.get(key)).then(rowRetentionRoots) : undefined;
        void before?.catch(() => {});
        const write = objectStore.delete(key);
        this.changes?.write(store, key);
        const pending = request(write);
        if (evidence) this.retention!.record(store, before, undefined, pending);
        return pending;
    }
    add(store: Store, value: Row): Promise<IDBValidKey> {
        this.immutableRows.get(store)?.delete(value.id);
        const objectStore = this.native.objectStore(store), evidence = isEvidenceStore(store);
        if (evidence) { check(this.retention, '证据写入缺少事务标记'); this.retention.assertWritable(); }
        const after = evidence ? rowRetentionRoots(value) : undefined;
        const write = objectStore.add(value);
        this.changes?.write(store, value.id, value);
        const pending = request(write);
        if (evidence) this.retention!.record(store, undefined, after, pending);
        return pending;
    }
}
export class Library {
    readonly changes = new LibraryChanges();
    private readonly retentionRoots = new RetentionRootsCache();
    private constructor(readonly db: IDBDatabase) { }
    static open(name = `${DB_PREFIX}default`, existingOnly = false): Promise<Library> {
        check(name.startsWith(DB_PREFIX), '不是 Mnemosyne 库');
        return new Promise((resolve, reject) => {
            const r = indexedDB.open(name, DB_VERSION);
            let cancelled = false;
            r.onupgradeneeded = () => {
                // Backup workers must never create an empty database or migrate a live one.
                if (existingOnly || cancelled) { r.transaction!.abort(); return; }
                if (!r.result.objectStoreNames.contains(RETENTION_CONTROL_STORE))
                    r.result.createObjectStore(RETENTION_CONTROL_STORE, { keyPath: 'id' });
                for (const name of STORES) {
                    if (r.result.objectStoreNames.contains(name)) continue;
                    const s = r.result.createObjectStore(name, { keyPath: 'id' });
                    for (const key of ['story', 'branch', 'owner'])
                        s.createIndex(key, key);
                }
                const revisions = r.transaction!.objectStore('memory_revisions');
                if (!revisions.indexNames.contains('branch_host'))
                    revisions.createIndex('branch_host', ['branch', 'hostId']);
            };
            r.onerror = () => reject(r.error);
            r.onblocked = () => { cancelled = true; reject(new Error('数据库升级被另一个标签页阻塞，请关闭旧标签页')); };
            r.onsuccess = () => {
                if (cancelled) { r.result.close(); return; }
                r.result.onversionchange = () => r.result.close();
                resolve(new Library(r.result));
            };
        });
    }
    async transaction<T>(stores: readonly Store[], mode: IDBTransactionMode, fn: (tx: Transaction) => Promise<T>): Promise<T> {
        const evidence = stores.some(isEvidenceStore);
        const included = [...new Set([...stores, ...(stores.includes('memory_views') ? ['memory_selection_nodes'] : []),
            ...(evidence ? [RETENTION_CONTROL_STORE] : [])])];
        const native = this.db.transaction(included, mode);
        const changes = mode === 'readwrite' ? new TransactionChanges() : undefined;
        const retention = evidence ? new RetentionTransaction(native, this.retentionRoots, request) : undefined;
        const done = new Promise<void>((resolve, reject) => {
            native.oncomplete = () => resolve();
            native.onabort = () => reject(native.error ?? new Error('事务已撤销'));
            native.onerror = () => { }; // onabort is authoritative
        });
        // Network, hashing and timers must never run inside fn.
        try {
            const result = await fn(new Transaction(native, changes, retention));
            await retention?.prepare();
            await done;
            retention?.publish();
            if (changes) this.changes.commit(changes);
            return result;
        }
        catch (error) {
            try {
                native.abort();
            }
            catch { }
            await done.catch(() => { });
            throw error;
        }
    }
    get<T extends Row>(store: Store, key: string) { return this.transaction([store], 'readonly', tx => tx.get<T>(store, key)); }
    all<T extends Row>(store: Store, index?: StoreIndex, key?: IDBValidKey) {
        return this.transaction([store], 'readonly', tx => tx.all<T>(store, index, key));
    }
    close() { this.db.close(); }
}
let active: Promise<Library> | undefined;
let activationGeneration = 0;
/** Synchronous token: checking it must not yield to another activation. */
export const libraryActivationGeneration = () => activationGeneration;
export function activeLibrary(): Promise<Library> {
    return active ??= Library.open(localStorage.getItem(ACTIVE_KEY) || `${DB_PREFIX}default`);
}
export async function activateLibrary(lib: Library, isCurrent = () => true) {
    const restoredSettings = await readDailySettings(lib);
    check(isCurrent(), '恢复页面已改变，已验证的新库未启用，原库保留');
    // Durable selector changes only after validation and import transaction completion.
    localStorage.setItem(ACTIVE_KEY, lib.db.name);
    const previous = active;
    active = Promise.resolve(lib);
    activationGeneration++;
    // Publish this library's settings before any post-restore sync or jobs can resume.
    Object.assign(settings, restoredSettings);
    // The validated selector switch is already committed. A failed old open (or
    // obsolete-connection cleanup) must not make restore close the new active library.
    if (previous) await previous.then(old => { if (old !== lib) old.close(); }).catch(() => {});
}
export const freshLibraryName = () => `${DB_PREFIX}${id('lib')}`;
