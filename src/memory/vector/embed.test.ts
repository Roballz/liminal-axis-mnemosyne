import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import { embedTexts, fetchWithTimeoutRetry, rerankDocuments } from './embed';

const options = { timeoutSec: 10, retries: 0, label: 'embedding' };
const stalledBody = () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); },
}));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('响应头已到但正文悬挂：完整等到配置超时，取消请求并结束等待', async () => {
  let requestSignal: AbortSignal;
  vi.stubGlobal('fetch', vi.fn((_url, init) => {
    requestSignal = init.signal;
    return Promise.resolve(stalledBody());
  }));
  let settled = false;
  const result = fetchWithTimeoutRetry('https://example.test', {}, options);
  const checked = expect(result).rejects.toThrow('embedding超时(>10s)');
  void result.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(9999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await checked;
  expect(requestSignal!.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('正文超时也按配置重试，下一次完整响应可正常解析', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(stalledBody()).mockResolvedValueOnce(Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetcher);
  const result = fetchWithTimeoutRetry('https://example.test', {}, { ...options, retries: 1 });
  await vi.advanceTimersByTimeAsync(10800);
  expect(await (await result).json()).toEqual({ data: [] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('外部取消可结束不响应 AbortSignal 的请求，且不发起重试', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const result = fetchWithTimeoutRetry('https://example.test', {}, { ...options, retries: 2, externalSignal: controller.signal });
  const checked = expect(result).rejects.toThrow('已取消');
  controller.abort();
  await checked;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('重试退避中取消立即结束，不再等待或重试', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const result = fetchWithTimeoutRetry('https://example.test', {}, { ...options, retries: 2, externalSignal: controller.signal });
  const checked = expect(result).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await checked;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([{ data: [] }, { data: [{ index: 0, embedding: [] }] }, { data: [{ index: 0, embedding: [null] }] }])(
  'embedding 的空结果或无效向量明确报错: %j', async ({ data }) => {
    vi.spyOn(settings, 'resolveVectorModel').mockReturnValue({ url: 'https://example.test', model: 'test', key: '', ...options });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data })));
    await expect(embedTexts(['合成查询'])).rejects.toThrow('向量数据无效');
  },
);

it('rerank 空结果明确报错，不假装成功', async () => {
  vi.spyOn(settings, 'resolveVectorModel').mockReturnValue({ url: 'https://example.test', model: 'test', key: '', ...options });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ results: [] })));
  await expect(rerankDocuments('查询', ['合成原文'], 1)).rejects.toThrow('返回为空');
});

it('一个 rerank 批次失败时取消其他在途批次，不遗留请求', async () => {
  vi.spyOn(settings, 'resolveVectorModel').mockReturnValue({ url: 'https://example.test', model: 'test', key: '', ...options });
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((_url, init) => {
    signals.push(init.signal);
    return Promise.resolve(signals.length === 1 ? Response.json({}, { status: 400 }) : stalledBody());
  }));
  await expect(rerankDocuments('查询', ['合成'.repeat(9000), '原文'.repeat(9000)], 2)).rejects.toThrow('rerank API 400');
  expect(signals.length).toBeGreaterThan(1);
  expect(signals.slice(1).every(s => s.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
