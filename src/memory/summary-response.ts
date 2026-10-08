/** Session-local API bodies. No credentials, prompts, telemetry or persistent chat fields. */
import { reactive } from 'vue';
import type { ChatMsg } from '@/api/client';
export interface SummaryAttempt {
  raw: string | null;
  draft?: string;
  error: string;
  kind: 'api' | 'empty' | 'parse' | 'validation' | 'ready' | 'ok';
}
export interface SummaryResponse {
  id: number;
  scope: string;
  title: string;
  attempts: SummaryAttempt[];
  applied: boolean;
  running: boolean;
}
export const summaryResponses = reactive<SummaryResponse[]>([]);
export const summaryResponseUi = reactive({ selectedId: 0, attempt: 0 });
let sequence = 0;
const operations = new Map<number, { parse: (raw: string) => unknown; apply: (value: any) => Promise<void>; guard: () => void }>();
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export function summaryResponseError(record: SummaryResponse, text: string): string {
  try {
    const operation = operations.get(record.id);
    if (!operation) throw new Error('返回记录已过期');
    operation.parse(text);
    return '';
  } catch (e) { return message(e); }
}
export async function applySummaryResponse(record: SummaryResponse, text: string): Promise<void> {
  if (record.running) throw new Error('本次请求或保存仍在进行');
  if (record.applied) throw new Error('本次返回已应用，不能重复写入');
  const operation = operations.get(record.id);
  if (!operation) throw new Error('返回记录已过期');
  record.running = true;
  try {
    operation.guard();
    const value = operation.parse(text);
    await operation.apply(value);
    record.applied = true;
  } finally { record.running = false; }
}
export async function requestSummaryResponse<T>(options: {
  scope: string; title: string; retries: number; preview?: boolean; reviewFailures?: boolean;
  send: (messages: ChatMsg[]) => Promise<string>; messages: ChatMsg[];
  parse: (raw: string) => T; apply: (value: T) => Promise<void>; guard: () => void;
}): Promise<T> {
  const record: SummaryResponse = reactive({ id: ++sequence, scope: options.scope, title: options.title,
    attempts: [], applied: false, running: true });
  summaryResponses.unshift(record);
  operations.set(record.id, { parse: options.parse, apply: options.apply, guard: options.guard });
  // Bound retained request contexts as well as bodies; closing a panel does not discard them.
  while (summaryResponses.length > 20) {
    const success = summaryResponses.findLastIndex(r => r.applied && !r.running);
    const index = success >= 0 ? success : summaryResponses.length - 1;
    operations.delete(summaryResponses.splice(index, 1)[0].id);
  }
  let lastError: unknown;
  try {
    for (let n = 0; n <= options.retries; n++) {
      options.guard();
      const attempt: SummaryAttempt = reactive({ raw: null, error: '', kind: 'api' });
      record.attempts.push(attempt);
      let value: T;
      try {
        attempt.raw = await options.send(options.messages);
        attempt.kind = attempt.raw.trim() ? 'parse' : 'empty';
        value = options.parse(attempt.raw);
      } catch (e) {
        attempt.error = message(e); lastError = e;
        continue;
      }
      try {
        options.guard();
        if (options.preview) {
          attempt.kind = 'ready';
          return value;
        }
        await options.apply(value);
        record.applied = true;
        attempt.kind = 'ok';
        return value;
      } catch (e) {
        attempt.kind = 'validation'; attempt.error = message(e);
        throw e; // A commit/validation error must never silently trigger another API call.
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    record.running = false;
    if ((options.preview || (options.reviewFailures && !record.applied)) && record.attempts.length) {
      summaryResponseUi.selectedId = record.id;
      summaryResponseUi.attempt = record.attempts.length - 1;
    }
  }
}
