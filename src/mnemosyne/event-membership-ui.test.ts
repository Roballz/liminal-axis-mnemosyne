import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
const mocks = vi.hoisted(() => ({ scope: 'one', host: 'v1', context: {} as any, read: vi.fn(), active: vi.fn(), current: vi.fn(), refresh: vi.fn(), toast: vi.fn() }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));
vi.mock('@/st/toast', () => ({ toast: mocks.toast }));
vi.mock('./bridge', async () => ({ dailyState: (await import('vue')).reactive({ revision: 0, generation: 0, scope: 'one' }),
  hostScope: () => mocks.scope, hostVersion: () => mocks.host, readDailyMembershipContext: mocks.read,
  refreshDailyTables: mocks.refresh, dailyCurrent: mocks.current, currentMembershipHints: () => null }));
vi.mock('./manual-events', () => ({ manualEventState: { busy: false } }));
vi.mock('./jobs', () => ({ jobState: { busy: false } }));
vi.mock('./db', async original => ({ ...await original<any>(), activeLibrary: mocks.active }));
import { dailyState } from './bridge';
import { manualEventState } from './manual-events';
import { closeMemberships, commitMembershipSelection, membershipSession, membershipUi, openMemberships } from './event-membership-ui';
import { nextTick } from 'vue';
let data: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  closeMemberships(); membershipUi.saving = false; mocks.scope = 'one'; mocks.host = 'v1';
  dailyState.scope = 'one'; dailyState.generation = 0; await nextTick();
  data = await fixture(2); mocks.context = { chat: [{}, { extra: { bbs_leaf: { id: 'leaf-0' } } }, {}, { extra: { bbs_leaf: { id: 'leaf-1' } } }] };
  mocks.active.mockResolvedValue(data.lib); mocks.current.mockResolvedValue(true); mocks.refresh.mockResolvedValue(undefined); mocks.toast.mockReset();
  mocks.read.mockResolvedValue({ view: data.view, lib: data.lib, host: mocks.host, generation: 0 });
});
afterEach(() => { closeMemberships(); data.lib.close(); vi.clearAllMocks(); });
test('single-card identity is pinned before awaited reads; replacement cannot silently open a different summary', async () => {
  let release!: (value: any) => void;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = openMemberships({ floor: 1, expectedLeafId: 'leaf-0' });
  mocks.context.chat[1].extra.bbs_leaf.id = 'replacement';
  release({ view: data.view, lib: data.lib, host: mocks.host, generation: 0 }); await pending;
  expect(membershipSession.value).toBeNull(); expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('摘要已改变'), 'warning');
  expect(manualEventState.busy).toBe(false);
});
test('late library replacement and host changes after current check cannot expose stale rows', async () => {
  mocks.current.mockImplementationOnce(async () => { mocks.host = 'v2'; return true; });
  await openMemberships({ floor: 1 }); expect(membershipSession.value).toBeNull();
  mocks.host = 'v1'; mocks.active.mockResolvedValueOnce({});
  await openMemberships({ floor: 1 }); expect(membershipSession.value).toBeNull();
});
test('unmounted originating card and cancelled pending opens cannot reopen the global picker', async () => {
  await openMemberships({ floor: 1, isCurrent: () => false }); expect(membershipSession.value).toBeNull();
  let release!: (value: any) => void;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = openMemberships({ floor: 1 }); closeMemberships();
  release({ view: data.view, lib: data.lib, host: mocks.host, generation: 0 }); await pending;
  expect(membershipSession.value).toBeNull(); expect(membershipUi.loading).toBe(false);
});
test('single picker cancel is read-only; repeat save cannot submit twice', async () => {
  await openMemberships({ floor: 1 }); expect(membershipSession.value?.mode).toBe('single'); closeMemberships();
  expect(await data.lib.all('event_chains')).toHaveLength(0);
  await openMemberships({ floor: 1 });
  const request = { mode: 'replace' as const, memories: [data.view.memories[0].id], eventIds: [], newTitle: '合成新链' };
  const first = commitMembershipSelection(request), second = commitMembershipSelection(request);
  expect(await second).toBe(false); expect(await first).toBe(true);
  expect(await data.lib.all('event_chains')).toHaveLength(1); expect(mocks.refresh).toHaveBeenCalledTimes(1);
});
test('chat change clears the picker, while initially publishing the same host scope does not cancel opening', async () => {
  await openMemberships({ floor: 1 }); expect(membershipSession.value).not.toBeNull();
  mocks.scope = 'two'; dailyState.scope = 'two'; await nextTick(); expect(membershipSession.value).toBeNull();
  expect(manualEventState.busy).toBe(false);
});
test('cold or stale archives report the read-only archive blocker without initiating synchronization', async () => {
  mocks.read.mockRejectedValueOnce(new Error('档案尚未同步完成，请等待“已归档”后重试'));
  await openMemberships(); expect(membershipSession.value).toBeNull(); expect(membershipUi.loading).toBe(false);
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('已归档'), 'warning');
});
