import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LexicalRequest, LexicalResult } from './bm25-index';

interface MockWorker extends EventTarget {
  posts: { id: number; request: LexicalRequest }[]; terminate: ReturnType<typeof vi.fn>;
}
const state = vi.hoisted(() => ({ workers: [] as MockWorker[] }));
vi.mock('./bm25.worker?worker&inline', () => ({ default: class extends EventTarget {
  posts: MockWorker['posts'] = [];
  terminate = vi.fn();
  constructor() { super(); state.workers.push(this); }
  postMessage(data: MockWorker['posts'][number]) { this.posts.push(data); }
} }));
const request: LexicalRequest = { database: 'synthetic', scope: 'chat:A', documents: [], queries: ['编号'], exclude: [], topK: 5 };
const result: LexicalResult = { hits: [{ id: 'synthetic', score: 1 }], persistent: false };
const reply = (worker: MockWorker, id = worker.posts.at(-1)!.id) => worker.dispatchEvent(new MessageEvent('message', { data: { id, result } }));
beforeEach(() => { vi.resetModules(); state.workers = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('cancelled active work is terminated; a queued cancellation never kills another caller', async () => {
  const { searchBm25 } = await import('./bm25');
  const a = new AbortController(), c = new AbortController();
  const first = searchBm25(request, a.signal), second = searchBm25(request), third = searchBm25(request, c.signal);
  const firstRejected = expect(first).rejects.toThrow('cancel active'), thirdRejected = expect(third).rejects.toThrow('cancel queued');
  expect(state.workers).toHaveLength(1); expect(state.workers[0].posts).toHaveLength(1);
  c.abort(new Error('cancel queued')); await thirdRejected;
  expect(state.workers[0].terminate).not.toHaveBeenCalled();
  a.abort(new Error('cancel active')); await firstRejected;
  expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  expect(state.workers).toHaveLength(2); expect(state.workers[1].posts).toHaveLength(1);
  reply(state.workers[0]); // A late event from the terminated owner has no listener.
  reply(state.workers[1]); expect(await second).toEqual(result);
  expect(vi.getTimerCount()).toBe(0);
});

it('successful requests reuse their Worker; aborting a finished caller cannot terminate its successor', async () => {
  const { searchBm25 } = await import('./bm25'), controller = new AbortController();
  const first = searchBm25(request, controller.signal); reply(state.workers[0]); await first;
  const second = searchBm25(request);
  controller.abort(new Error('late cancel'));
  expect(state.workers).toHaveLength(1); expect(state.workers[0].terminate).not.toHaveBeenCalled();
  reply(state.workers[0]); await expect(second).resolves.toEqual(result);
  expect(vi.getTimerCount()).toBe(0);
});

it('timeouts and worker errors reject their owner and allow waiting/new work to run', async () => {
  const { searchBm25 } = await import('./bm25');
  const first = searchBm25(request), second = searchBm25(request);
  const firstRejected = expect(first).rejects.toThrow('超时'), secondRejected = expect(second).rejects.toThrow('不可用');
  await vi.advanceTimersByTimeAsync(30_000); await firstRejected;
  expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  state.workers[1].dispatchEvent(new Event('error')); await secondRejected;
  expect(state.workers[1].terminate).toHaveBeenCalledTimes(1);
  const third = searchBm25(request); reply(state.workers[2]); await expect(third).resolves.toEqual(result);
  expect(vi.getTimerCount()).toBe(0);
});

it('a pre-cancelled request never creates a Worker', async () => {
  const { searchBm25 } = await import('./bm25'), controller = new AbortController();
  controller.abort(new Error('never start'));
  expect(() => searchBm25(request, controller.signal)).toThrow('never start');
  expect(state.workers).toHaveLength(0);
});
