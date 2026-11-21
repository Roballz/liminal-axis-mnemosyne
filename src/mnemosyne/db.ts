import { manualPrefixCandidate, matchesStoredPrefix, readStoredPrefix } from './stored-source-prefix';
import { DB_PREFIX, ACTIVE_KEY, assertLibraryEnabled, selectedLibraryName } from './library-policy';
export { DB_PREFIX, ACTIVE_KEY } from './library-policy';
import { SharedPayloads, SHARED_META, SHARED_STORE, sharedStore, sharedRow } from './shared-payloads';
import { STORES, type Store, type Row, check, id } from './model';
import { readDailySettings, settings } from './event-settings';
import { LibraryChanges, TransactionChanges } from './change-journal';
import { materializeMemoryView } from './memory-selections';
import type { Block, CompactMemoryView, MemoryRevision, MemoryView, MemorySelectionNode, Snapshot } from './model';
import { isEvidenceStore, rowRetentionRoots, RetentionRootsCache, RetentionTransaction, RETENTION_CONTROL_STORE } from './retention-roots';
import { hasStorageReferences, StorageReferences, STORAGE_REFS_READY } from './storage-references';
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
        if (store !== 'memory_selection_nodes' && store !== 'manifest_blocks' && store !== 'history_snapshots') return undefined;
        let cache = this.immutableRows.get(store);
        if (!cache) { cache = new Map(); this.immutableRows.set(store, cache); }
        return cache;
    }
    constructor(readonly native: IDBTransaction, private readonly changes?: TransactionChanges,
        private readonly retention?: RetentionTransaction, private readonly compactWrites = false,
        private readonly initialWriteStamp?: Promise<number>, private readonly storageRefs?: StorageReferences,
        private readonly preservePhysicalWrites = false) { }
    collectStorageGarbage() { this.storageRefs?.collect(); }
    rebuildStorageReferences(data: Record<Store, Row[]>) { this.storageRefs?.rebuild(data); }
    async assertWriteStamp(expected: number) {
        check(this.initialWriteStamp && await this.initialWriteStamp === expected, '资料已改变，本次操作已撤销，请重试');
    }
    private payloads = new SharedPayloads(key => this.rawGet(SHARED_STORE, key), row => this.addStored(SHARED_STORE, row), undefined,
        async memory => readStoredPrefix(memory, await this.rawGet<Snapshot>('history_snapshots', memory.basis), id => this.rawGet<Block>('manifest_blocks', id)));
    private packedWrites: Promise<unknown> = Promise.resolve();
    private packWrite(store: Store, value: Row, put: boolean): Promise<IDBValidKey> {
        // Preserve native structured-clone semantics while all shared-store
        // operations (including uncompressed legacy rows) use one ordered queue.
        const row = structuredClone(value);
        const compact = this.compactWrites || !this.preservePhysicalWrites &&
            (store === 'event_revisions' || store === 'event_progress');
        const operation = this.packedWrites.then(async () => {
            const logical = sharedRow(row) ? await this.payloads.unpack(store, row) : row;
            const memory = row as MemoryRevision;
            const prefix = compact && store === 'memory_revisions' && !sharedRow(row) && manualPrefixCandidate(memory) &&
                await matchesStoredPrefix(memory, await this.rawGet<Snapshot>('history_snapshots', memory.basis), id => this.rawGet<Block>('manifest_blocks', id));
            const packed = compact && !sharedRow(row) ? await this.payloads.pack(store, row, prefix) : row;
            return put ? this.putStored(store, packed, logical) : this.addStored(store, packed, logical);
        });
        this.packedWrites = operation;
        void operation.catch(() => {});
        return operation;
    }
    flushWrites() { return this.packedWrites; }
    async flushEvidenceReads() { await this.packedWrites; await this.retention?.flush(); }
    /** Old packed evidence may still be decoding its payloads or snapshot blocks. */
    async deleteArchiveRows(rows: Iterable<readonly [Store, string]>) {
        const deferred: [Store, string][] = [];
        for (const [store, id] of rows) {
            if (store === 'memory_payloads' || store === 'history_snapshots' || store === 'manifest_blocks') deferred.push([store, id]);
            else await this.delete(store, id);
        }
        await this.flushEvidenceReads();
        for (const [store, id] of deferred) await this.delete(store, id);
    }
    get sharedWrites() { return this.compactWrites; }
    async retentionRoots(story: string, refresh = false) {
        check(this.retention, '当前事务未包含历史证据存储');
        await this.packedWrites;
        return this.retention.roots(story, refresh, async (store, mark) => {
            if (sharedStore(store)) await this.packedWrites;
            // Mark the actual native read boundary, after any queued packing.
            mark();
            const rows = await this.rawAll<Row>(store, 'story', story);
            return sharedStore(store) ? Promise.all(rows.map(row => this.payloads.unpack(store, row))) : rows;
        });
    }
    get<T extends Row>(store: Store, key: string): Promise<T | undefined> {
        if (store === 'memory_views') return this.rawGet<MemoryView | CompactMemoryView>(store, key).then(value =>
            value ? materializeMemoryView(value, id => this.rawGet<MemorySelectionNode>('memory_selection_nodes', id)) as Promise<unknown> as Promise<T> : undefined);
        if (!sharedStore(store)) return this.rawGet<T>(store, key);
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
        if (!sharedStore(store)) return this.rawAll<T>(store, index, key);
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
        return sharedStore(store) ? this.packWrite(store, value, true) : this.putStored(store, value);
    }
    private putStored(store: Store, value: Row, logical = value): Promise<IDBValidKey> {
        this.immutableRows.get(store)?.delete(value.id);
        const objectStore = this.native.objectStore(store), evidence = isEvidenceStore(store);
        if (evidence) { check(this.retention, '证据写入缺少事务标记'); this.retention.assertWritable(); }
        const after = evidence ? rowRetentionRoots(logical) : undefined;
        const physicalBefore = evidence || hasStorageReferences(store) ? request<Row | undefined>(objectStore.get(value.id)) : undefined;
        void physicalBefore?.catch(() => {});
        const before = evidence ? physicalBefore!.then(row => row && sharedRow(row) ? this.payloads.unpack(store, row).then(rowRetentionRoots) : rowRetentionRoots(row)) : undefined;
        // A synchronous DataCloneError below can abort this already-enqueued read
        // before record() is reached. Observe it without hiding ledger failures.
        void before?.catch(() => {});
        // Keep old get and write adjacent in the native request queue. Awaiting
        // the old value here would reorder consecutive put/delete/add calls.
        const write = objectStore.put(value);
        this.changes?.write(store, value.id, logical);
        const pending = request(write);
        if (evidence) this.retention!.record(store, before, after, pending);
        if (hasStorageReferences(store)) this.storageRefs?.record(store, physicalBefore, value, pending);
        return pending;
    }
    delete(store: Store, key: string): Promise<undefined> {
        if (sharedStore(store)) {
            const operation = this.packedWrites.then(() => this.deleteStored(store, key));
            this.packedWrites = operation; void operation.catch(() => {}); return operation;
        }
        return this.deleteStored(store, key);
    }
    private deleteStored(store: Store, key: string): Promise<undefined> {
        this.immutableRows.get(store)?.delete(key);
        const objectStore = this.native.objectStore(store), evidence = isEvidenceStore(store);
        if (evidence) { check(this.retention, '证据写入缺少事务标记'); this.retention.assertWritable(); }
        const physicalBefore = evidence || hasStorageReferences(store) ? request<Row | undefined>(objectStore.get(key)) : undefined;
        void physicalBefore?.catch(() => {});
        const before = evidence ? physicalBefore!.then(row => row && sharedRow(row) ? this.payloads.unpack(store, row).then(rowRetentionRoots) : rowRetentionRoots(row)) : undefined;
        void before?.catch(() => {});
        const write = objectStore.delete(key);
        this.changes?.write(store, key);
        const pending = request(write);
        if (evidence) this.retention!.record(store, before, undefined, pending);
        if (hasStorageReferences(store)) this.storageRefs?.record(store, physicalBefore, undefined, pending);
        return pending;
    }
    add(store: Store, value: Row): Promise<IDBValidKey> {
        return sharedStore(store) ? this.packWrite(store, value, false) : this.addStored(store, value);
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
        if (hasStorageReferences(store)) this.storageRefs?.record(store, undefined, value, pending);
        return pending;
    }
}
export class Library {
    readonly changes = new LibraryChanges();
    private readonly retentionRoots = new RetentionRootsCache();
    compactWrites = false;
    preservePhysicalWrites = false;
    private constructor(readonly db: IDBDatabase) { }
    static open(name = `${DB_PREFIX}default`, existingOnly = false): Promise<Library> {
        check(name.startsWith(DB_PREFIX), '不是 Mnemosyne 库');
        return new Promise((resolve, reject) => {
            const r = indexedDB.open(name, DB_VERSION);
            let cancelled = false;
            r.onupgradeneeded = (event) => {
                // Backup workers must never create an empty database or migrate a live one.
                if (existingOnly || cancelled) { r.transaction!.abort(); return; }
                if (!r.result.objectStoreNames.contains(RETENTION_CONTROL_STORE))
                    r.result.createObjectStore(RETENTION_CONTROL_STORE, { keyPath: 'id' });
                if (event.oldVersion === 0) r.transaction!.objectStore(RETENTION_CONTROL_STORE).put({ id: STORAGE_REFS_READY, version: 1 });
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
        if (mode === 'readwrite') {
            assertLibraryEnabled(this.db.name);
            if (typeof localStorage !== 'undefined' && activeName === this.db.name)
                check(selectedLibraryName() === this.db.name, '活动库已在其他页面切换，已停止向旧库写入');
        }
        const evidence = stores.some(isEvidenceStore);
        const included = [...new Set([...stores, ...(stores.includes('memory_views') ? ['memory_selection_nodes'] : []),
            ...(stores.some(sharedStore) ? [SHARED_STORE] : []),
            ...(stores.includes('memory_revisions') ? ['history_snapshots', 'manifest_blocks'] : []), RETENTION_CONTROL_STORE])];
        const native = this.db.transaction(included, mode);
        // A durable write stamp covers every store and every Library connection.
        // Reorganization checks it between pages and in the final activation barrier.
        const stamped = mode === 'readwrite' ? request<any>(native.objectStore(RETENTION_CONTROL_STORE).get('library-writes')).then(row => {
            const stamp = row?.stamp ?? 0;
            check(Number.isSafeInteger(stamp) && stamp < Number.MAX_SAFE_INTEGER, '库写入标记非法');
            return request(native.objectStore(RETENTION_CONTROL_STORE).put({ id: 'library-writes', stamp: stamp + 1 })).then(() => stamp);
        }) : undefined;
        void stamped?.catch(() => {});
        const changes = mode === 'readwrite' ? new TransactionChanges() : undefined;
        const storageRefs = mode === 'readwrite' && stores.some(hasStorageReferences)
            ? new StorageReferences(native, request, (store, id) => changes?.write(store, id)) : undefined;
        const retention = evidence ? new RetentionTransaction(native, this.retentionRoots, request) : undefined;
        const done = new Promise<void>((resolve, reject) => {
            native.oncomplete = () => resolve();
            native.onabort = () => reject(native.error ?? new Error('事务已撤销'));
            native.onerror = () => { }; // onabort is authoritative
        });
        // Network, hashing and timers must never run inside fn.
        try {
            const tx = new Transaction(native, changes, retention, this.compactWrites, stamped, storageRefs, this.preservePhysicalWrites);
            const result = await fn(tx);
            await tx.flushWrites();
            await retention?.prepare();
            await storageRefs?.finish();
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
let activeName: string | undefined;
let activationGeneration = 0;
/** Synchronous token: checking it must not yield to another activation. */
export const libraryActivationGeneration = () => activationGeneration;
export function activeLibrary(): Promise<Library> {
    const selected = selectedLibraryName();
    assertLibraryEnabled(selected);
    check(!active || activeName === selected, '活动库已在其他页面切换，请重新加载插件；已停止使用旧连接');
    if (!active) { activeName = selected; active = Library.open(selected); }
    return active;
}
export async function activateLibrary(lib: Library, isCurrent = () => true, barrier?: (publish: () => void) => Promise<void>) {
    assertLibraryEnabled(lib.db.name);
    const restoredSettings = await readDailySettings(lib);
    check(isCurrent(), '恢复页面已改变，已验证的新库未启用，原库保留');
    // Durable selector changes only after validation and import transaction completion.
    const previous = active;
    const publish = () => {
        check(isCurrent(), '档案已改变，新库未启用，原库保留');
        assertLibraryEnabled(lib.db.name);
        localStorage.setItem(ACTIVE_KEY, lib.db.name);
        activeName = lib.db.name;
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
