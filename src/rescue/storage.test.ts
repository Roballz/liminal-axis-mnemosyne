import { describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { ARCHIVE_STORES, encodeGraph, enumerate, inspect, openExisting, readRaw } from './storage';
import { STORES } from '../mnemosyne/model';
async function create(factory: IDBFactory, name = 'mnemosyne_daily_lib_test') {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('host_bindings', { keyPath: 'id' }); r.result.createObjectStore('event_chains', { keyPath: 'id' }); r.result.createObjectStore('unknown_font_data'); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([...db.objectStoreNames], 'readwrite');
    t.objectStore('host_bindings').put({ id: 'broken', branch: 'missing-branch', private: 'SYNTHETIC RP' });
    t.objectStore('unknown_font_data').put(new Uint8Array([1, 2]), 'font');
    t.oncomplete = () => resolve(); t.onabort = () => reject(t.error);
  });
  db.close(); return name;
}
describe('isolated archive rescue', () => {
  it('allowlist matches current archive schema without importing its runtime', () => { expect([...ARCHIVE_STORES]).toEqual([...STORES]); });
  it('unsupported enumeration never guesses or opens', async () => {
    const factory = { open: vi.fn() } as unknown as IDBFactory;
    await expect(enumerate(factory)).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(factory.open).not.toHaveBeenCalled();
  });
  it('counts all stores in one readonly transaction, preserves raw invalid refs and omits unknown content', async () => {
    const f = new IDBFactory(); const name = await create(f);
    const open = f.open.bind(f); const modes: string[] = [];
    vi.spyOn(f, 'open').mockImplementation((...args) => {
      expect(args).toHaveLength(1);
      const r = open(...args); r.addEventListener('success', () => {
        const db = r.result; const transaction = db.transaction.bind(db);
        vi.spyOn(db, 'transaction').mockImplementation((names, mode, options) => {
          modes.push(mode ?? 'readonly'); expect([...names as string[]]).toHaveLength(3);
          const t = transaction(names, mode, options); const objectStore = t.objectStore.bind(t);
          vi.spyOn(t, 'objectStore').mockImplementation(n => {
            const store = objectStore(n);
            if (n === 'unknown_font_data') { vi.spyOn(store, 'openCursor').mockImplementation(() => { throw new Error('must never read unrelated contents'); }); }
            return store;
          }); return t;
        });
      }); return r;
    });
    const counts = await inspect(f, name); expect(counts.counts.find(s => s.name === 'host_bindings')?.count).toBe(1);
    const raw = await readRaw(f, name); expect(raw.omittedStores).toEqual(['unknown_font_data']);
    expect(raw.stores.find(s => s.name === 'host_bindings')?.records).toEqual([{ key: 'broken', value: { id: 'broken', branch: 'missing-branch', private: 'SYNTHETIC RP' } }]);
    expect(JSON.stringify(counts)).not.toContain('SYNTHETIC RP'); expect(modes).toEqual(['readonly', 'readonly']);
  });
  it('missing and unrelated names never invoke open', async () => {
    const f = new IDBFactory(); const open = vi.spyOn(f, 'open');
    await expect(openExisting(f, 'mnemosyne_daily_default')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(openExisting(f, 'NY_font')).rejects.toMatchObject({ name: 'NotAllowedError' }); expect(open).not.toHaveBeenCalled();
  });
  it('aborts vanished database creation and leaves no database', async () => {
    const f = new IDBFactory(); vi.spyOn(f, 'databases').mockResolvedValueOnce([{ name: 'mnemosyne_daily_default', version: 1 }]);
    await expect(openExisting(f, 'mnemosyne_daily_default')).rejects.toMatchObject({ name: 'NotFoundError' });
    await new Promise(r => setTimeout(r, 10)); expect(await f.databases()).toEqual([]);
  });
  it('closes a late success after timeout and rejects blocked opens', async () => {
    const request: Record<string, any> = {}, close = vi.fn();
    const f = { databases: async () => [{ name: 'mnemosyne_daily_default' }], open: () => request } as unknown as IDBFactory;
    await expect(openExisting(f, 'mnemosyne_daily_default', 5)).rejects.toMatchObject({ name: 'TimeoutError' });
    request.result = { close }; request.onsuccess(); expect(close).toHaveBeenCalledOnce();
    const second = openExisting(f, 'mnemosyne_daily_default', 100);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    request.onblocked(); await expect(second).rejects.toMatchObject({ name: 'BlockedError' });
    request.onsuccess(); expect(close).toHaveBeenCalledTimes(2);
  });
  it('read timeout aborts its readonly transaction and closes its connection', async () => {
    const tx: any = { objectStore: () => ({ count: () => ({}) }), abort: vi.fn() };
    const db: any = { name: 'mnemosyne_daily_default', version: 1, objectStoreNames: ['host_bindings'], transaction: vi.fn(() => tx), close: vi.fn() };
    const f = { databases: async () => [{ name: db.name }], open: () => {
      const request: any = { result: db }; setTimeout(() => request.onsuccess(), 0); return request;
    } } as unknown as IDBFactory;
    await expect(inspect(f, db.name, 10)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(tx.abort).toHaveBeenCalledOnce(); expect(db.close).toHaveBeenCalledOnce();
    expect(db.transaction).toHaveBeenCalledWith(['host_bindings'], 'readonly');
  });
  it('count reports request errors; raw export fails entirely on the same read error', async () => {
    function factory() {
      const tx: any = { error: new DOMException('synthetic read failure', 'UnknownError') };
      tx.objectStore = () => ({ keyPath: 'id', autoIncrement: false, openCursor: () => ({}), count: () => {
        const r: any = { error: tx.error };
        setTimeout(() => {
          const event = new Event('error', { cancelable: true }); r.onerror(event);
          event.defaultPrevented ? tx.oncomplete() : tx.onabort();
        }, 0); return r;
      } });
      tx.abort = () => tx.onabort();
      const db: any = { name: 'mnemosyne_daily_default', version: 1, objectStoreNames: ['host_bindings'], transaction: () => tx, close: vi.fn() };
      const f = { databases: async () => [{ name: db.name }], open: () => {
        const r: any = { result: db }; setTimeout(() => r.onsuccess(), 0); return r;
      } } as unknown as IDBFactory;
      return { f, db };
    }
    const a = factory(); const result = await inspect(a.f, a.db.name);
    expect(result.counts[0].error).toEqual({ name: 'UnknownError', message: 'synthetic read failure' });
    expect(a.db.close).toHaveBeenCalledOnce();
    const b = factory(); await expect(readRaw(b.f, b.db.name)).rejects.toMatchObject({ name: 'UnknownError' });
    expect(b.db.close).toHaveBeenCalledOnce();
  });
  it('enumeration timeout is bounded', async () => {
    await expect(enumerate({ databases: () => new Promise(() => {}) } as unknown as IDBFactory, 5)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
  it('graph encoding preserves cycles, shared values, binary offsets, blobs and special numbers', async () => {
    const buffer = new Uint8Array([2, 3, 4]).buffer; const shared = { x: undefined };
    const data: any = { a: shared, b: shared, view: new Uint8Array(buffer, 1, 1), buffer, date: new Date(123), blob: new Blob(['abc']), file: new File(['file'], 'synthetic.txt', { type: 'text/plain', lastModified: 42 }), num: [NaN, Infinity, -Infinity, -0, 1n], map: new Map([[shared, new Set([shared])]]) }; data.self = data;
    const encoded: any = await encodeGraph(data); const parsed = JSON.parse(JSON.stringify(encoded));
    const root = parsed.nodes[parsed.root.$ref]; const entries = Object.fromEntries(root.entries);
    expect(entries.a).toEqual(entries.b); expect(entries.self).toEqual(parsed.root);
    expect(parsed.nodes[entries.view.$ref]).toMatchObject({ type: 'Uint8Array', byteOffset: 1, byteLength: 1, buffer: entries.buffer });
    expect(parsed.nodes[entries.blob.$ref]).toMatchObject({ type: 'Blob', bytes: [97, 98, 99] });
    expect(parsed.nodes[entries.file.$ref]).toMatchObject({ type: 'File', name: 'synthetic.txt', lastModified: 42, mime: 'text/plain', bytes: [102, 105, 108, 101] });
    expect(parsed.nodes[entries.num.$ref].entries.map((x: any) => x[1])).toEqual([{ $number: 'NaN' }, { $number: 'Infinity' }, { $number: '-Infinity' }, { $number: '-0' }, { $bigint: '1' }]);
  });
  it('fails closed on unsupported values rather than successful lossy output', async () => {
    await expect(encodeGraph({ bad: new Error('private') })).rejects.toMatchObject({ name: 'DataCloneError' });
  });
  it('rescue entry has no normal bootstrap, persistence or network actions', () => {
    const entry = readFileSync('src/rescue/index.ts', 'utf8'); const storage = readFileSync('src/rescue/storage.ts', 'utf8');
    expect(entry.match(/^import .*$/gm)).toEqual(["import { ACTIVE_KEY, enumerate, errorInfo, inspect, isArchive, readRaw, encodeGraph } from './storage';"]);
    expect(entry + storage).not.toMatch(/\b(fetch|XMLHttpRequest|activeLibrary|activateLibrary|syncDaily|deleteDatabase|createObjectStore)\s*\(/);
    expect(entry + storage).not.toMatch(/localStorage\.(setItem|clear|removeItem)/);
    expect(storage).not.toContain("'readwrite'");
  });
});
