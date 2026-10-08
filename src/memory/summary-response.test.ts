import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySummaryResponse, requestSummaryResponse, summaryResponseError, summaryResponses } from './summary-response';
const parse = (raw: string) => {
  const value = JSON.parse(raw);
  if (typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('缺少 summary');
  return value;
};
const valid = '{"summary":"合成测试摘要"}';
beforeEach(() => summaryResponses.splice(0));
function request(overrides: Partial<Parameters<typeof requestSummaryResponse>[0]> = {}) {
  return requestSummaryResponse({ scope: 'test', title: '单楼 #1', retries: 1,
    send: vi.fn().mockResolvedValue(valid), messages: [], parse, apply: vi.fn(), guard: vi.fn(), ...overrides });
}
describe('摘要返回保留与复用', () => {
  it('保留每次失败正文；编辑校验和应用不再调用 API，应用后拒绝重复确认', async () => {
    const send = vi.fn().mockResolvedValueOnce('broken first').mockResolvedValueOnce('{"other":1}');
    const apply = vi.fn();
    await expect(request({ send, apply })).rejects.toThrow('缺少 summary');
    const record = summaryResponses[0];
    expect(record.attempts.map(a => a.raw)).toEqual(['broken first', '{"other":1}']);
    expect(record.attempts.every(a => a.kind === 'parse')).toBe(true);
    expect(summaryResponseError(record, valid)).toBe('');
    expect(apply).not.toHaveBeenCalled();
    record.attempts[0].draft = valid;
    await applySummaryResponse(record, record.attempts[0].draft);
    expect(send).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledOnce();
    expect(record.applied).toBe(true);
    await expect(applySummaryResponse(record, valid)).rejects.toThrow('不能重复');
  });
  it('区分 API 抛错、空正文与解析失败，后续 API 失败不会覆盖已有正文', async () => {
    const send = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('invalid').mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(request({ send, retries: 2 })).rejects.toThrow('HTTP 500');
    expect(summaryResponses[0].attempts.map(a => [a.kind, a.raw])).toEqual([
      ['empty', ''], ['parse', 'invalid'], ['api', null],
    ]);
  });
  it('成功请求保留所有尝试但整个请求只允许一次写入', async () => {
    const send = vi.fn().mockResolvedValueOnce('bad').mockResolvedValueOnce(valid), apply = vi.fn();
    await request({ send, apply });
    const record = summaryResponses[0];
    expect(record.attempts).toHaveLength(2);
    expect(record.applied).toBe(true);
    await expect(applySummaryResponse(record, valid)).rejects.toThrow('不能重复');
    expect(apply).toHaveBeenCalledOnce();
  });
  it('来源变动后迟到返回仍保留，但既不能立即应用也不能编辑复用', async () => {
    let live = true;
    const apply = vi.fn();
    const guard = () => { if (!live) throw new Error('来源已改变'); };
    await expect(request({ guard, apply, send: async () => { live = false; return valid; } })).rejects.toThrow('来源已改变');
    const record = summaryResponses[0];
    expect(record.attempts[0]).toMatchObject({ raw: valid, kind: 'validation', error: '来源已改变' });
    await expect(applySummaryResponse(record, valid)).rejects.toThrow('来源已改变');
    expect(apply).not.toHaveBeenCalled();
  });
  it('异步校验失败保留返回，不自动花费新请求；双击确认只有一次应用', async () => {
    let release!: () => void;
    const send = vi.fn().mockResolvedValue(valid);
    const apply = vi.fn().mockRejectedValueOnce(new Error('表格版本改变'))
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await expect(request({ send, apply })).rejects.toThrow('表格版本改变');
    const record = summaryResponses[0];
    expect(record.attempts[0].kind).toBe('validation');
    const pending = applySummaryResponse(record, valid);
    await expect(applySummaryResponse(record, valid)).rejects.toThrow('仍在进行');
    release(); await pending;
    expect(send).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it('优先保留未应用返回，全部失败超过20个时才淘汰最早失败', async () => {
    await expect(request({ retries: 0, send: async () => 'bad' })).rejects.toThrow();
    const old = summaryResponses[0];
    for (let i = 0; i < 20; i++) await request();
    expect(summaryResponses).toHaveLength(20);
    expect(summaryResponses.some(r => r.id === old.id)).toBe(true);
    for (let i = 0; i < 20; i++) await expect(request({ retries: 0, send: async () => 'bad' })).rejects.toThrow();
    expect(summaryResponses).toHaveLength(20);
    await expect(applySummaryResponse(old, valid)).rejects.toThrow('过期');
  });
});
