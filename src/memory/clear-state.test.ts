import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { apiSettings } from '@/api/settings';
import { deriveMemory, editNpc, finalizeDelta } from './apply';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type NpcDelta, type StoredDelta, type SummaryDelta } from './types';

const originalSummaryOnly = apiSettings.summaryOnlyMode;
const initialNpc: NpcDelta = {
  name: '合成角色', outfit: '旧外套', condition: '轻伤', age: '24', ageTime: '2026/1/1',
  follow: false, location: '旧城', important: true, affinityInner: 1, affinityOuter: -1,
};
let seq = 0;
function message(delta: StoredDelta = {}): STMessage {
  return { name: 'Character', is_user: false, is_system: false, mes: `合成原文 ${++seq}`, swipe_id: 0,
    extra: { bbs_leaf: { id: `clear-${seq}`, text: '合成摘要', delta, createdAt: seq, swipe: 0, v: 1 } } };
}
function useChat(chat: STMessage[]) {
  vi.spyOn(context, 'getContext').mockReturnValue({
    chat, chatMetadata: {}, name1: 'User', name2: 'Character', getCurrentChatId: () => 'clear-state-test',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
  } as unknown as STContext);
  recomputeDerived();
}
function sourceOf(chat: STMessage[]) {
  return chat.map(m => ({ mes: m.mes, swipe: m.swipe_id, text: m.extra?.bbs_leaf?.text }));
}
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  apiSettings.summaryOnlyMode = false;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  apiSettings.summaryOnlyMode = originalSummaryOnly;
  Object.assign(memory, createEmptyMemory());
});

describe('手动 NPC 即时层清空', () => {
  const cases: [string, Parameters<typeof editNpc>[1], Pick<NpcDelta, 'outfit' | 'condition'>][] = [
    ['明确空串', { outfit: '', condition: '' }, { outfit: undefined, condition: undefined }],
    ['仅空白', { outfit: ' \t ', condition: '\n ' }, { outfit: undefined, condition: undefined }],
    ['仅清衣着', { outfit: '' }, { outfit: undefined, condition: '轻伤' }],
    ['仅清状态', { condition: '' }, { outfit: '旧外套', condition: undefined }],
    ['未提供', { title: '新称谓' }, { outfit: '旧外套', condition: '轻伤' }],
    ['非空覆盖', { outfit: ' 新外套 ', condition: ' 健康 ' }, { outfit: '新外套', condition: '健康' }],
  ];
  it.each(cases)('%s 保留补丁语义并经 JSON 重放', (_label, patch, expected) => {
    const chat = [message({ npcs: { add: [{ ...initialNpc }] } }), message()];
    const prior = roundTrip(chat[0]);
    const source = sourceOf(chat);
    const originalPatch = { ...patch };
    useChat(chat);

    expect(editNpc(initialNpc.name, patch)).toBe(true);
    const saved = chat[1].extra!.bbs_leaf!.delta.npcs!.update!.at(-1)!;
    for (const key of ['outfit', 'condition'] as const) {
      expect(saved[key]).toBe(patch[key] !== undefined ? patch[key].trim() : initialNpc[key]);
    }
    expect(memory.npcs).toHaveLength(1);
    expect(memory.npcs[0]).toMatchObject({ ...initialNpc, ...expected, ...(patch.title ? { title: patch.title } : {}) });
    const replayed = deriveMemory(roundTrip(chat));
    expect(replayed.npcs).toEqual(memory.npcs);
    expect(deriveMemory(roundTrip(chat)).npcs).toEqual(replayed.npcs);
    expect(deriveMemory(chat, 1).npcs[0]).toMatchObject(initialNpc);
    expect(chat[0]).toEqual(prior);
    expect(sourceOf(chat)).toEqual(source);
    expect(patch).toEqual(originalPatch);
  });

  it('改名时未提供的即时层继承旧值,显式清空仍保留在新增指令', () => {
    const chat = [message({ npcs: { add: [{ ...initialNpc }] } }), message()];
    const source = sourceOf(chat);
    const prior = roundTrip(chat[0]);
    useChat(chat);
    expect(editNpc(initialNpc.name, { name: '合成新名' })).toBe(true);
    expect(memory.npcs).toHaveLength(1);
    expect(memory.npcs[0]).toMatchObject({ ...initialNpc, name: '合成新名' });
    expect(editNpc('合成新名', { name: initialNpc.name, outfit: '', condition: '' })).toBe(true);
    const saved = chat[1].extra!.bbs_leaf!.delta.npcs!.add!.at(-1)!;
    expect(saved).toMatchObject({ name: initialNpc.name, outfit: '', condition: '' });
    expect(memory.npcs).toHaveLength(1);
    expect(memory.npcs[0]).toMatchObject({ ...initialNpc, outfit: undefined, condition: undefined });
    expect(deriveMemory(roundTrip(chat)).npcs).toEqual(memory.npcs);
    expect(chat[0]).toEqual(prior);
    expect(sourceOf(chat)).toEqual(source);
  });
});

describe('固化定位路径清空', () => {
  const initialPath = ['旧城', '客栈'];
  const cases: [string, SummaryDelta, string[] | undefined][] = [
    ['明确空数组', { locationPath: [] }, undefined],
    ['未提供', {}, initialPath],
    ['显式 undefined', { locationPath: undefined }, initialPath],
    ['非空路径规范化', { locationPath: [' 新城 ', '', ' 北门 '] }, ['新城', '北门']],
  ];
  it.each(cases)('%s 经固化和 JSON 重放不混淆清空与未提供', (_label, input, expectedPath) => {
    const originalInput = { ...input, ...(input.locationPath ? { locationPath: [...input.locationPath] } : {}) };
    const delta = finalizeDelta(input, []);
    if (input.locationPath === undefined) expect(delta).not.toHaveProperty('locationPath');
    else expect(delta.locationPath).toEqual(expectedPath ?? []);
    expect(input).toEqual(originalInput);

    const chat = [message({ location: '客栈', locationPath: [...initialPath], time: '2026/1/1',
      npcs: { add: [{ ...initialNpc }] } }), message(roundTrip(delta))];
    const before = roundTrip(chat);
    const replayed = deriveMemory(chat);
    expect(replayed.state.locationPath).toEqual(expectedPath);
    expect(replayed.state.location).toBe('客栈');
    expect(replayed.state.time).toBe('2026/1/1');
    expect(replayed.npcs[0]).toMatchObject(initialNpc);
    expect(deriveMemory(roundTrip(chat))).toEqual(replayed);
    expect(deriveMemory(chat, 1).state.locationPath).toEqual(initialPath);
    expect(chat).toEqual(before);
  });

  it('明确更换地点但不提供路径时,仍清掉旧地点的路径', () => {
    const delta = finalizeDelta({ location: '新城' }, []);
    const chat = [message({ location: '客栈', locationPath: [...initialPath] }), message(roundTrip(delta))];
    const before = roundTrip(chat);
    expect(delta).not.toHaveProperty('locationPath');
    expect(deriveMemory(chat).state).toMatchObject({ location: '新城', locationPath: undefined });
    expect(chat).toEqual(before);
  });
});
