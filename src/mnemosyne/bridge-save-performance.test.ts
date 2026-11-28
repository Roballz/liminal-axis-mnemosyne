import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { saveMemberships } from './event-memberships';
import { membershipBadges } from './event-membership-ui';
import { computed } from 'vue';
import * as client from '@/api/client';
import { apiSettings } from '@/api/settings';
import { checkResummary, engineState, recoverSummaryResponse } from '@/memory/engine';
import { summaryResponses } from '@/memory/summary-response';
import { Library, Transaction, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, serializeDailyActivation, invalidateDaily, scheduleDaily, currentMembershipHints, dailyState } from './bridge';
import { memory, recomputeDerived, scheduleLeafFlush, flushLeavesNow } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import type { STContext } from '@/st/context';

let lib: Library, ctx: STContext, dispose: (() => void) | undefined;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  Object.assign(memory, createEmptyMemory());
  ctx = { chat: [{ name: 'User', is_user: true, is_system: false, mes: '合成问题', extra: {} },
    { name: 'Character', is_user: false, is_system: false, mes: '合成答复', extra: {
      bbs_leaf: { id: 'leaf', text: '合成摘要', delta: {}, createdAt: 1, v: 1, swipe: 0 } } }],
    chatMetadata: {}, characters: [{ name: 'Character', avatar: 'save-fixture.png' }], characterId: 0,
    name1: 'User', name2: 'Character', getCurrentChatId: () => 'save-fixture',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined),
    eventTypes: {}, eventSource: { on: vi.fn(), off: vi.fn() }, setExtensionPrompt: vi.fn() } as unknown as STContext;
  vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
  lib = await Library.open(freshLibraryName()); await activateLibrary(lib);
  dispose = bindDaily();
});
afterEach(async () => {
  dispose?.(); await serializeDailyActivation(async () => {}); lib.close();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

test('real bridge summary completion saves the chat once and satisfies its delayed leaf flush', async () => {
  await syncDaily();
  vi.mocked(ctx.saveChat).mockClear(); vi.mocked(ctx.saveMetadata).mockClear();
  ctx.chat[1].extra!.bbs_leaf!.text = '更新后的合成摘要';
  recomputeDerived(); scheduleLeafFlush();
  await vi.advanceTimersByTimeAsync(200);
  await serializeDailyActivation(async () => {});
  expect(ctx.saveChat).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1800);
  await serializeDailyActivation(async () => {});
  expect(ctx.saveChat).toHaveBeenCalledTimes(1);
  expect(ctx.saveMetadata).toHaveBeenCalledTimes(2); // Durable pending/saved archive markers are intentional.
});

test('failed real archive write still permits the leaf flush and normal archive retry', async () => {
  await syncDaily(); vi.mocked(ctx.saveChat).mockClear();
  ctx.chat[1].extra!.bbs_leaf!.text = '保存失败后仍需持久化'; scheduleLeafFlush();
  vi.mocked(ctx.saveChat).mockRejectedValueOnce(Error('合成保存失败'));
  await expect(syncDaily()).rejects.toThrow('合成保存失败');
  await vi.advanceTimersByTimeAsync(1500);
  expect(ctx.saveChat).toHaveBeenCalledTimes(2);
  const view = await syncDaily();
  expect(view.memories[0].content).toBe('保存失败后仍需持久化');
  flushLeavesNow(); // Existing explicit immediate-flush callers still save immediately.
  expect(ctx.saveChat).toHaveBeenCalledTimes(4);
});

// Mirrors the shared card computed without mounting the plugin event page.
function cardProjection() {
  return computed(() => {
    void dailyState.revision; void dailyState.generation; void dailyState.scope;
    return currentMembershipHints();
  });
}
test('automatic warm recovery republishes membership hints to existing chat cards', async () => {
  await syncDaily();
  const badges = cardProjection();
  expect(badges.value).not.toBeNull();
  invalidateDaily();
  expect(badges.value).toBeNull();
  scheduleDaily();
  await vi.advanceTimersByTimeAsync(200);
  await serializeDailyActivation(async () => {});
  expect(dailyState.pending).toBe(false);
  expect(currentMembershipHints()).not.toBeNull();
  expect(badges.value).toBe(currentMembershipHints());
});

test('repeated unchanged host notifications do not reread the archive', async () => {
  await syncDaily();
  await vi.advanceTimersByTimeAsync(200);
  await serializeDailyActivation(async () => {});
  const get = vi.spyOn(Transaction.prototype, 'get');
  const all = vi.spyOn(Transaction.prototype, 'all');
  for (let i = 0; i < 20; i++) scheduleDaily();
  await vi.advanceTimersByTimeAsync(400);
  await serializeDailyActivation(async () => {});
  expect(get).not.toHaveBeenCalled();
  expect(all).not.toHaveBeenCalled();
});

test('summary event tags reach existing cards through automatic sync without opening events', async () => {
  const view = await syncDaily();
  const event = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id],
    eventIds: [], newTitle: '自动关联' });
  await syncDaily();
  const badges = cardProjection();
  expect(badges.value?.get('leaf')).toHaveLength(1);
  ctx.chat.push({ name: 'User', is_user: true, is_system: false, mes: '下一问', extra: {} },
    { name: 'Character', is_user: false, is_system: false, mes: '下一答', extra: {
      bbs_leaf: { id: 'new-leaf', text: '新摘要', delta: {}, createdAt: 2, v: 1, swipe: 0,
        tags: { version: 1, eventIds: [event.created!], planIds: [] } } } });
  recomputeDerived();
  await vi.advanceTimersByTimeAsync(200);
  await serializeDailyActivation(async () => {});
  expect(dailyState.pending).toBe(false);
  expect(badges.value?.get('new-leaf')).toEqual([expect.objectContaining({ title: '自动关联' })]);
  const get = vi.spyOn(Transaction.prototype, 'get');
  await vi.advanceTimersByTimeAsync(1000);
  await serializeDailyActivation(async () => {});
  expect(get).not.toHaveBeenCalled();
});

