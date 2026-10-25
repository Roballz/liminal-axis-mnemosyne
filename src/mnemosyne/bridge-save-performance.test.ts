import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Library, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, serializeDailyActivation } from './bridge';
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
