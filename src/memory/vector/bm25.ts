import SearchWorker from './bm25.worker?worker&inline';
import type { LexicalRequest, LexicalResult } from './bm25-index';

type Job = {
  id: number; request: LexicalRequest; signal?: AbortSignal;
  resolve: (value: LexicalResult) => void; reject: (error: unknown) => void; onAbort: () => void;
};
let worker: Worker | undefined;
let serial = 0;
const waiting: Job[] = [];
let active: { job: Job; target: Worker; fail: (error: unknown) => void } | undefined;

function discard(target: Worker): void {
  target.terminate();
  if (worker === target) worker = undefined;
}
function dispatch(): void {
  if (active || !waiting.length) return;
  const job = waiting.shift()!;
  let target: Worker;
  try {
    if (!worker) {
      const created: Worker = new SearchWorker();
      created.addEventListener('error', () => {
        if (active?.target === created) active.fail(new Error('BM25 Worker 不可用'));
        else discard(created);
      });
      worker = created;
    }
    target = worker;
  } catch (error) {
    job.signal?.removeEventListener('abort', job.onAbort); job.reject(error); dispatch(); return;
  }
  const finish = (outcome: { result: LexicalResult } | { error: unknown }, terminate = false) => {
    if (active?.job !== job) return;
    active = undefined;
    clearTimeout(timer); target.removeEventListener('message', onMessage);
    job.signal?.removeEventListener('abort', job.onAbort);
    if (terminate) discard(target);
    if ('result' in outcome) job.resolve(outcome.result); else job.reject(outcome.error);
    dispatch();
  };
  const fail = (error: unknown) => finish({ error }, true);
  const onMessage = (event: MessageEvent<{ id: number; result: LexicalResult; error?: string }>) => {
    if (event.data.id !== job.id) return;
    if (event.data.error !== undefined) finish({ error: new Error(event.data.error) });
    else finish({ result: event.data.result });
  };
  const timer = setTimeout(() => fail(new Error('BM25 Worker 超时')), 30_000);
  active = { job, target, fail };
  target.addEventListener('message', onMessage);
  try { target.postMessage({ id: job.id, request: job.request }); }
  catch (error) { fail(error); }
}

/** One dispatched job owns the Worker, so cancellation can stop synchronous CPU
 * work without terminating other callers. Queued jobs stay on the main thread.
 * Only current summaries are sent; vectors and original bodies remain local. */
export function searchBm25(request: LexicalRequest, signal?: AbortSignal): Promise<LexicalResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const job: Job = { id: ++serial, request, signal, resolve, reject, onAbort: () => {
      const error = signal?.reason ?? new Error('BM25 已取消');
      if (active?.job === job) { active.fail(error); return; }
      const position = waiting.indexOf(job);
      if (position < 0) return;
      waiting.splice(position, 1);
      signal?.removeEventListener('abort', job.onAbort); reject(error);
    } };
    waiting.push(job);
    signal?.addEventListener('abort', job.onAbort, { once: true });
    if (signal?.aborted) job.onAbort();
    dispatch();
  });
}