test.each(['success', 'review', 'API error'])('chat cards settle after automatic threshold resummary (%s) with the plugin closed', async outcome => {
  const original = { leafBatchThreshold: apiSettings.leafBatchThreshold, leafKeepRecent: apiSettings.leafKeepRecent,
    summaryMaxRetries: apiSettings.summaryMaxRetries, summarySuccessPreviewEnabled: apiSettings.summarySuccessPreviewEnabled };
  try {
    Object.assign(apiSettings, { leafBatchThreshold: 2, leafKeepRecent: 0, summaryMaxRetries: 0, summarySuccessPreviewEnabled: outcome === 'review' });
    ctx.chat.push({ ...ctx.chat[0], mes: '第二问', extra: {} }, { ...ctx.chat[1], mes: '第二答', extra: {
      bbs_leaf: { id: 'second', text: '第二条摘要', delta: {}, createdAt: 2, v: 1, swipe: 0 } } });
    const view = await syncDaily();
    await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '持续关联' });
    await syncDaily();
    // Drain the startup timer so it cannot accidentally repair a missing notification.
    await vi.advanceTimersByTimeAsync(200);
    await serializeDailyActivation(async () => {});
    const before = dailyState.revision;
    const expected = [expect.objectContaining({ title: '持续关联' })];
    const linked = view.memories[0].hostId;
    expect(membershipBadges.value?.get(linked)).toEqual(expected);
    vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
    const send = vi.spyOn(client, 'requestViaMainApi');
    const success = outcome !== 'API error';
    if (success) send.mockResolvedValue('{"summary":"合成高层总结"}');
    else send.mockRejectedValue(new Error('合成 API 错误'));
    if (outcome === 'review') {
      expect(await checkResummary()).toBe('pending');
      expect(dailyState.summaries).toBe(2);
      const get = vi.spyOn(Transaction.prototype, 'get'), all = vi.spyOn(Transaction.prototype, 'all');
      expect(await checkResummary()).toBe('pending');
      expect(get).not.toHaveBeenCalled();
      expect(all).not.toHaveBeenCalled();
      await recoverSummaryResponse(summaryResponses[0], '{"summary":"审核后的高层总结"}');
      expect(memory.summaries.at(-1)?.text).toBe('审核后的高层总结');
    } else expect(await checkResummary()).toBe(success ? 1 : 0);
    expect(send).toHaveBeenCalledOnce();
    if (success) expect(membershipBadges.value).toBeNull();
    else expect(engineState.lastError).toContain('合成 API 错误');

    await vi.advanceTimersByTimeAsync(200);
    await serializeDailyActivation(async () => {});
    expect(dailyState.summaries).toBe(success ? 3 : 2);
    expect(dailyState.revision).toBe(before + (success ? 1 : 0));
    expect(dailyState.pending).toBe(false);
    expect(membershipBadges.value?.get(linked)).toEqual(expected);
    const get = vi.spyOn(Transaction.prototype, 'get').mockClear(), all = vi.spyOn(Transaction.prototype, 'all').mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    await serializeDailyActivation(async () => {});
    expect(get).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
  } finally { Object.assign(apiSettings, original); }
});

test('notifications during an automatic save do not schedule another unchanged archive pass', async () => {
  await syncDaily();
  const badges = cardProjection();
  expect(badges.value).not.toBeNull();
  vi.mocked(ctx.saveChat).mockImplementationOnce(async () => {
    for (let i = 0; i < 20; i++) scheduleDaily();
  });
  ctx.chat[1].extra!.bbs_leaf!.text += '更新';
  recomputeDerived();
  await vi.advanceTimersByTimeAsync(200);
  await serializeDailyActivation(async () => {});
  expect(badges.value).not.toBeNull();
  const get = vi.spyOn(Transaction.prototype, 'get');
  await vi.advanceTimersByTimeAsync(1000);
  await serializeDailyActivation(async () => {});
  expect(get).not.toHaveBeenCalled();
});
