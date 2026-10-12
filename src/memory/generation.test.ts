import { beforeEach, expect, test, vi } from 'vitest';
import { prepareGeneration } from './generation';

const mocks = vi.hoisted(() => ({
  scope: 'chat-a', chat: [] as unknown[], active: true, installed: true,
  backlog: vi.fn(), sync: vi.fn(), refresh: vi.fn(), recall: vi.fn(),
}));
vi.mock('@/api/settings', () => ({ engineActiveHere: () => mocks.active }));
vi.mock('@/mnemosyne/bridge', () => ({ hostScope: () => mocks.scope,
  dailyInstalled: () => mocks.installed, syncDaily: mocks.sync }));
vi.mock('@/st/context', () => ({ getContext: () => ({ chat: mocks.chat }) }));
vi.mock('./engine', () => ({ handleGenerationIntercept: mocks.backlog }));
vi.mock('./inject', () => ({ refreshInjection: mocks.refresh }));
vi.mock('./vector/recall', () => ({ runVectorRecall: mocks.recall,
  shouldRecallForType: (type: string) => !['quiet', 'continue', 'impersonate'].includes(type) }));
beforeEach(() => {
  vi.resetAllMocks(); mocks.scope = 'chat-a'; mocks.chat = []; mocks.active = mocks.installed = true;
  mocks.backlog.mockResolvedValue(false); mocks.sync.mockResolvedValue(undefined);
  mocks.recall.mockResolvedValue(undefined);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('等待基础归档完成再刷新及召回，不使用防抖时长猜测', async () => {
  const pending = deferred(), abort = vi.fn(); mocks.sync.mockReturnValueOnce(pending.promise);
  const generation = prepareGeneration(abort, 'swipe');
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledOnce());
  expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.recall).not.toHaveBeenCalled();
  pending.resolve(); await generation;
  expect(mocks.refresh).toHaveBeenCalledOnce(); expect(mocks.recall).toHaveBeenCalledOnce();
  expect(mocks.refresh.mock.invocationCallOrder[0]).toBeLessThan(mocks.recall.mock.invocationCallOrder[0]);
  expect(abort).not.toHaveBeenCalled();
});

test.each(['backlog', 'sync', 'recall'] as const)('在 %s 等待期间切聊天只中止旧生成，不触碰新聊天槽', async stage => {
  const pending = deferred(), abort = vi.fn(); mocks[stage].mockReturnValueOnce(pending.promise);
  const generation = prepareGeneration(abort, 'regenerate');
  await vi.waitFor(() => expect(mocks[stage]).toHaveBeenCalledOnce());
  const refreshes = mocks.refresh.mock.calls.length, recalls = mocks.recall.mock.calls.length;
  mocks.scope = 'chat-b'; mocks.chat = []; pending.resolve(); await generation;
  expect(abort).toHaveBeenCalledWith(true);
  expect(mocks.refresh).toHaveBeenCalledTimes(refreshes); expect(mocks.recall).toHaveBeenCalledTimes(recalls);
});

test('相同聊天名重新加载了 chat 数组也中止旧生成', async () => {
  const pending = deferred(), abort = vi.fn(); mocks.sync.mockReturnValueOnce(pending.promise);
  const generation = prepareGeneration(abort, 'normal');
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledOnce());
  mocks.chat = []; pending.resolve(); await generation;
  expect(abort).toHaveBeenCalledWith(true); expect(mocks.refresh).not.toHaveBeenCalled();
});

test.each(['quiet', 'continue', 'impersonate'])('%s 保持原有不准备基础注入/召回的范围', async type => {
  await prepareGeneration(vi.fn(), type);
  expect(mocks.sync).not.toHaveBeenCalled(); expect(mocks.recall).not.toHaveBeenCalled();
});

test('积压已拦截时不归档或召回', async () => {
  mocks.backlog.mockResolvedValueOnce(true); await prepareGeneration(vi.fn(), 'normal');
  expect(mocks.sync).not.toHaveBeenCalled(); expect(mocks.recall).not.toHaveBeenCalled();
});

test.each(['active', 'installed'] as const)('%s 关闭时不启动新增归档', async flag => {
  mocks[flag] = false; await prepareGeneration(vi.fn(), 'normal');
  expect(mocks.sync).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
});
