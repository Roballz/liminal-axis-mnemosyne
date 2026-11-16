import { SharedPayloads, SHARED_META, SHARED_STORE, sharedStore, sharedRow } from './shared-payloads';
import { STORES, type Store, type Row, check, id } from './model';
import { readDailySettings, settings } from './event-settings';
import { LibraryChanges, TransactionChanges } from './change-journal';
import { materializeMemoryView } from './memory-selections';
import type { CompactMemoryView, MemoryView, MemorySelectionNode } from './model';
import { isEvidenceStore, rowRetentionRoots, RetentionRootsCache, RetentionTransaction, RETENTION_CONTROL_STORE } from './retention-roots';
export const DB_PREFIX = 'mnemosyne_daily_';
export const ACTIVE_KEY = 'mnemosyne_daily_active_v1';
export const DB_VERSION = 6;
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
        private readonly retention?: RetentionTransaction, private readonly compactWrites = false) { }
    private payloads = new SharedPayloads(key => this.rawGet(SHARED_STORE, key), row => this.addStored(SHARED_STORE, row));
    private packedWrites: Promise<unknown> = Promise.resolve();
    private packWrite(store: Store, row: Row, put: boolean): Promise<IDBValidKey> {
        const operation = this.packedWrites.then(async () => {
            const logical = sharedRow(row) ? await this.payloads.unpack(store, row) : row;
            const packed = sharedRow(row) ? row : await this.payloads.pack(store, row);
            return put ? this.putStored(store, packed, logical) : this.addStored(store, packed, logical);
        });
        this.packedWrites = operation;
        void operation.catch(() => {});
        return operation;
    }
    flushWrites() { return this.packedWrites; }
    async flushEvidenceReads() { await this.packedWrites; await this.retention?.flush(); }
    get sharedWrites() { return this.compactWrites; }
    retentionRoots(story: string, refresh = false) {
        check(this.retention, '当前事务未包含历史证据存储');
        return this.retention.roots(story, refresh, store => this.all<Row>(store, 'story', story));
    }
    get<T extends Row>(store: Store, key: string): Promise<T | undefined> {
        if (store === 'memory_views') return this.rawGet<MemoryView | CompactMemoryView>(store, key).then(value =>
            value ? materializeMemoryView(value, id => this.rawGet<MemorySelectionNode>('memory_selection_nodes', id)) as Promise<unknown> as Promise<T> : undefined);
        if (!this.compactWrites || !sharedStore(store)) return this.rawGet<T>(store, key);
        const read = () => this.rawGet<T>(store, key).then(row => row && sharedStore(store) ? this.payloads.unpack(store, row) as Promise<T> : row);
        return sharedStore(store) ? this.packedWrites.then(read) : read();
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
        if (!this.compactWrites || !sharedStore(store)) return this.rawAll<T>(store, index, key);
        const read = () => this.rawAll<T>(store, index, key).then(async rows => {
            if (!sharedStore(store)) return rows;
            const result: T[] = [];
            for (const row of rows) result.push(await this.payloads.unpack(store, row) as T);
            return result;
        });
        return sharedStore(store) ? this.packedWrites.then(read) : read();
    }
    rawAll<T extends Row>(store: Store, index?: StoreIndex, key?: IDBValidKey): Promise<T[]> {
        const s = this.native.objectStore(store);
        return request<T[]>(index ? s.index(index).getAll(key) : s.getAll()).then(values => {
            if (store === 'branches') for (const value of values) this.changes?.read(store, value);
            return values;
        });
    }
    put(store: Store, value: Row): Promise<IDBValidKey> {
        return (this.compactWrites || sharedRow(value)) && sharedStore(store) ? this.packWrite(store, value, true) : this.putStored(store, value);
    }
    private putStored(store: Store, value: Row, logical = value): Promise<IDBValidKey> {
        this.immutableRows.get(store)?.delete(value.id);
        const objectStore = this.native.objectStore(store), evidence = isEvidenceStore(store);
        if (evidence) { check(this.retention, '证据写入缺少事务标记'); this.retention.assertWritable(); }
        const after = evidence ? rowRetentionRoots(logical) : undefined;
        const before = evidence ? request<Row | undefined>(objectStore.get(value.id)).then(row => row && sharedRow(row) ? this.payloads.unpack(store, row).then(rowRetentionRoots) : rowRetentionRoots(row)) : undefined;
        // A synchronous DataCloneError below can abort this already-enqueued read
        // before record() is reached. Observe it without hiding ledger failures.
        void before?.catch(() => {});
        // Keep old get and write adjacent in the native request queue. Awaiting
        // the old value here would reorder consecutive put/delete/add calls.
        const write = objectStore.put(value);
        this.changes?.write(store, value.id, logical);
        const pending = request(write);
        if (evidence) this.retention!.record(store, before, after, pending);
        return pending;
    }
    delete(store: Store, key: string): Promise<undefined> {
        if (this.compactWrites && sharedStore(store)) {
            const operation = this.packedWrites.then(() => this.deleteStored(store, key));
            this.packedWrites = operation; void operation.catch(() => {}); return operation;
        }
        return this.deleteStored(store, key);
    }
    private deleteStored(store: Store, key: string): Promise<undefined> {
        this.immutableRows.get(store)?.delete(key);
        const objectStore = this.native.objectStore(store), evidence = isEvidenceStore(store);
        if (evidence) { check(this.retention, '证据写入缺少事务标记'); this.retention.assertWritable(); }
        const before = evidence ? request<Row | undefined>(objectStore.get(key)).then(row => row && sharedRow(row) ? this.payloads.unpack(store, row).then(rowRetentionRoots) : rowRetentionRoots(row)) : undefined;
        void before?.catch(() => {});
        const write = objectStore.delete(key);
        this.changes?.write(store, key);
        const pending = request(write);
        if (evidence) this.retention!.record(store, before, undefined, pending);
        return pending;
    }
    add(store: Store, value: Row): Promise<IDBValidKey> {
        return (this.compactWrites || sharedRow(value)) && sharedStore(store) ? this.packWrite(store, value, false) : this.addStored(store, value);
    }
    private addStored(store: Store, value: Row, logical = value): Promise<IDBValidKey> {
        this.immutableRows.get(store)?.delete(value.id);
        const objectStore = this.native.objectStore(store), evidence = isEvidenceStore(store);
        if (evidence) { check(this.retention, '证据写入缺少事务标记'); this.retention.assertWritable(); }
        const after = evidence ? rowRetentionRoots(logical) : undefined;
        const write = objectStore.add(value);
        this.changes?.write(store, value.id, logical);
        const pending = request(write);
        if (evidence) this.retention!.record(store, undefined, after, pending);
        return pending;
    }
}
export class Library {
    readonly changes = new LibraryChanges();
    private readonly retentionRoots = new RetentionRootsCache();
    compactWrites = false;
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
            r.onsuccess = async () => {
                if (cancelled) { r.result.close(); return; }
                r.result.onversionchange = () => r.result.close();
                const lib = new Library(r.result);
                try {
                    lib.compactWrites = !!await lib.get('library_meta', SHARED_META);
                    resolve(lib);
                } catch (error) { lib.close(); reject(error); }
            };
        });
    }
    async transaction<T>(stores: readonly Store[], mode: IDBTransactionMode, fn: (tx: Transaction) => Promise<T>): Promise<T> {
        const evidence = stores.some(isEvidenceStore);
        const included = [...new Set([...stores, ...(stores.includes('memory_views') ? ['memory_selection_nodes'] : []),
            ...(stores.some(sharedStore) ? [SHARED_STORE] : []), RETENTION_CONTROL_STORE])];
        const native = this.db.transaction(included, mode);
        // A durable write stamp covers every store and every Library connection.
        // Reorganization checks it between pages and in the final activation barrier.
        const stamped = mode === 'readwrite' ? request<any>(native.objectStore(RETENTION_CONTROL_STORE).get('library-writes')).then(row => {
            const stamp = row?.stamp ?? 0;
            check(Number.isSafeInteger(stamp) && stamp < Number.MAX_SAFE_INTEGER, '库写入标记非法');
            return request(native.objectStore(RETENTION_CONTROL_STORE).put({ id: 'library-writes', stamp: stamp + 1 }));
        }) : undefined;
        void stamped?.catch(() => {});
        const changes = mode === 'readwrite' ? new TransactionChanges() : undefined;
        const retention = evidence ? new RetentionTransaction(native, this.retentionRoots, request) : undefined;
        const done = new Promise<void>((resolve, reject) => {
            native.oncomplete = () => resolve();
            native.onabort = () => reject(native.error ?? new Error('事务已撤销'));
            native.onerror = () => { }; // onabort is authoritative
        });
        // Network, hashing and timers must never run inside fn.
        try {
            const tx = new Transaction(native, changes, retention, this.compactWrites);
            const result = await fn(tx);
            await tx.flushWrites();
            await retention?.prepare();
            await stamped;
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
export async function activateLibrary(lib: Library, isCurrent = () => true, barrier?: (publish: () => void) => Promise<void>) {
    const restoredSettings = await readDailySettings(lib);
    check(isCurrent(), '恢复页面已改变，已验证的新库未启用，原库保留');
    // Durable selector changes only after validation and import transaction completion.
    const previous = active;
    const publish = () => {
        check(isCurrent(), '档案已改变，新库未启用，原库保留');
        localStorage.setItem(ACTIVE_KEY, lib.db.name);
        active = Promise.resolve(lib);
        activationGeneration++;
        Object.assign(settings, restoredSettings);
    };
    if (barrier) await barrier(publish); else publish();
    // The validated selector switch is already committed. A failed old open (or
    // obsolete-connection cleanup) must not make restore close the new active library.
    if (previous) await previous.then(old => { if (old !== lib) old.close(); }).catch(() => {});
}
export const freshLibraryName = () => `${DB_PREFIX}${id('lib')}`;

/** Include the coordination store even when no archive stores are requested. */
export async function libraryWriteStamp(lib: Library): Promise<number> {
    return lib.transaction([], 'readonly', async tx =>
        (await request<any>(tx.native.objectStore(RETENTION_CONTROL_STORE).get('library-writes')))?.stamp ?? 0);
}
export async function publishUnchangedLibrary(source: Library, stamp: number, publish: () => void) {
    return source.transaction([], 'readonly', async tx => {
        const current = (await request<any>(tx.native.objectStore(RETENTION_CONTROL_STORE).get('library-writes')))?.stamp ?? 0;
        check(current === stamp, '整理期间资料已改变，新库未启用，请重试；原库保留');
        // Synchronous publication while the read transaction blocks every writer.
        publish();
    });
}
