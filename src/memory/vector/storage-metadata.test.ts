import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as embed from './embed';
import { localStore } from './store';
import { editKnowledge, importKnowledge, knowledgeScope, listKnowledge, listKnowledgeMetadata,
  recallKnowledge, type KnowledgeFile } from './knowledge';

const original = JSON.parse(JSON.stringify(apiSettings.vector));
const identity = JSON.stringify(['https://synthetic.invalid', 'synthetic']);
const vector = embed.encodeFloat32Base64(new Float32Array([1, 0]));
const cfg = { enabled: true, count: 1, threshold: .8, maxChars: 2000 };
const legacy: KnowledgeFile = { id: 'v1-file', database: 'migration', name: '原文.md', delimiter: '===',
  sourceVersion: 1, sourceText: '\uFEFF  甲\r\n === \r\n乙\r\n', chunks: ['甲', '乙'],
  enabled: true, embedding: identity, revision: 'v1-revision' };
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
}
function item(i: number) {
  return { leafId: `leaf-${i}`, docHash: `doc-${i}`, payloadHash: `payload-${i}`, vector, dim: 2,
    document: `合成摘要${i}`, mesFull: '合成正文'.repeat(1250), msgIndex: i };
}
const present = (items: ReturnType<typeof item>[]) => items.map(({ leafId, docHash, payloadHash }) => ({ leafId, docHash, payloadHash }));

