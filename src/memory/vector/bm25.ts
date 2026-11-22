import SearchWorker from './bm25.worker?worker&inline';
import type { LexicalDocument, LexicalRequest, LexicalResult, LexicalWorkerRequest } from './bm25-index';

type Job = {
  id: number; request: LexicalRequest; documentVersion?: string; signal?: AbortSignal;
  resolve: (value: LexicalResult) => void; reject: (error: unknown) => void; onAbort: () => void;
};
let worker: Worker | undefined;
let serial = 0;
type Acknowledged = { database: string; scope: string; documents: Map<string, string>; version?: string };
let acknowledged: Acknowledged | undefined;

function prepare(job: Job): { request: LexicalWorkerRequest; next: Acknowledged } {
  const { database, scope, queries, exclude, topK } = job.request;
  const query = { database, scope, queries, exclude, topK };
  const prior = acknowledged?.database === database && acknowledged.scope === scope ? acknowledged : undefined;
  if (prior && job.documentVersion !== undefined && prior.version === job.documentVersion)
    return { request: { ...query, documents: [], removed: [] }, next: prior };
  const documents = new Map<string, string>();
  const changed: LexicalDocument[] = [];
  for (const doc of job.request.documents) {
    documents.set(doc.id, doc.text);
    if (prior?.documents.get(doc.id) !== doc.text) changed.push(doc);
  }
  const removed: string[] | undefined = prior ? [] : undefined;
  if (prior && removed) for (const id of prior.documents.keys()) if (!documents.has(id)) removed.push(id);
  return { request: { ...query, documents: changed, removed },
    next: { database, scope, documents, version: job.documentVersion } };
}
const waiting: Job[] = [];
let active: { job: Job; target: Worker; fail: (error: unknown) => void } | undefined;

function discard(target: Worker): void {
  target.terminate();
  if (worker === target) { worker = undefined; acknowledged = undefined; }
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
  let next: Acknowledged;
  const onMessage = (event: MessageEvent<{ id: number; result: LexicalResult; error?: string }>) => {
    if (event.data.id !== job.id) return;
    if (event.data.error !== undefined) fail(new Error(event.data.error));
    else { acknowledged = next; finish({ result: event.data.result }); }
  };
  const timer = setTimeout(() => fail(new Error('BM25 Worker 超时')), 30_000);
  active = { job, target, fail };
  target.addEventListener('message', onMessage);
  try {
    const prepared = prepare(job);
    next = prepared.next;
    target.postMessage({ id: job.id, request: prepared.request });
  }
  catch (error) { fail(error); }
}

/** One dispatched job owns the Worker, so cancellation can stop synchronous CPU
 * work without terminating other callers. Queued jobs stay on the main thread.
 * Only current summaries are sent; vectors and original bodies remain local. */
export function searchBm25(request: LexicalRequest, signal?: AbortSignal, documentVersion?: string): Promise<LexicalResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const job: Job = { id: ++serial, request, documentVersion, signal, resolve, reject, onAbort: () => {
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
