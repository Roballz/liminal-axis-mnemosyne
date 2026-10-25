import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { STContext } from './context';
import { saveChatNow, scheduleChatSave } from './chat-save';

let ctx: STContext;
function context(chatId = 'chat'): STContext {
  return { chat: [{ name: 'User', is_user: true, is_system: false, mes: '合成正文' }], chatMetadata: {},
    getCurrentChatId: () => chatId, saveChat: vi.fn().mockResolvedValue(undefined),
    characters: [{ name: 'Character', avatar: 'fixture.png' }], characterId: 0 } as unknown as STContext;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  ctx = context();
  vi.stubGlobal('window', { SillyTavern: { getContext: () => ({ ...ctx }) } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('successful archive save satisfies the same pending leaf ticket across transient context wrappers', async () => {
  scheduleChatSave(ctx);
  await vi.advanceTimersByTimeAsync(200);
  await saveChatNow(ctx);
  await vi.advanceTimersByTimeAsync(1500);
  expect(ctx.saveChat).toHaveBeenCalledTimes(1);
});

test('timer waits for an ongoing archive save instead of duplicating its write', async () => {
  const write = deferred();
  vi.mocked(ctx.saveChat).mockReturnValueOnce(write.promise);
  scheduleChatSave(ctx);
  const archived = saveChatNow(ctx);
  await vi.advanceTimersByTimeAsync(1600);
  expect(ctx.saveChat).toHaveBeenCalledTimes(1);
  write.resolve(); await archived;
  await vi.advanceTimersByTimeAsync(0);
  expect(ctx.saveChat).toHaveBeenCalledTimes(1);
});

test('an edit made during a save retains its own ticket and gets a second save', async () => {
  const write = deferred();
  const stored: string[] = [];
  vi.mocked(ctx.saveChat).mockImplementationOnce(() => { stored.push(ctx.chat[0].mes); return write.promise; })
    .mockImplementation(async () => { stored.push(ctx.chat[0].mes); });
  scheduleChatSave(ctx);
  const archived = saveChatNow(ctx);
  ctx.chat[0].mes = '保存期间的新内容'; scheduleChatSave(ctx);
  await vi.advanceTimersByTimeAsync(1600);
  expect(ctx.saveChat).toHaveBeenCalledTimes(1);
  write.resolve(); await archived;
  await vi.advanceTimersByTimeAsync(0);
  expect(stored).toEqual(['合成正文', '保存期间的新内容']);
});

test('an archive version mismatch cannot cancel a pending leaf flush', async () => {
  scheduleChatSave(ctx);
  await saveChatNow(ctx, () => false);
  await vi.advanceTimersByTimeAsync(1500);
  expect(ctx.saveChat).toHaveBeenCalledTimes(2);
});

test('failed archive save leaves the timer retryable, and failed timer remains explicitly retryable', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(ctx.saveChat).mockRejectedValueOnce(Error('archive failed'))
    .mockRejectedValueOnce(Error('timer failed'));
  scheduleChatSave(ctx);
  await expect(saveChatNow(ctx)).rejects.toThrow('archive failed');
  await vi.advanceTimersByTimeAsync(1500);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(ctx.saveChat).toHaveBeenCalledTimes(2);
  await saveChatNow(ctx);
  await vi.advanceTimersByTimeAsync(3000);
  expect(ctx.saveChat).toHaveBeenCalledTimes(3);
});

test('switching chats cannot redirect an old timer or queued save to the new chat', async () => {
  const old = ctx, write = deferred();
  vi.mocked(old.saveChat).mockReturnValueOnce(write.promise);
  scheduleChatSave(old);
  const first = saveChatNow(old);
  const queued = saveChatNow(old);
  const rejection = expect(queued).rejects.toThrow('聊天已切换');
  ctx = context('other');
  await vi.advanceTimersByTimeAsync(1600);
  write.resolve(); await first; await rejection;
  await vi.advanceTimersByTimeAsync(0);
  expect(old.saveChat).toHaveBeenCalledTimes(1);
  expect(ctx.saveChat).not.toHaveBeenCalled();
  ctx = old; await saveChatNow(ctx);
  expect(old.saveChat).toHaveBeenCalledTimes(2);
});

test('multiple elapsed timers waiting on one save do not duplicate the later edit', async () => {
  const write = deferred();
  vi.mocked(ctx.saveChat).mockReturnValueOnce(write.promise);
  scheduleChatSave(ctx);
  const first = saveChatNow(ctx);
  await vi.advanceTimersByTimeAsync(1500);
  ctx.chat[0].mes = '下一次编辑'; scheduleChatSave(ctx);
  await vi.advanceTimersByTimeAsync(1500);
  write.resolve(); await first;
  await vi.advanceTimersByTimeAsync(0);
  expect(ctx.saveChat).toHaveBeenCalledTimes(2);
});
