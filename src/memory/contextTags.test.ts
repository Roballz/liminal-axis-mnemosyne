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
