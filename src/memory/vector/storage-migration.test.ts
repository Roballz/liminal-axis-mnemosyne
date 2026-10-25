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
  const upgraded = await result(indexedDB.open(testCase.db, 2));
  try {
    expect(await result(upgraded.transaction(testCase.store).objectStore(testCase.store).getAll())).toEqual([testCase.row]);
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
