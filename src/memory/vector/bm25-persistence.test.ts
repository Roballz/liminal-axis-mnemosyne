import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MiniSearch from 'minisearch';
import { LexicalIndex, type LexicalRequest, type LexicalSnapshot } from './bm25-index';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request = (text = '原编号 XJ42', scope = 'chat:A'): LexicalRequest => ({ database: 'synthetic', scope,
  documents: [{ id: 'A', text }, { id: 'B', text: '车站' }], queries: ['XJ42'], exclude: [], topK: 5 });
function storage() {
  const snapshots = new Map<string, LexicalSnapshot>();
  return { snapshots, load: vi.fn(async (key: string) => snapshots.get(key)),
    save: vi.fn(async (snapshot: LexicalSnapshot) => { snapshots.set(snapshot.key, structuredClone(snapshot)); }) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('returns hits before serialization and coalesces pending changes into one latest snapshot', async () => {
  const saved = storage(), index = new LexicalIndex(saved), serialize = vi.spyOn(MiniSearch.prototype, 'toJSON');
  const first = await index.search(request());
  expect(first.hits.map(hit => hit.id)).toEqual(['A']); expect(first.persistent).toBe(false);
  expect(saved.save).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
  await index.search(request('第二版 XJ42')); await index.search(request('第三版 XJ42'));
  await vi.runOnlyPendingTimersAsync();
  expect(saved.save).toHaveBeenCalledTimes(1); expect(serialize).toHaveBeenCalledTimes(1);
  expect(saved.save.mock.calls[0][0].documents.find(doc => doc.id === 'A')!.text).toBe('第三版 XJ42');
  expect((await index.search(request('第三版 XJ42'))).persistent).toBe(true);
  const add = vi.spyOn(MiniSearch.prototype, 'add');
  expect((await new LexicalIndex(saved).search(request('第三版 XJ42'))).persistent).toBe(true);
  expect(add).not.toHaveBeenCalled();
});

it('a slow write never blocks queries or clears a newer dirty revision', async () => {
  const saved = storage(), gate = deferred<void>(), commit = saved.save.getMockImplementation()!;
  saved.save.mockImplementationOnce(async snapshot => { await gate.promise; await commit(snapshot); });
  const index = new LexicalIndex(saved);
  await index.search(request()); await vi.advanceTimersByTimeAsync(0);
  expect(saved.save).toHaveBeenCalledTimes(1);
  const next = await index.search(request('新版本 XJ42'));
  expect(next.hits[0].id).toBe('A'); expect(next.persistent).toBe(false);
  gate.resolve(); await index.flushPending();
  expect(saved.save).toHaveBeenCalledTimes(2);
  expect((await index.search(request('新版本 XJ42'))).persistent).toBe(true);
  expect((await new LexicalIndex(saved).search(request('新版本 XJ42'))).hits).toEqual(next.hits);
  expect([...saved.snapshots.values()][0].documents.find(doc => doc.id === 'A')!.text).toBe('新版本 XJ42');
});

it('late old-scope writes cannot acknowledge the same-numbered revision of a new scope', async () => {
  const saved = storage(), gate = deferred<void>(), commit = saved.save.getMockImplementation()!;
  saved.save.mockImplementationOnce(async snapshot => { await gate.promise; await commit(snapshot); });
  const index = new LexicalIndex(saved);
  await index.search(request('A 的 XJ42', 'chat:A')); await vi.advanceTimersByTimeAsync(0);
  const next = await index.search(request('B 的 XJ42', 'chat:B'));
  expect(next.persistent).toBe(false);
  gate.resolve(); await index.flushPending();
  expect(saved.save.mock.calls.map(([snapshot]) => [JSON.parse(snapshot.key)[1], snapshot.documents[0].text])).toEqual([
    ['chat:A', 'A 的 XJ42'], ['chat:B', 'B 的 XJ42'],
  ]);
  expect((await index.search(request('B 的 XJ42', 'chat:B'))).persistent).toBe(true);
});

it('switching before a save starts discards its obsolete timer and saves only the new scope', async () => {
  const saved = storage(), index = new LexicalIndex(saved);
  await index.search(request('A 的 XJ42', 'chat:A'));
  await index.search(request('B 的 XJ42', 'chat:B'));
  await vi.runOnlyPendingTimersAsync();
  expect(saved.save).toHaveBeenCalledTimes(1);
  expect(JSON.parse(saved.save.mock.calls[0][0].key)[1]).toBe('chat:B');
});

it('failed background writes retain dirty state and retry on the next search without a busy retry loop', async () => {
  const saved = storage(), index = new LexicalIndex(saved);
  saved.save.mockRejectedValueOnce(new Error('synthetic quota failure'));
  const first = await index.search(request());
  await vi.advanceTimersByTimeAsync(10_000);
  expect(saved.save).toHaveBeenCalledTimes(1); expect(first.persistent).toBe(false);
  const next = await index.search(request());
  expect(next.hits).toEqual(first.hits); expect(next.persistent).toBe(false);
  await index.flushPending();
  expect(saved.save).toHaveBeenCalledTimes(2);
  expect((await index.search(request())).persistent).toBe(true);
});
