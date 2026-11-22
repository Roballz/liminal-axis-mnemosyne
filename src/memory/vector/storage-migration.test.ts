import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
const cases = [
  { name: 'vectors', db: 'mnemosyne_vec_local', store: 'items', metadata: 'item_metadata',
    row: { database: 'synthetic', scope: 'chat:old', leafId: 'old', docHash: 'old', payloadHash: 'old',
      vector: new Float32Array([1, 0]), dim: 2, document: '原摘要', mesFull: '原正文', msgIndex: 0 } },
  { name: 'knowledge', db: 'mnemosyne_knowledge_files', store: 'files', metadata: 'file_metadata',
    row: { id: 'old', database: 'synthetic', name: '原文.md', delimiter: '===', chunks: ['甲', '乙'],
      sourceText: '\uFEFF甲\r\n === \r\n乙\r\n', sourceVersion: 1, enabled: true, embedding: 'original-model', revision: 'original' } },
] as const;
async function seed(testCase: typeof cases[number]): Promise<IDBDatabase> {
  const request = indexedDB.open(testCase.db, 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore(testCase.store, {
      keyPath: testCase.name === 'vectors' ? ['database', 'scope', 'leafId'] : 'id',
    });
    if (testCase.name === 'vectors') store.createIndex('by_scope', ['database', 'scope']);
    else store.createIndex('database', 'database');
    store.put(testCase.row);
  };
  return result(request);
}
async function opener(testCase: typeof cases[number]): Promise<() => Promise<unknown>> {
  if (testCase.name === 'vectors') {
    const { localStore } = await import('./store');
    return () => localStore.stats('synthetic', ['chat:old']);
  }
  const { listKnowledgeMetadata } = await import('./knowledge');
  return () => listKnowledgeMetadata('synthetic');
}
beforeEach(() => { vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(cases)('$name: blocked old connection reports a retryable error and never silently clears the old database', async testCase => {
  const old = await seed(testCase), open = await opener(testCase);
  await expect(open()).rejects.toThrow('旧页面');
  old.close();
  await expect(open()).resolves.toBeDefined();
  const upgraded = await result(indexedDB.open(testCase.db));
  try {
    const rows = await result(upgraded.transaction(testCase.store).objectStore(testCase.store).getAll());
    if (testCase.name === 'vectors') {
      const { database, scope, leafId, vector } = testCase.row;
      expect(rows).toEqual([{ database, scope, leafId, vector }]);
    } else expect(rows).toEqual([testCase.row]);
  } finally { upgraded.close(); }
});

it.each(cases)('$name: aborted metadata backfill retains schema v1 and original rows, then retries successfully', async testCase => {
  (await seed(testCase)).close();
  const open = await opener(testCase), put = IDBObjectStore.prototype.put;
  const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = put.call(this, value, key);
    if (this.name === testCase.metadata) request.addEventListener('success', () => this.transaction.abort(), { once: true });
    return request;
  });
  await expect(open()).rejects.toBeDefined();
  fail.mockRestore();
  const original = await result(indexedDB.open(testCase.db, 1));
  try {
    expect(original.version).toBe(1); expect(original.objectStoreNames.contains(testCase.metadata)).toBe(false);
    expect(await result(original.transaction(testCase.store).objectStore(testCase.store).getAll())).toEqual([testCase.row]);
  } finally { original.close(); }
  await expect(open()).resolves.toBeDefined();
});

it('v2 chat compaction resumes at its committed batch, keeps other scopes and reuses the existing vectors', async () => {
  const dbName = 'mnemosyne_vec_local', database = 'synthetic', scope = 'chat:v2';
  const open = indexedDB.open(dbName, 2);
  open.onupgradeneeded = () => {
    const db = open.result;
    const items = db.createObjectStore('items', { keyPath: ['database', 'scope', 'leafId'] });
    items.createIndex('by_scope', ['database', 'scope']);
    const meta = db.createObjectStore('item_metadata', { keyPath: items.keyPath });
    meta.createIndex('by_scope', ['database', 'scope']);
    db.createObjectStore('scope_versions', { keyPath: ['database', 'scope'] }).put({ database, scope, revision: 7 });
    for (let i = 0; i < 130; i++) {
      const leafId = String(i).padStart(3, '0');
      const row = { ...cases[0].row, database, scope, leafId };
      items.put(row);
      meta.put({ database, scope, leafId, docHash: row.docHash, payloadHash: row.payloadHash });
    }
    items.put({ ...cases[0].row, scope: 'knowledge:untouched' });
  };
  (await result(open)).close();
  const { localStore } = await import('./store');
  const { encodeFloat32Base64 } = await import('./embed');
  const query = [encodeFloat32Base64(new Float32Array([1, 0]))];
  const originalPut = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'items' && value.leafId === '065') throw new Error('synthetic interrupt');
    return originalPut.call(this, value, key);
  });
  await expect(localStore.search(database, [scope], query)).rejects.toThrow('synthetic interrupt');
  fault.mockRestore();
  const db = await result(indexedDB.open(dbName));
  try {
    const read = (id: string) => result(db.transaction('items').objectStore('items').get([database, scope, id]));
    expect(await read('063')).not.toHaveProperty('mesFull');
    expect(await read('064')).toHaveProperty('mesFull', '原正文');
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const hits = await localStore.search(database, [scope], query, { topK: 1 });
    expect(getAll.mock.calls.map(args => args[1])).toEqual([64, 64]);
    expect(hits.results[0]).toMatchObject({ leafId: '000', similarity: 1, document: '', mesFull: null });
    expect(await read('129')).toEqual({ database, scope, leafId: '129', vector: new Float32Array([1, 0]) });
    getAll.mockClear();
    await localStore.search(database, [scope], query);
    expect(getAll).not.toHaveBeenCalled();
    expect(await result(db.transaction('items').objectStore('items').get([database, 'knowledge:untouched', 'old'])))
      .toHaveProperty('document', '原摘要');
  } finally { db.close(); }
});
