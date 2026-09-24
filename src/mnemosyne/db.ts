import { STORES, type Store, type Row, check, id } from './model';
export const DB_PREFIX = 'mnemosyne_daily_';
export const ACTIVE_KEY = 'mnemosyne_daily_active_v1';
export const DB_VERSION = 1;
export function request<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
export class Transaction {
    constructor(readonly native: IDBTransaction) { }
    get<T extends Row>(store: Store, key: string): Promise<T | undefined> {
        return request(this.native.objectStore(store).get(key));
    }
    all<T extends Row>(store: Store, index?: 'story' | 'branch' | 'owner', key?: string): Promise<T[]> {
        const s = this.native.objectStore(store);
        return request(index ? s.index(index).getAll(key) : s.getAll());
    }
    put(store: Store, value: Row): Promise<IDBValidKey> { return request(this.native.objectStore(store).put(value)); }
    delete(store: Store, key: string): Promise<undefined> { return request(this.native.objectStore(store).delete(key)); }
    add(store: Store, value: Row): Promise<IDBValidKey> { return request(this.native.objectStore(store).add(value)); }
}
export class Library {
    private constructor(readonly db: IDBDatabase) { }
    static open(name = `${DB_PREFIX}default`): Promise<Library> {
        check(name.startsWith(DB_PREFIX), '不是 Mnemosyne 库');
        return new Promise((resolve, reject) => {
            const r = indexedDB.open(name, DB_VERSION);
            r.onupgradeneeded = () => {
                for (const name of STORES) {
                    const s = r.result.createObjectStore(name, { keyPath: 'id' });
                    for (const key of ['story', 'branch', 'owner'])
                        s.createIndex(key, key);
                }
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
        const native = this.db.transaction([...stores], mode);
        const done = new Promise<void>((resolve, reject) => {
            native.oncomplete = () => resolve();
            native.onabort = () => reject(native.error ?? new Error('事务已撤销'));
            native.onerror = () => { }; // onabort is authoritative
        });
        // Network, hashing and timers must never run inside fn.
        try {
            const result = await fn(new Transaction(native));
            await done;
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
    all<T extends Row>(store: Store, index?: 'story' | 'branch' | 'owner', key?: string) {
        return this.transaction([store], 'readonly', tx => tx.all<T>(store, index, key));
    }
    close() { this.db.close(); }
}
let active: Promise<Library> | undefined;
export function activeLibrary(): Promise<Library> {
    return active ??= Library.open(localStorage.getItem(ACTIVE_KEY) || `${DB_PREFIX}default`);
}
export async function activateLibrary(lib: Library) {
    // Durable selector changes only after validation and import transaction completion.
    localStorage.setItem(ACTIVE_KEY, lib.db.name);
    const previous = active;
    active = Promise.resolve(lib);
    if (previous)
        (await previous).close();
}
export const freshLibraryName = () => `${DB_PREFIX}${id('lib')}`;
