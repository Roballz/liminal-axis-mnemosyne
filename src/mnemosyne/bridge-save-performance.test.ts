import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { saveMemberships } from './event-memberships';
import { computed } from 'vue';
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
