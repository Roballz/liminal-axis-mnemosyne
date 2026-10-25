import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { vecSearch as backendSearch } from '@/api/baibaoku';
import { encodeFloat32Base64 } from './embed';
import { localStore } from './store';

const encode = (values: number[]) => encodeFloat32Base64(new Float32Array(values));
const row = (leafId: string, values: number[]) => ({ leafId, docHash: leafId, payloadHash: leafId,
  vector: encode(values), dim: values.length, document: leafId });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('candidate norms run once across queries while scores, exclusions and scope ties stay identical', async () => {
  const database = crypto.randomUUID();
  await localStore.upsert(database, 'primary', [row('alpha', [1, 0]), row('shared', [1, 0]), row('angled', [3, 4]),
    row('zero', [0, 0]), row('mismatch', [1, 0, 0]), row('excluded', [1, 0])]);
  await localStore.upsert(database, 'other', [row('beta', [0, 7]), { ...row('shared', [0, 1]), document: 'other shared' }]);
  const sqrt = vi.spyOn(Math, 'sqrt');
  const { results } = await localStore.search(database, ['primary', 'other'], [encode([1, 0]), encode([0, 2])],
    { topK: 10, excludeLeafIds: ['excluded'] });
  expect(sqrt).toHaveBeenCalledTimes(2 + 6);
  expect(results.map(({ leafId, similarity, queryIndex }) => [leafId, similarity, queryIndex])).toEqual([
    ['alpha', 1, 0], ['shared', 1, 0], ['beta', 1, 1], ['angled', .8, 1], ['mismatch', -1, -1], ['zero', -1, -1],
  ]);
  expect(results[1]).toMatchObject({ scope: 'primary', document: 'shared' });
});

it('cancel at the first scoring yield stops remaining candidates and later scopes', async () => {
  const database = crypto.randomUUID(), controller = new AbortController(), reason = new Error('synthetic cancel');
  await localStore.upsert(database, 'large', Array.from({ length: 240 }, (_, i) => row(String(i), [1, 0])));
  await localStore.upsert(database, 'later', [row('later', [1, 0])]);
  const sqrt = vi.spyOn(Math, 'sqrt'), reads = vi.spyOn(IDBIndex.prototype, 'getAll');
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    controller.abort(reason); return schedule(callback, delay, ...args);
  });
  await expect(localStore.search(database, ['large', 'later'], [encode([1, 0])], { signal: controller.signal })).rejects.toBe(reason);
  expect(sqrt).toHaveBeenCalledTimes(1 + 95);
  expect(reads).toHaveBeenCalledTimes(1);
});

it('pre-cancelled local search performs no IndexedDB transaction', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled before search'));
  const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
  await expect(localStore.search('synthetic', ['never'], [encode([1, 0])], { signal: controller.signal })).rejects.toThrow('cancelled before search');
  expect(transactions).not.toHaveBeenCalled();
});

it('cancelling an IndexedDB read rejects promptly and leaves the shared connection usable', async () => {
  const database = crypto.randomUUID(), controller = new AbortController(), reason = new Error('cancel pending read');
  await localStore.upsert(database, 'scope', [row('first', [1, 0])]);
  const getAll = IDBIndex.prototype.getAll;
  const reads = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, query, count) {
    const request = getAll.call(this, query, count);
    queueMicrotask(() => controller.abort(reason));
    return request;
  });
  const sqrt = vi.spyOn(Math, 'sqrt');
  await expect(localStore.search(database, ['scope'], [encode([1, 0])], { signal: controller.signal })).rejects.toBe(reason);
  expect(sqrt).toHaveBeenCalledTimes(1); reads.mockRestore();
  expect((await localStore.search(database, ['scope'], [encode([1, 0])])).results[0].leafId).toBe('first');
});

it('backend search passes cancellation to fetch without serializing the signal into the request', async () => {
  const controller = new AbortController(), reason = new Error('cancelled backend');
  const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  const pending = backendSearch('synthetic', ['scope'], [encode([1, 0])], { topK: 7, signal: controller.signal });
  expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({ database: 'synthetic', scopes: ['scope'], queryVectors: [encode([1, 0])], topK: 7 });
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});
