import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Library, Transaction, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, invalidateDaily, readDailyMembershipContext, refreshDailyTables, currentMembershipHints } from './bridge';
import { saveMemberships } from './event-memberships';
import { ReplyFinality } from './reply-finality';
import { memory } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import type { STContext } from '@/st/context';
let lib: Library, ctx: STContext, dispose: (() => void) | undefined;
beforeEach(async () => {
  const storage = new Map(); vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  Object.assign(memory, createEmptyMemory());
  ctx = { chat: [{ name: '用户', is_user: true, is_system: false, mes: '合成问题', extra: {} },
    { name: '角色', is_user: false, is_system: false, mes: '合成答复', extra: { bbs_leaf: { id: 'real-bridge-leaf', text: '合成摘要', delta: {}, createdAt: 1, v: 1, swipe: 0 } } }],
    chatMetadata: {}, characters: [{ name: '合成角色', avatar: 'fixture.png' }], characterId: 0, getCurrentChatId: () => 'membership-bridge',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined), eventTypes: {}, eventSource: { on: vi.fn(), off: vi.fn() }, setExtensionPrompt: vi.fn() } as unknown as STContext;
  vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
  lib = await Library.open(freshLibraryName()); await activateLibrary(lib); dispose = bindDaily();
});
afterEach(() => { dispose?.(); lib.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test('real archived-context read and post-save membership refresh perform zero source-body/descriptor reads and no host saves', async () => {
  const view = await syncDaily();
  vi.mocked(ctx.saveChat).mockClear(); vi.mocked(ctx.saveMetadata).mockClear();
  const get = vi.spyOn(Transaction.prototype, 'get');
  const opened = await readDailyMembershipContext(); expect(opened.view.memories).toBe(view.memories);
  const result = await saveMemberships(lib, opened.view, { mode: 'replace', memories: [view.memories[0].id], eventIds: [], newTitle: '新链' });
  await refreshDailyTables();
  expect(currentMembershipHints()?.get('real-bridge-leaf')).toEqual([expect.objectContaining({ id: result.created, title: '新链' })]);
  expect(get.mock.calls.filter(([store]) => store === 'source_bodies' || store === 'source_revisions')).toEqual([]);
  expect(ctx.saveChat).not.toHaveBeenCalled(); expect(ctx.saveMetadata).not.toHaveBeenCalled();
  expect((await readDailyMembershipContext()).view.branch.epoch).toBe(view.branch.epoch + 1);
});
test('cold and changed-host context refuse without silently synchronizing or reading any bodies', async () => {
  const get = vi.spyOn(Transaction.prototype, 'get');
  await expect(readDailyMembershipContext()).rejects.toThrow('已归档');
  expect(get.mock.calls.some(([store]) => store === 'source_bodies' || store === 'source_revisions')).toBe(false);
  await syncDaily(); get.mockClear(); vi.mocked(ctx.saveChat).mockClear();
  ctx.chat[1].mes += '已改正文'; invalidateDaily();
  await expect(readDailyMembershipContext()).rejects.toThrow('已归档');
  expect(get.mock.calls.some(([store]) => store === 'source_bodies' || store === 'source_revisions')).toBe(false);
  expect(ctx.saveChat).not.toHaveBeenCalled(); expect(currentMembershipHints()).toBeNull();
});

test('archivability changing during its awaited check cannot open a cached membership context', async () => {
  await syncDaily();
  vi.spyOn(ReplyFinality.prototype, 'assertArchivable').mockResolvedValueOnce(() => false);
  await expect(readDailyMembershipContext()).rejects.toThrow();
});
