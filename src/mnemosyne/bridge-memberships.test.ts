import 'fake-indexeddb/auto';
import { createSSRApp, computed } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SummaryTags from '@/pages/summary/SummaryTags.vue';
import { SUMMARY_CTX } from '@/pages/summary/ctx';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Library, Transaction, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, invalidateDaily, readDailyMembershipContext, refreshDailyTables, currentMembershipHints, readDailyEventEditor } from './bridge';
import { saveMemberships } from './event-memberships';
import { eventView, setEventArchived } from './events';
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

test('validated generated eventIds become one AI membership and retries do not duplicate it', async () => {
  ctx.chat.push(
    { name: '用户', is_user: true, is_system: false, mes: '合成第二问', extra: {} },
    { name: '角色', is_user: false, is_system: false, mes: '合成第二答', extra: {
      bbs_leaf: { id: 'tagged-leaf', text: '合成第二摘要', delta: {}, createdAt: 2, v: 1, swipe: 0 },
    } },
  );
  let view = await syncDaily();
  const original = view.memories.find(m => m.hostId === 'real-bridge-leaf')!;
  const created = await saveMemberships(lib, view, {
    mode: 'add', memories: [original.id], eventIds: [], newTitle: '合成事件链',
  });
  await syncDaily();
  const target = ctx.chat[3].extra!.bbs_leaf as any;
  target.tags = { version: 1, participants: [], planIds: [], eventIds: [created.created!] };
  invalidateDaily();
  view = await syncDaily();
  const card = (await eventView(lib, view)).cards.find(c => c.chain.id === created.created)!;
  expect(card.members).toHaveLength(2);
  const ai = (await lib.all<any>('event_memberships')).filter(m => m.origin === 'ai');
  expect(ai).toHaveLength(1);
  expect(ai[0]).toMatchObject({ memory: view.memories.find(m => m.hostId === 'tagged-leaf')!.id,
    active: true, locked: false, owner: created.created });
  await syncDaily();
  expect((await lib.all<any>('event_memberships')).filter(m => m.origin === 'ai')).toHaveLength(1);
});

test('manual unlink survives stale generated tags, summary revision changes and archive retries', async () => {
  let view = await syncDaily();
  const created = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '人工控制' });
  ctx.chat[1].extra!.bbs_leaf!.tags = { version: 1, planIds: [], eventIds: [created.created!] };
  invalidateDaily(); view = await syncDaily();
  await saveMemberships(lib, view, { mode: 'replace', memories: [view.memories[0].id], eventIds: [] });
  await refreshDailyTables();
  expect(currentMembershipHints()?.get('real-bridge-leaf') ?? []).toEqual([]);
  ctx.chat[1].extra!.bbs_leaf!.text += ' 修订摘要';
  invalidateDaily(); view = await syncDaily();
  expect((await eventView(lib, view)).cards[0].members).toHaveLength(0);
  expect((await eventView(lib, view)).cards[0].removedMembers?.[0]).toMatchObject({ locked: true, memory: view.memories[0].id });
  await syncDaily();
  expect((await lib.all<any>('event_memberships')).filter(m => m.origin === 'ai')).toHaveLength(0);
  await saveMemberships(lib, view, { mode: 'replace', memories: [view.memories[0].id], eventIds: [created.created!] });
  await refreshDailyTables();
  expect(currentMembershipHints()?.get('real-bridge-leaf')).toEqual([expect.objectContaining({ id: created.created })]);
});


test('both editors read the full branch catalog including archived chains and reverse memberships', async () => {
  let view = await syncDaily();
  const chain = await saveMemberships(lib, view, { mode: 'replace', memories: [view.memories[0].id], eventIds: [], newTitle: '归档也可选' });
  await refreshDailyTables();
  view = (await readDailyMembershipContext()).view;
  await setEventArchived(lib, view, chain.created!, true);
  const editor = await readDailyEventEditor();
  expect(editor.projection.cards).toHaveLength(1);
  expect(editor.projection.cards[0].chain.archived).toBe(true);
  expect(editor.projection.cards[0].members[0].memory).toBe(view.memories[0].id);
  expect(ctx.chat[1].extra!.bbs_leaf!.tags).toBeUndefined(); // Reverse projection needs no host writes.
  await refreshDailyTables();
  const app = createSSRApp(SummaryTags, { floor: 1, leafId: 'real-bridge-leaf' });
  app.provide(SUMMARY_CTX, { events: computed(() => []) } as any);
  expect(await renderToString(app)).toContain('相关事件 · 归档也可选');
});
