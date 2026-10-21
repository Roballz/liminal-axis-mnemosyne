import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiSettings, type ApiChannel } from '@/api/settings';
import { requestCompletion } from '@/api/client';
import * as host from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as bridge from '@/mnemosyne/bridge';
import * as engine from '../engine';
import { memory } from '../store';
import { createEmptyMemory } from '../types';
import { rewriteQuery } from './rewrite';

const original = JSON.parse(JSON.stringify(apiSettings));
const HOST_URL = '/api/backends/chat-completions/generate';
const response = () => Response.json({ choices: [{ message: { content: 'INTENT: 当前合成场景\nQ: 合成历史' } }] });
let ctx: STContext;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  ctx = { chat: [{ is_user: true, is_system: false, name: '甲', mes: '合成问题', extra: {} } as STMessage],
    getRequestHeaders: vi.fn(() => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic-csrf' })),
    generateRaw: vi.fn(), setExtensionPrompt: vi.fn(),
  } as unknown as STContext;
  vi.spyOn(host, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(0);
  vi.spyOn(bridge, 'currentEventHints').mockReturnValue([]);
  Object.assign(apiSettings.vector.queryRewrite, {
    url: 'http://127.0.0.1:8787/merge/v1', model: 'deepseek/deepseek-v4.1-flash',
    key: 'synthetic:#{"quoted"}', timeoutSec: 2, retries: 1,
  });
  apiSettings.vector.queryRewriteMaxTokens = 4096;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response()));
});
afterEach(() => {
  Object.assign(apiSettings, JSON.parse(JSON.stringify(original)));
  Object.assign(memory, createEmptyMemory());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const request = () => JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);

// JS 协议模型,不是运行 TT Rust:按 TT 007abf7 的 OpenAI allowlist、DeepSeek 补充和最终 overrides 顺序。
function hostWire(body: Record<string, any>) {
  const wire: Record<string, unknown> = {};
  for (const key of ['model', 'messages', 'temperature', 'top_p', 'max_tokens', 'stream']) wire[key] = body[key];
  wire.thinking = { type: 'enabled' }; // TT 根据 DeepSeek v4 模型名新增,与 enable_thinking 无关。
  Object.assign(wire, JSON.parse(body.custom_include_body));
  for (const key of JSON.parse(body.custom_exclude_body)) delete wire[key];
  return wire;
}

it('只发宿主 quiet 请求,CSRF 与上游鉴权隔离;最终参数与旧 Query 请求一致', async () => {
  const result = await rewriteQuery();
  expect(result.queries).toEqual(['合成历史']);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe(HOST_URL); expect(init!.method).toBe('POST');
  expect(init!.headers).toEqual({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic-csrf' });
  const body = request();
  expect(body).toMatchObject({ chat_completion_source: 'custom', custom_api_format: 'openai_compat',
    custom_url: 'http://127.0.0.1:8787/merge/v1', type: 'quiet', tool_choice: 'none' });
  expect(JSON.parse(body.custom_include_headers)).toEqual({ Authorization: 'Bearer synthetic:#{"quoted"}' });
  expect(body.proxy_password).toBeUndefined();
  expect(hostWire(body)).toEqual({ model: 'deepseek/deepseek-v4.1-flash', messages: body.messages,
    temperature: .1, top_p: .8, max_tokens: 4096, stream: false, enable_thinking: false });
  expect(ctx.generateRaw).not.toHaveBeenCalled(); expect(ctx.setExtensionPrompt).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['http://127.0.0.1:8787/merge/v1/', 'http://127.0.0.1:8787/merge/v1'],
  ['https://synthetic.invalid', 'https://synthetic.invalid'],
  ['https://synthetic.invalid/v1/chat/completions/', 'https://synthetic.invalid/v1'],
  ['https://synthetic.invalid/custom/embeddings', 'https://synthetic.invalid/custom'],
])('地址 %s 保留原 Query 规整语义,不借用摘要补 /v1', async (url, base) => {
  apiSettings.vector.queryRewrite.url = url;
  await rewriteQuery(); expect(request().custom_url).toBe(base);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('URL/key 留空仍只复用 embedding 相应字段,模型和token独立;真正空key明确覆盖宿主secret', async () => {
  Object.assign(apiSettings.vector.embedding, { url: 'https://embedding.invalid/base', key: 'synthetic-base', model: 'never-query', timeoutSec: 99, retries: 8 });
  Object.assign(apiSettings.vector.queryRewrite, { url: '', key: '' });
  await rewriteQuery();
  expect(request().custom_url).toBe('https://embedding.invalid/base');
  expect(JSON.parse(request().custom_include_headers).Authorization).toBe('Bearer synthetic-base');
  expect(request().model).toBe('deepseek/deepseek-v4.1-flash'); expect(request().max_tokens).toBe(4096);
  vi.mocked(fetch).mockClear(); apiSettings.vector.embedding.key = '';
  await rewriteQuery(); expect(JSON.parse(request().custom_include_headers)).toEqual({ Authorization: 'Bearer ' });
});

it.each([400, 401, 403])('宿主可读 HTTP %i 直接报错、不重试、不回退直连', async status => {
  vi.mocked(fetch).mockResolvedValue(new Response('synthetic failure', { status }));
  await expect(rewriteQuery()).rejects.toThrow(`Query 重写 API ${status}: synthetic failure`);
  expect(fetch).toHaveBeenCalledTimes(1); expect(vi.mocked(fetch).mock.calls[0][0]).toBe(HOST_URL);
});

it.each([429, 502])('宿主 HTTP %i 保留原重试次数和800ms退避,不猜测原始上游状态', async status => {
  vi.mocked(fetch).mockImplementation(async () => new Response('synthetic host error', { status }));
  const pending = rewriteQuery(); const checked = expect(pending).rejects.toThrow(`Query 重写 API ${status}`);
  await vi.advanceTimersByTimeAsync(799); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await checked;
  expect(fetch).toHaveBeenCalledTimes(2); expect(vi.mocked(fetch).mock.calls.every(([url]) => url === HOST_URL)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['network', 'body'])('%s 失败按既有网络策略重试,成功后正常解析', async mode => {
  vi.mocked(fetch).mockImplementationOnce(() => mode === 'network'
    ? Promise.reject(new TypeError('synthetic fetch failure'))
    : Promise.resolve(new Response(new ReadableStream({ start(c) { c.error(new Error('synthetic read failure')); } }))));
  const pending = rewriteQuery(); await vi.advanceTimersByTimeAsync(800);
  expect((await pending).queries).toEqual(['合成历史']); expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  ['not json', 'Query 重写返回无效 JSON'],
  [JSON.stringify({ error: { message: 'synthetic application error' } }), 'Query 重写 API 返回错误:synthetic application error'],
  [JSON.stringify({ choices: [{ message: { content: '' } }] }), 'Query 重写返回空内容'],
  [JSON.stringify({ choices: [{ message: { content: '没有Q行' } }] }), 'Query 重写未解析出任何检索 query'],
])('响应解析失败不发第二次请求: %s', async (body, error) => {
  vi.mocked(fetch).mockResolvedValue(new Response(body));
  await expect(rewriteQuery()).rejects.toThrow(error); expect(fetch).toHaveBeenCalledTimes(1);
});

it('读body超时仍按Query自己的超时/重试配置,不采用embedding或主API值', async () => {
  vi.mocked(fetch).mockImplementationOnce(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } })));
  const pending = rewriteQuery();
  await vi.advanceTimersByTimeAsync(1999); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(801);
  expect((await pending).queries).toEqual(['合成历史']); expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(true);
});

it('Query与摘要同时在途,取消Query只中止自己的signal且绝不重试或全局停止', async () => {
  const complete: ((value: Response) => void)[] = [];
  vi.mocked(fetch).mockImplementation(() => new Promise<Response>(resolve => complete.push(resolve)));
  const controller = new AbortController();
  const a = rewriteQuery(controller.signal); const checked = expect(a).rejects.toThrow('Query 重写已取消');
  const channel: ApiChannel = { id: 'synthetic-summary', name: '合成摘要', url: 'https://summary.invalid/v1', key: '', model: 'summary-model',
    temperature: 1, maxTokens: 512, timeoutSec: 60, stream: false, prefill: true, excludeParams: [], reasoningEffort: '' };
  const b = requestCompletion(channel, [{ role: 'user', content: '合成摘要材料' }]);
  expect(fetch).toHaveBeenCalledTimes(2);
  const aSignal = vi.mocked(fetch).mock.calls[0][1]!.signal!, bSignal = vi.mocked(fetch).mock.calls[1][1]!.signal!;
  expect(aSignal).not.toBe(bSignal); controller.abort(); await checked;
  expect(aSignal.aborted).toBe(true); expect(bSignal.aborted).toBe(false);
  complete[1](Response.json({ choices: [{ message: { content: '合成摘要结果' } }] }));
  expect(await b).toBe('合成摘要结果');
  complete[0](response()); await vi.advanceTimersByTimeAsync(5000);
  expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});

it('取消已发生或发生在退避期间都不重试', async () => {
  const before = new AbortController(); before.abort();
  await expect(rewriteQuery(before.signal)).rejects.toThrow('已取消'); expect(fetch).not.toHaveBeenCalled();
  const during = new AbortController(); vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 502 }));
  const pending = rewriteQuery(during.signal); const checked = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1); during.abort(); await checked; await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it('宿主接口缺失明确报错,不偷偷直连供应商', async () => {
  ctx.getRequestHeaders = undefined as any;
  await expect(rewriteQuery()).rejects.toThrow('Query 重写宿主请求接口不可用'); expect(fetch).not.toHaveBeenCalled();
});
