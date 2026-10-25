import { STORES, type Store, type Row, check, id } from './model';
import { readDailySettings, settings } from './event-settings';
import { LibraryChanges, TransactionChanges } from './change-journal';
import { materializeMemoryView } from './memory-selections';
import type { CompactMemoryView, MemoryView, MemorySelectionNode } from './model';
export const DB_PREFIX = 'mnemosyne_daily_';
export const ACTIVE_KEY = 'mnemosyne_daily_active_v1';
export const DB_VERSION = 4;
export type StoreIndex = 'story' | 'branch' | 'owner' | 'branch_host';
export function request<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
export class Transaction {
    private readonly selectionNodes = new Map<string, Promise<Row | undefined>>();
    constructor(readonly native: IDBTransaction, private readonly changes?: TransactionChanges) { }
    get<T extends Row>(store: Store, key: string): Promise<T | undefined> {
        if (store === 'memory_views') return this.rawGet<MemoryView | CompactMemoryView>(store, key).then(value =>
            value ? materializeMemoryView(value, id => this.rawGet<MemorySelectionNode>('memory_selection_nodes', id)) as Promise<unknown> as Promise<T> : undefined);
        return this.rawGet<T>(store, key);
    }
    rawGet<T extends Row>(store: Store, key: string): Promise<T | undefined> {
        const cached = store === 'memory_selection_nodes' ? this.selectionNodes.get(key) : undefined;
        if (cached) return cached as Promise<T | undefined>;
        const pending = request<T | undefined>(this.native.objectStore(store).get(key)).then(value => {
            this.changes?.read(store, value);
            return value;
        });
        if (store === 'memory_selection_nodes') this.selectionNodes.set(key, pending);
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
        if (store === 'memory_selection_nodes') this.selectionNodes.delete(value.id);
        const pending = this.native.objectStore(store).put(value);
        this.changes?.write(store, value.id, value);
        return request(pending);
    }
    delete(store: Store, key: string): Promise<undefined> {
        if (store === 'memory_selection_nodes') this.selectionNodes.delete(key);
        const pending = this.native.objectStore(store).delete(key);
        this.changes?.write(store, key);
        return request(pending);
    }
    add(store: Store, value: Row): Promise<IDBValidKey> {
        if (store === 'memory_selection_nodes') this.selectionNodes.delete(value.id);
        const pending = this.native.objectStore(store).add(value);
        this.changes?.write(store, value.id, value);
        return request(pending);
    }
}
export class Library {
    readonly changes = new LibraryChanges();
    private constructor(readonly db: IDBDatabase) { }
    static open(name = `${DB_PREFIX}default`, existingOnly = false): Promise<Library> {
        check(name.startsWith(DB_PREFIX), '不是 Mnemosyne 库');
        return new Promise((resolve, reject) => {
            const r = indexedDB.open(name, DB_VERSION);
            r.onupgradeneeded = () => {
                // Backup workers must never create an empty database or migrate a live one.
                if (existingOnly) { r.transaction!.abort(); return; }
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
            r.onblocked = () => reject(new Error('数据库升级被另一个标签页阻塞，请关闭旧标签页'));
            r.onsuccess = () => {
                r.result.onversionchange = () => r.result.close();
                resolve(new Library(r.result));
            };
        });
    }
    async transaction<T>(stores: readonly Store[], mode: IDBTransactionMode, fn: (tx: Transaction) => Promise<T>): Promise<T> {
        const included = stores.includes('memory_views') ? [...new Set([...stores, 'memory_selection_nodes' as const])] : [...stores];
        const native = this.db.transaction(included, mode);
        const changes = mode === 'readwrite' ? new TransactionChanges() : undefined;
        const done = new Promise<void>((resolve, reject) => {
            native.oncomplete = () => resolve();
            native.onabort = () => reject(native.error ?? new Error('事务已撤销'));
            native.onerror = () => { }; // onabort is authoritative
        });
        // Network, hashing and timers must never run inside fn.
        try {
            const result = await fn(new Transaction(native, changes));
            await done;
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
