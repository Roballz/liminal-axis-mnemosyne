import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext } from '@/st/context';
import { apiSettings, type ApiChannel, type TaskType } from './settings';
import { ApiError, isInappropriateContentError, type ChatMsg } from './client';
import { resolveTaskSender } from './taskSender';

const rejection = 'Output data may contain inappropriate content';
const messages: ChatMsg[] = [{ role: 'user', content: 'Synthetic summary input.' },
  { role: 'assistant', content: 'Synthetic prefill.' }];
const channel = (id: string, extra: Partial<ApiChannel> = {}): ApiChannel => ({
  id, name: id, url: `https://${id}.example/v1`, key: `${id}-key`, model: `${id}-model`,
  temperature: 1, maxTokens: 1024, timeoutSec: 60, stream: false, prefill: true,
  excludeParams: [], reasoningEffort: '', ...extra,
});
const success = (text = 'Generated summary.') => Response.json({ choices: [{ message: { content: text } }] });
const sender = (task: TaskType = 'summary') => {
  const result = resolveTaskSender(task);
  if ('error' in result) throw new Error(result.error);
  return result;
};
const requests = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) => fetchMock.mock.calls.map(call => JSON.parse(call[1]?.body as string));

beforeEach(() => {
  apiSettings.channels = [channel('primary'), channel('backup')];
  apiSettings.assignments = { summary: 'primary', resummary: 'primary' };
  apiSettings.fallbacks = { summary: { enabled: true, channelId: 'backup' }, resummary: { enabled: false, channelId: '' } };
  vi.spyOn(context, 'getContext').mockReturnValue({ getRequestHeaders: () => ({}) } as STContext);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('summary task content-error fallback', () => {
  it('uses the primary alone on success, including content quoting the error phrase', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(success(`The source quotes: ${rejection}`));
    vi.stubGlobal('fetch', fetchMock);
    expect(await sender().send(messages)).toContain(rejection);
    expect(requests(fetchMock).map(body => body.model)).toEqual(['primary-model']);
  });

  it('uses one backup for a long HTTP error and retains its own request parameters', async () => {
    apiSettings.channels[1] = channel('backup', { prefill: false, temperature: 0.2, maxTokens: 2048,
      reasoningEffort: 'high', excludeParams: ['temperature'] });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(`${'prefix '.repeat(60)}${rejection}`, { status: 400 }))
      .mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetchMock);
    const guard = vi.fn();
    expect(await sender().send(messages, { beforeFallback: guard })).toBe('Generated summary.');
    const [first, second] = requests(fetchMock);
    expect([first.model, second.model]).toEqual(['primary-model', 'backup-model']);
    expect(first.messages).toEqual(messages);
    expect(second.messages).toEqual(messages.slice(0, -1));
    expect(second).toMatchObject({ custom_url: 'https://backup.example/v1', max_tokens: 2048 });
    expect(JSON.parse(second.custom_include_headers)).toEqual({ Authorization: 'Bearer backup-key' });
    expect(JSON.parse(second.custom_include_body)).toEqual({ reasoning_effort: 'high' });
    expect(second.temperature).toBeUndefined();
    expect(guard).toHaveBeenCalledOnce();
    expect(messages).toHaveLength(2);
  });

  it.each([500, 502, 503, 504])('keeps HTTP %s in the existing error flow even with the trigger', async status => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(rejection, { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sender().send(messages)).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not lose a textual upstream 503 after the displayed error is truncated', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      `${'prefix '.repeat(60)}HTTP 503: ${rejection}`, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sender().send(messages)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([false, true])('retains an upstream 503 in JSON/SSE errors (stream=%s)', async stream => {
    apiSettings.channels[0].stream = stream;
    const error = { message: rejection, code: '503' };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(stream
      ? new Response(`data: ${JSON.stringify({ error })}\n\n`) : Response.json({ error }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sender().send(messages)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('supports string JSON errors and restarts at the primary on the next send', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: rejection }))
      .mockResolvedValueOnce(success('Backup result.'))
      .mockResolvedValueOnce(success('Next primary result.'));
    vi.stubGlobal('fetch', fetchMock);
    const resolved = sender();
    expect(await resolved.send(messages)).toBe('Backup result.');
    expect(await resolved.send(messages)).toBe('Next primary result.');
    expect(requests(fetchMock).map(body => body.model)).toEqual(['primary-model', 'backup-model', 'primary-model']);
    expect(apiSettings.assignments.summary).toBe('primary');
  });

  it('cancels and releases a failed stream before starting the backup, discarding partial output', async () => {
    apiSettings.channels[0].stream = true;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial.' } }] })}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: rejection })}\n\n`));
    }, cancel });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body)).mockImplementationOnce(async () => {
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      return success('Complete backup.');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await sender().send(messages)).toBe('Complete backup.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('propagates backup failure without looping to a third call', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { message: rejection } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sender().send(messages)).rejects.toThrow(rejection);
    expect(requests(fetchMock).map(body => body.model)).toEqual(['primary-model', 'backup-model']);
  });

  it.each(['disabled', 'missing', 'same', 'incomplete'] as const)('preserves primary errors for %s backup configuration', async variant => {
    if (variant === 'disabled') apiSettings.fallbacks.summary.enabled = false;
    if (variant === 'missing') apiSettings.fallbacks.summary.channelId = 'deleted';
    if (variant === 'same') apiSettings.fallbacks.summary.channelId = 'primary';
    if (variant === 'incomplete') apiSettings.channels[1].url = '';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: rejection } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sender().send(messages)).rejects.toThrow(rejection);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps summary and higher summary fallback selections independent', async () => {
    apiSettings.fallbacks.summary.enabled = false;
    apiSettings.fallbacks.resummary = { enabled: true, channelId: 'backup' };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_, options) =>
      JSON.parse(options?.body as string).model === 'primary-model'
        ? Response.json({ error: { message: rejection } }) : success());
    vi.stubGlobal('fetch', fetchMock);
    await expect(sender('summary').send(messages)).rejects.toThrow(rejection);
    await expect(sender('resummary').send(messages)).resolves.toBe('Generated summary.');
    expect(requests(fetchMock).map(body => body.model)).toEqual(['primary-model', 'primary-model', 'backup-model']);
  });

  it('does not send stale input when the caller guard rejects before fallback', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: rejection }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sender().send(messages, { beforeFallback: () => { throw new Error('Source changed.'); } }))
      .rejects.toThrow('Source changed.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not switch after cancellation or for network/timeout errors', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      controller.abort(); return Response.json({ error: rejection });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sender().send(messages, { signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    for (const error of [new TypeError('Failed to fetch'), new ApiError('副 API 请求超时(>60秒)'),
      new DOMException(rejection, 'AbortError')]) {
      fetchMock.mockClear().mockRejectedValueOnce(error);
      await expect(sender().send(messages)).rejects.toBe(error);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it.each([rejection, new Error(rejection), { message: rejection }])('supports exposed main API failures: %s', async error => {
    apiSettings.assignments.summary = '';
    const generateRaw = vi.fn().mockRejectedValueOnce(error);
    vi.mocked(context.getContext).mockReturnValue({ generateRaw, getRequestHeaders: () => ({}) } as unknown as STContext);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(success());
    vi.stubGlobal('fetch', fetchMock);
    expect(await sender().send(messages)).toBe('Generated summary.');
    expect(generateRaw).toHaveBeenCalledOnce();
    expect(requests(fetchMock).map(body => body.model)).toEqual(['backup-model']);
  });

  it.each([{ message: rejection, status: 500 }, { message: rejection, statusCode: '502' },
    { message: rejection, response: { status: 504 } }, new Error(`HTTP 503: ${rejection}`), `503: ${rejection}`])
  ('rejects main API 5xx failures without switching: %s', async error => {
    apiSettings.assignments.summary = '';
    vi.mocked(context.getContext).mockReturnValue({ generateRaw: vi.fn().mockRejectedValue(error) } as unknown as STContext);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sender().send(messages)).rejects.toBe(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never broadens matching to generic content filter errors', () => {
    expect(isInappropriateContentError(new ApiError('Content policy violation'))).toBe(false);
    expect(isInappropriateContentError(new ApiError('Input data may contain inappropriate content'))).toBe(false);
  });
});
