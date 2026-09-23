import 'fake-indexeddb/auto';
import { test, expect, vi, afterEach } from 'vitest';
import { parseStrictJson } from './json';
import { batchFixture, output, fixture } from './fixtures';
import { commitEventBatch, eventView, editEvent, prepareEventBatch } from './events';
import { capture, synchronize } from './canonical';
import { exportLibrary, restoreLibrary } from './migration';
import { copyLegacyKnowledge, listKnowledge } from '@/memory/vector/knowledge';
import { localStore } from '@/memory/vector/store';
import { encodeFloat32Base64 } from '@/memory/vector/embed';
afterEach(() => vi.restoreAllMocks());
test('strict JSON rejects duplicate fields, trailing input, infinities and resource excess', () => {
    expect(() => parseStrictJson('{"events":[],"events":[]}')).toThrow('重复字段');
    expect(() => parseStrictJson('{} trailing')).toThrow('额外内容');
    expect(() => parseStrictJson('1e999')).toThrow('非有限');
    expect(() => parseStrictJson('[1,]')).toThrow();
    expect(() => parseStrictJson('"long"', 2)).toThrow('上限');
    expect(parseStrictJson('{"escaped":"a\\\"b","rows":[true,false,null,12]}')).toEqual({ escaped: 'a"b', rows: [true, false, null, 12] });
});
test('malformed but checksummed event link and source basis are rejected as domain corruption', async () => {
    const { lib, batch } = await batchFixture();
    await commitEventBatch(lib, batch, output(batch));
    const pack = await exportLibrary(lib);
    (pack.data.event_memberships[0] as any).kind = 'invented';
    await expect(restoreLibrary(pack, false)).rejects.toThrow('关联字段');
    lib.close();
});
test('manual metadata changes during event request reject stale AI output', async () => {
    const { lib, batch, view } = await batchFixture();
    await editEvent(lib, view, null, { title: '人工新事项', status: 'open', keywords: [] });
    await expect(commitEventBatch(lib, batch, output(batch))).rejects.toThrow('过期');
    expect(await lib.all('event_processing_receipts')).toHaveLength(0);
    lib.close();
});
test('locked manual removal cannot be reactivated by an AI retry after source review', async () => {
    const { lib, batch, branch } = await batchFixture();
    await commitEventBatch(lib, batch, output(batch));
    let v = await capture(lib, branch.id);
    let card = (await eventView(lib, v)).cards[0];
    const removed = batch.memories[0].id;
    await editEvent(lib, v, card.chain.id, card.meta, { memory: removed, active: false, kind: 'progress' });
    v = await capture(lib, branch.id);
    card = (await eventView(lib, v)).cards[0];
    // An explicitly prepared recheck with the same source revision must still honor the manual tombstone.
    const retry = { ...batch, operation: 'manual-recheck', view: v, catalog: [card], fingerprint: 'synthetic-recheck' };
    await commitEventBatch(lib, retry, output(retry, card.chain.id));
    const now = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    expect(now.members.some(m => m.memory === removed)).toBe(false);
    lib.close();
});
test('two branches cannot see each other event catalogs or memberships', async () => {
    const { lib, batch } = await batchFixture();
    await commitEventBatch(lib, batch, output(batch));
    const { observation } = await import('./fixtures');
    const other = await synchronize(lib, observation(2, 'another-story'));
    const view = await capture(lib, other.id);
    expect((await eventView(lib, view)).cards).toHaveLength(0);
    expect((await prepareEventBatch(lib, view, 20, 48000))?.catalog).toHaveLength(0);
    lib.close();
});
test('readonly legacy knowledge copy retains original files/vectors and makes no model request', async () => {
    const old = 'bbs_vec_synthetic', next = 'mnemosyne_vec_synthetic';
    const open = (name: string, upgrade: (db: IDBDatabase) => void) => new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => upgrade(r.result); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const files = await open('bbs_knowledge_files', db => { const s = db.createObjectStore('files', { keyPath: 'id' }); s.createIndex('database', 'database'); });
    const vectors = await open('bbs_vec_local', db => { const s = db.createObjectStore('items', { keyPath: ['database', 'scope', 'leafId'] }); s.createIndex('by_scope', ['database', 'scope']); });
    const write = (db: IDBDatabase, store: string, value: any) => new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    await write(files, 'files', { id: 'synthetic-knowledge', database: old, name: '合成知识库', delimiter: '---', chunks: ['合成原始块'], enabled: true, embedding: 'synthetic-profile', revision: 'synthetic-revision' });
    await write(vectors, 'items', { database: old, scope: 'knowledge:synthetic-knowledge', leafId: 'synthetic-knowledge:0', docHash: 'synthetic-knowledge', payloadHash: 'synthetic-knowledge', vector: new Float32Array([1, 0]), dim: 2, document: '合成原始块', mesFull: null, storyTime: null, msgIndex: 0 });
    expect(await copyLegacyKnowledge(next)).toBe(1);
    expect(await copyLegacyKnowledge(next)).toBe(0);
    expect((await listKnowledge(next))[0].chunks).toEqual(['合成原始块']);
    const result = await localStore.search(next, ['knowledge:synthetic-knowledge'], [encodeFloat32Base64(new Float32Array([1, 0]))], { topK: 1 });
    expect(result.results[0].document).toBe('合成原始块');
    const count = await new Promise<number>(resolve => { const r = files.transaction('files', 'readonly').objectStore('files').count(); r.onsuccess = () => resolve(r.result); });
    expect(count).toBe(1);
    files.close();
    vectors.close();
});