beforeAll(async () => {
  const oldVectors = indexedDB.open('mnemosyne_vec_local', 1);
  oldVectors.onupgradeneeded = () => {
    const store = oldVectors.result.createObjectStore('items', { keyPath: ['database', 'scope', 'leafId'] });
    store.createIndex('by_scope', ['database', 'scope']);
    store.put({ ...item(0), vector: new Float32Array([1, 0]), database: 'migration', scope: 'chat:old', storyTime: null });
    legacy.chunks.forEach((text, index) => store.put({ ...item(index), database: legacy.database, scope: knowledgeScope(legacy),
      leafId: `${legacy.id}:${index}`, document: text, vector: new Float32Array([1, 0]), storyTime: null }));
  };
  (await request(oldVectors)).close();
  const oldKnowledge = indexedDB.open('mnemosyne_knowledge_files', 1);
  oldKnowledge.onupgradeneeded = () => {
    const store = oldKnowledge.result.createObjectStore('files', { keyPath: 'id' });
    store.createIndex('database', 'database'); store.put(legacy);
  };
  (await request(oldKnowledge)).close();
});
beforeEach(() => {
  Object.assign(apiSettings.vector.embedding, { url: 'https://synthetic.invalid', model: 'synthetic' });
  vi.spyOn(embed, 'embedTexts').mockImplementation(async texts => texts.map(() => new Float32Array([1, 0])));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('禁止真实网络'); }));
});
afterEach(() => { Object.assign(apiSettings.vector, original); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('v1 additive migrations preserve vectors and exact original files without reembedding', async () => {
  expect(await listKnowledge(legacy.database)).toEqual([legacy]);
  const metadata = await listKnowledgeMetadata(legacy.database);
  expect(metadata).toEqual([{ ...legacy, sourceText: undefined, chunks: undefined, chunkCount: 2 }].map(({ sourceText, chunks, ...row }) => row));
  expect(await localStore.reconcile('migration', 'chat:old', present([item(0)]))).toEqual({ deleted: 0, missing: [], stalePayload: [] });
  const hits = await localStore.search('migration', ['chat:old'], [vector]);
  expect(hits.results[0]).toMatchObject({ document: item(0).document, mesFull: item(0).mesFull, similarity: 1 });
  expect(await recallKnowledge(legacy.database, metadata, [vector], cfg)).toContain('甲');
  expect(embed.embedTexts).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('128 large payloads reconcile from hashes; unchanged reconciliation reads only the persisted revision', async () => {
  const database = crypto.randomUUID(), scope = 'chat:large', items = Array.from({ length: 128 }, (_, i) => item(i));
  await localStore.upsert(database, scope, items);
  const all = vi.spyOn(IDBIndex.prototype, 'getAll'), get = vi.spyOn(IDBObjectStore.prototype, 'get');
  const expected = { deleted: 0, missing: [], stalePayload: [] };
  expect(await localStore.reconcile(database, scope, present(items))).toEqual(expected);
  expect(all.mock.contexts.map(index => (index as IDBIndex).objectStore.name)).toEqual(['item_metadata']);
  all.mockClear(); get.mockClear();
  expect(await localStore.reconcile(database, scope, present(items))).toEqual(expected);
  expect(all).not.toHaveBeenCalled();
  expect(get.mock.contexts.map(store => (store as IDBObjectStore).name)).toEqual(['scope_versions']);
  const changedSource = present(items);
  changedSource[0].docHash += ':other-embedding-version';
  expect((await localStore.reconcile(database, scope, changedSource)).missing).toEqual([items[0].leafId]);
  all.mockClear(); get.mockClear();
  await localStore.updatePayload(database, scope, [{ leafId: items[1].leafId, payloadHash: 'updated', mesFull: '新正文' }]);
  expect(get.mock.contexts.filter(store => (store as IDBObjectStore).name === 'items')).toHaveLength(1);
  expect(all).not.toHaveBeenCalled();
  expect((await localStore.reconcile(database, scope, present(items))).stalePayload).toEqual([items[1].leafId]);
  expect(all.mock.contexts.map(index => (index as IDBIndex).objectStore.name)).toEqual(['item_metadata']);
});

it('foreign connection revisions invalidate reconciliation and failed writes publish neither hashes nor payloads', async () => {
  const database = crypto.randomUUID(), scope = 'chat:foreign', items = [item(0)];
  await localStore.upsert(database, scope, items);
  await localStore.reconcile(database, scope, present(items));
  const other = await request(indexedDB.open('mnemosyne_vec_local', 2));
  try {
    const tx = other.transaction(['items', 'item_metadata', 'scope_versions'], 'readwrite'), done = complete(tx);
    const version = await request(tx.objectStore('scope_versions').get([database, scope]));
    tx.objectStore('items').delete([database, scope, items[0].leafId]);
    tx.objectStore('item_metadata').delete([database, scope, items[0].leafId]);
    tx.objectStore('scope_versions').put({ ...version, revision: version.revision + 1 });
    await done;
  } finally { other.close(); }
  const missing = await localStore.reconcile(database, scope, present(items));
  expect(missing.missing).toEqual([items[0].leafId]);
  missing.missing.length = 0;
  expect((await localStore.reconcile(database, scope, present(items))).missing).toEqual([items[0].leafId]);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'item_metadata') throw new Error('synthetic atomic write failure');
    return put.call(this, value, key);
  });
  await expect(localStore.upsert(database, scope, items)).rejects.toThrow('synthetic atomic write failure');
  expect((await localStore.stats(database, [scope])).stats[scope]).toBe(0);
  expect((await localStore.search(database, [scope], [vector])).results).toEqual([]);
  expect((await localStore.reconcile(database, scope, present(items))).missing).toEqual([items[0].leafId]);
});

it('knowledge checks never clone files and read only the matching complete hit block', async () => {
  const database = crypto.randomUUID();
  const file = await importKnowledge(database, 'large.md', '===', Array.from({ length: 64 }, (_, i) => `合成块${i}`));
  const metadata = await listKnowledgeMetadata(database);
  const get = vi.spyOn(IDBObjectStore.prototype, 'get'), all = vi.spyOn(IDBIndex.prototype, 'getAll');
  vi.spyOn(localStore, 'search').mockResolvedValue({ results: [{ scope: knowledgeScope(file), leafId: `${file.id}:31`,
    similarity: 1, queryIndex: 0, document: file.chunks[31], mesFull: null, storyTime: null, msgIndex: 31 }] });
  expect(await recallKnowledge(database, metadata, [vector], cfg)).toContain('合成块31');
  await listKnowledgeMetadata(database);
  expect(get.mock.contexts.map(store => (store as IDBObjectStore).name)).toEqual(['file_metadata', 'file_blocks']);
  expect(all.mock.contexts.map(index => (index as IDBIndex).objectStore.name)).toEqual(['file_metadata']);
  expect(get.mock.calls[1][0]).toEqual([file.id, file.id, 31]);
});

it('64-block editing keeps both per-batch generation checks but loads original files only for the two writes', async () => {
  const database = crypto.randomUUID();
  const file = await importKnowledge(database, 'edit.md', '===', ['初始正文']);
  const get = vi.spyOn(IDBObjectStore.prototype, 'get');
  const text = Array.from({ length: 64 }, (_, i) => `更新块${i}`).join('\n===\n');
  const updated = await editKnowledge(file, text);
  expect(updated.sourceText).toBe(text);
  expect(get.mock.contexts.filter(store => (store as IDBObjectStore).name === 'files')).toHaveLength(2);
  expect(get.mock.contexts.filter(store => (store as IDBObjectStore).name === 'file_metadata')).toHaveLength(8);
  expect((await listKnowledgeMetadata(database))[0]).toMatchObject({ revision: updated.revision, vectorRevision: updated.vectorRevision, chunkCount: 64 });
});

it('metadata changed by a foreign writer during search discards hits before loading any block', async () => {
  const database = crypto.randomUUID(), file = await importKnowledge(database, 'foreign.md', '===', ['合成知识']);
  const metadata = await listKnowledgeMetadata(database), other = await request(indexedDB.open('mnemosyne_knowledge_files', 2));
  vi.spyOn(localStore, 'search').mockImplementation(async () => {
    const tx = other.transaction(['files', 'file_metadata'], 'readwrite'), done = complete(tx);
    tx.objectStore('files').put({ ...file, enabled: false, revision: 'foreign' });
    tx.objectStore('file_metadata').put({ ...metadata[0], enabled: false, revision: 'foreign' });
    await done;
    return { results: [{ scope: knowledgeScope(file), leafId: `${file.id}:0`, similarity: 1, queryIndex: 0,
      document: file.chunks[0], mesFull: null, storyTime: null, msgIndex: 0 }] };
  });
  const get = vi.spyOn(IDBObjectStore.prototype, 'get');
  try { expect(await recallKnowledge(database, metadata, [vector], cfg)).toBe(''); }
  finally { other.close(); }
  expect(get.mock.contexts.map(store => (store as IDBObjectStore).name)).toEqual(['file_metadata']);
  expect((await listKnowledgeMetadata(database))[0].enabled).toBe(false);
});
