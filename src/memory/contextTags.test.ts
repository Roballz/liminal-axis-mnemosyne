import { afterEach, expect, it, vi } from 'vitest';
import { generatedTags, normalizeTags, validTags } from './contextTags';
import { deriveMemory, finalizeDelta } from './apply';
import { fmtPlans } from './prompts';
import type { STMessage } from '@/st/context';
import { parseResponse } from './vector/rewrite';
afterEach(() => vi.restoreAllMocks());

it('计划中途更新按稳定ID回放，50字限长、清空未决项、保留关联来源和历史截止', () => {
  const id = 'plan:origin#0';
  const first = { id: 'origin', v: 1, createdAt: 1, delta: { plans: { add: [{ kind: 'suspense', content: '查明玉佩来源', title: '玉佩来源', currentProgress: '发现玉佩', remaining: '主人是谁' }] } } };
  const delta = finalizeDelta({ plans: { update: [{ id, currentProgress: '新线索'.repeat(30), remaining: '' }] } }, [{ id }]);
  const chat = [
    { mes: '正文1', extra: { bbs_leaf: first } },
    { mes: '正文2', extra: { bbs_leaf: { id: 'next', v: 1, createdAt: 2, timeEnd: '2026/9/25 12:00', delta, tags: normalizeTags({ planIds: [id] }) } } },
  ] as unknown as STMessage[];
  const before = deriveMemory(chat, 1).plans[0], after = deriveMemory(chat).plans[0];
  expect(before.currentProgress).toBe('发现玉佩');
  expect(after.currentProgress).toHaveLength(50);
  expect(after.remaining).toBe('');
  expect(after.progressTime).toBe('2026/9/25 12:00');
  expect(after.relatedLeafIds).toEqual(['origin', 'next']);
  expect(fmtPlans([after])).toContain(`[${id}]`);
  const resolved = finalizeDelta({ plans: { resolve: [{ id, outcome: 'done', reason: '查明归属' }] } }, [{ id }]);
  expect(resolved.plans?.resolve).toEqual([{ id, outcome: 'done', reason: '查明归属' }]);
  expect(finalizeDelta({ plans: { update: [{ id: 'invented', currentProgress: '伪造' }] } }, [{ id }]).plans).toBeUndefined();
});

it('模型不能公开摘要、不能编造关联，人物未知与明确空名单分别保留', () => {
  const tags = generatedTags({ participants: ['甲', '甲'], planIds: ['p1', 'fake'], eventIds: ['E', 'fake'], public: { reason: '模型猜测' } }, [{ id: 'P' }], [{ id: 'E', title: '事项', status: 'open' }])!;
  expect(tags).toEqual({ version: 1, participants: ['甲'], planIds: ['P'], eventIds: ['E'] });
  expect(normalizeTags({})?.participants).toBeUndefined();
  expect(normalizeTags({ participants: [] })?.participants).toEqual([]);
  expect(validTags(tags)).toBe(true);
  expect(validTags({ ...tags, public: { reason: '' } })).toBe(false);
  expect(generatedTags({}, [], [], { ...tags, public: { reason: '直播泄露' } })?.public?.reason).toBe('直播泄露');
});

it('Query 的标识不混入查询，六条Q之后的CONTEXT仍解析，坏标识不破坏正常检索', () => {
  const queries = Array.from({ length: 6 }, (_, i) => `Q: 过去的线索${i}`).join('\n');
  const result = parseResponse(`INTENT: 找线索\n${queries}\nCONTEXT: {"participants":["甲"],"planIds":["P"],"eventIds":[]}`);
  expect(result.queries).toHaveLength(6);
  expect(result.context?.planIds).toEqual(['P']);
  expect(parseResponse('INTENT: 找线索\nQ: 旧线索\nCONTEXT: 坏JSON')).toEqual({ intent: '找线索', queries: ['旧线索'] });
});

it('正文注入使用50字内容和短序号，内部整理仍能识别稳定ID', async () => {
  const { buildStateInjectionText } = await import('./inject');
  const { memory } = await import('./store');
  const { createEmptyMemory } = await import('./types');
  const { apiSettings } = await import('@/api/settings');
  const delta = finalizeDelta({ plans: { add: [{ kind: 'suspense', content: '内容'.repeat(40), title: '不能替代内容', currentProgress: '找到证据' }] } }, []);
  expect(delta.plans?.add?.[0].content).toHaveLength(50);
  expect(delta.plans?.add?.[0].title).toBeUndefined();
  const plan = { id: 'plan:old#0', kind: 'suspense' as const, status: 'open' as const, content: '查明玉佩来源及失主身份', title: '旧短标题', currentProgress: '找到证据', createdAt: 1 };
  Object.assign(memory, createEmptyMemory(), { plans: [plan] });
  expect(fmtPlans([plan])).toContain('[plan:old#0]');
  for (const debug of [false, true]) {
    apiSettings.ui.showInternalIds = debug;
    const text = buildStateInjectionText();
    expect(text).toContain('p1. [悬念] 查明玉佩来源及失主身份');
    expect(text).not.toContain('plan:old#0');
    expect(text).not.toContain('旧短标题');
  }
  apiSettings.ui.showInternalIds = false;
  Object.assign(memory, createEmptyMemory());
});

it('批量公开一次重算并保留标签，任一摘要改变时整批不写入', async () => {
  const { editLeafTagsBatch, getLeaf } = await import('./apply');
  const { derivedMeta } = await import('./store');
  const context = await import('@/st/context');
  const chat = Array.from({ length: 80 }, (_, i) => ({ name: '合成角色', is_user: false, is_system: false, mes: `合成正文${i}`,
    extra: { bbs_leaf: { id: `bulk-${i}`, text: `合成摘要${i}`, delta: {}, v: 1 as const, swipe: 0, createdAt: 1,
      tags: normalizeTags({ participants: ['甲'], planIds: ['plan:test#0'], eventIds: ['ev_test'] }) } },
  }));
  vi.useFakeTimers();
  vi.spyOn(context, 'getContext').mockReturnValue({ chat, chatMetadata: {}, getCurrentChatId: () => 'synthetic-bulk' } as any);
  try {
    const edits = chat.map((m, index) => ({ index, expectedId: m.extra.bbs_leaf.id,
      tags: { ...m.extra.bbs_leaf.tags!, public: { reason: '人工批量公开' } } }));
    const rev = derivedMeta.rev;
    expect(editLeafTagsBatch([...edits.slice(0, -1), { ...edits.at(-1)!, expectedId: 'changed' }])).toBe(false);
    expect(chat.every(m => !getLeaf(m)?.tags?.public)).toBe(true);
    expect(derivedMeta.rev).toBe(rev);
    expect(editLeafTagsBatch(edits)).toBe(true);
    expect(derivedMeta.rev).toBe(rev + 1);
    expect(chat.every(m => getLeaf(m)?.tags?.public?.reason === '人工批量公开')).toBe(true);
    expect(getLeaf(chat[0])?.tags).toMatchObject({ participants: ['甲'], planIds: ['plan:test#0'], eventIds: ['ev_test'] });
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});
