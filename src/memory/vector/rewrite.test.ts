import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import * as host from '@/st/context';
import type { STMessage } from '@/st/context';
import * as bridge from '@/mnemosyne/bridge';
import * as engine from '../engine';
import * as transport from './embed';
import { JAILBREAK_PROMPT } from '../prompts';
import { memory } from '../store';
import { createEmptyMemory } from '../types';
import { parseResponse, rewriteQuery } from './rewrite';

const originalSettings = JSON.parse(JSON.stringify(apiSettings));
const message = (is_user: boolean, mes: string): STMessage => ({ name: is_user ? '合成人物甲' : '合成人物乙', is_user, is_system: false, mes, extra: {} });
beforeEach(() => {
  Object.assign(memory, createEmptyMemory());
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('测试禁止真实网络请求'); }));
});
afterEach(() => {
  Object.assign(apiSettings, JSON.parse(JSON.stringify(originalSettings)));
  Object.assign(memory, createEmptyMemory());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each([220, 221, 359, 360, 361])('INTENT 输入 %i 字保留到360,Q仍截到220且去重', length => {
  const raw = '景'.repeat(length);
  const q = '线'.repeat(220);
  const parsed = parseResponse(`<think>INTENT: 不采用的推理</think>\n- INTENT: “${raw}”\nQ: ${q}多余\nQ: ${q}重复\nCONTEXT: {"participants":["甲"],"eventIds":["E"]}`);
  expect(parsed.intent).toBe(raw.slice(0, 360));
  expect(parsed.queries).toEqual([q]);
  expect(parsed.context).toEqual({ participants: ['甲'], planIds: [], eventIds: ['E'] });
});

it.each([
  { enabled: false, custom: '', expected: '' },
  { enabled: true, custom: '', expected: JAILBREAK_PROMPT },
  { enabled: true, custom: '  自定义核心  ', expected: '自定义核心' },
])('Query 破限开关=$enabled 时保留自定义优先级、CONTEXT/目录与重生成边界', async ({ enabled, custom, expected }) => {
  const chat = [message(true, '已发生的问题'), message(false, '已发生的答复'), message(true, '最新输入'), message(false, '本轮待替换答复')];
  vi.spyOn(host, 'getContext').mockReturnValue({ chat, name1: '合成人物甲', name2: '合成人物乙', getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) } as any);
  vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(0);
  vi.spyOn(bridge, 'currentEventHints').mockReturnValue([{ id: 'E', title: '合成事件', status: 'open' }]);
  Object.assign(apiSettings.vector.queryRewrite, { url: 'https://synthetic.invalid/v1', key: '', model: 'synthetic', retries: 0 });
  apiSettings.vector.queryRewriteJailbreak = enabled;
  apiSettings.vector.recall.rrfContextEnabled = true;
  apiSettings.prompts.jailbreak = custom;
  const send = vi.spyOn(transport, 'fetchWithTimeoutRetry').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: {
    content: `INTENT: ${'场'.repeat(361)}\nQ: 已发生的往事\nCONTEXT: {"participants":["合成人物甲"],"eventIds":["E","不存在"]}`,
  } }] })));
  const result = await rewriteQuery();
  const messages = JSON.parse(send.mock.calls[0][1].body as string).messages;
  expect(messages.filter((m: any) => m.role === 'system')).toHaveLength(1);
  expect(messages[0].content.startsWith(expected || '你是角色扮演续写场景中的上下文规划器。')).toBe(true);
  if (!expected || custom) expect(messages[0].content).not.toContain('<nvwa_standalone_core>');
  expect(messages[0].content).toContain('可引用事项目录');
  expect(messages[0].content).toContain('合成事件');
  expect(messages.at(-1).content).toContain('CONTEXT:');
  expect(JSON.stringify(messages)).toContain('最新输入');
  expect(JSON.stringify(messages)).not.toContain('本轮待替换答复');
  expect(result.intent).toHaveLength(360);
  expect(result.context?.eventIds).toEqual(['E']);
  expect(apiSettings.prompts.jailbreak).toBe(custom);
  expect(fetch).not.toHaveBeenCalled();
});
