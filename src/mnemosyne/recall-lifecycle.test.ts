import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
import { refreshInjection } from '@/memory/inject';
import { editEvent } from './events';
import * as api from '@/api/settings';
import * as client from '@/api/client';
import * as host from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as engine from '@/memory/engine';
import { memory, recomputeDerived, flushLeavesNow } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import * as indexing from '@/memory/vector/index';
import * as vector from '@/memory/vector/store';
import * as embed from '@/memory/vector/embed';
import * as rewrite from '@/memory/vector/rewrite';
import * as lexical from '@/memory/vector/bm25';
import { clearRecallInjection, runVectorRecall } from '@/memory/vector/recall';
import { recallDebug } from '@/memory/vector/debug';
import { Library, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, scheduleDaily, canonicalLeaves, dailyState, hostVersion, recallHostVersion, invalidateDaily } from './bridge';

const original = JSON.parse(JSON.stringify(api.apiSettings));
const message = (user: boolean, text: string): STMessage => ({ name: user ? 'User' : 'Character', is_user: user, is_system: false, mes: text, extra: {} });
let ctx: STContext, lib: Library, dispose: (() => void) | undefined, chatId: string;
const pendingCleanup: (() => void)[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  pendingCleanup.push(() => resolve(undefined as T));
  return { promise, resolve };
}
beforeEach(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  Object.assign(memory, createEmptyMemory()); chatId = 'synthetic';
  ctx = { chat: [message(true, '旧问题'), message(false, '旧剧情'), message(true, '第一轮提问')],
    name1: 'User', name2: 'Character', chatMetadata: {}, characterId: 0, characters: [{ avatar: 'synthetic.png' }],
    getCurrentChatId: () => chatId, saveChat: vi.fn().mockResolvedValue(undefined),
    saveMetadata: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    eventTypes: {}, eventSource: { on: vi.fn(), off: vi.fn() }, setExtensionPrompt: vi.fn(),
  } as unknown as STContext;
  ctx.chat[0].is_system = true; ctx.chat[0].extra = { bbs_hidden: true };
  ctx.chat[1].is_system = true;
  ctx.chat[1].extra = { bbs_hidden: true, bbs_leaf: { id: 'old-leaf', text: '旧摘要', delta: { time: '2040-01-01 10:00', location: '合成庭院' }, createdAt: 1, v: 1 } };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
  vi.spyOn(host, 'getContext').mockImplementation(() => ({ ...ctx })); // 宿主可每次返回新的 context 包装。
  Object.assign(api.apiSettings, { autoSummaryEnabled: true, autoHideEnabled: false, summaryOnlyMode: false });
  api.apiSettings.vector.enabled = true; api.apiSettings.vector.knowledge.enabled = false;
  Object.assign(api.apiSettings.vector.recall, { minAiFloors: 0, bm25Candidates: 20, rerankCandidates: 20,
    fusionCandidates: 20, rrfCount: 1, bm25Count: 1, fullTextCount: 1, finalRecallCount: 3,
    embeddingThreshold: .8, rerankThreshold: .9, rrfContextEnabled: true });
  vi.spyOn(api, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(api, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(host, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(2);
  vi.spyOn(indexing, 'ensureRecallIndex').mockResolvedValue(undefined);
  vi.spyOn(indexing, 'scheduleVectorIndex').mockImplementation(() => {});
  vi.spyOn(embed, 'embedTexts').mockResolvedValue([new Float32Array([1, 0])]);
  vi.spyOn(embed, 'rerankDocuments').mockResolvedValue([{ index: 0, score: .99 }]);
  vi.spyOn(rewrite, 'rewriteQuery').mockResolvedValue({ intent: '回忆', queries: ['旧剧情'],
    context: { participants: ['甲'], planIds: [], eventIds: [] } });
  vi.spyOn(vector, 'vecSearch').mockImplementation(async (_db, scopes) => ({ results: canonicalLeaves().map(l => ({
    ...l, scope: scopes[0], similarity: .95, queryIndex: 0,
  })) }));
  vi.spyOn(lexical, 'searchBm25').mockImplementation(async () => ({ persistent: false,
    hits: canonicalLeaves().map(l => ({ id: l.leafId, score: 10 })) }));
  lib = await Library.open(freshLibraryName()); await activateLibrary(lib);
  dispose = bindDaily();
  const view = await syncDaily();
  await editEvent(lib, view, null, { title: '持续约定', status: 'open', keywords: [] },
    { memory: view.memories[0].id, active: true, kind: 'progress' });
  recomputeDerived(); await nextTick(); await syncDaily();
});
afterEach(async () => {
  clearRecallInjection();
  pendingCleanup.splice(0).forEach(release => release());
  await engine.currentAutoSummaryPromise(); await engine.currentSummaryPromise();
  flushLeavesNow(); dispose?.(); lib.close();
  Object.assign(api.apiSettings, original); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const injected = () => vi.mocked(ctx.setExtensionPrompt!).mock.calls.filter(c => c[0] === 'mnemosyne_vector_recall').at(-1)?.[1];

const promptText = (key: string) => vi.mocked(ctx.setExtensionPrompt!).mock.calls.filter(c => c[0] === key).at(-1)?.[1];
function expectBaseInjection() {
  expect(promptText('mnemosyne_memory_history')).toContain('旧摘要');
  expect(promptText('mnemosyne_memory_state')).toContain('持续约定');
  expect(promptText('mnemosyne_memory_state')).toContain('合成庭院');
}
async function startSecondSummary() {
  ctx.chat.push(message(false, '第一轮新回复'), message(true, '第二轮提问')); scheduleDaily();
  const pending = deferred<string>();
  const sender = vi.spyOn(client, 'requestViaMainApi').mockReturnValueOnce(pending.promise);
  const summary = engine.maybeSummarizePrevAi(false);
  await vi.waitFor(() => expect(sender).toHaveBeenCalledOnce());
  return { pending, summary };
}
const summaryResult = JSON.stringify({ summary: '第一轮新摘要',
  vars: [{ op: 'set', path: '合成标记', value: '已记录' }] });

test.each([false, true])('连续两轮：可见近期补摘与重排并行（自动隐藏=%s）', async hide => {
  api.apiSettings.autoHideEnabled = hide;
  api.apiSettings.keepRecent = 1;
  await runVectorRecall(); expect(recallDebug.status).toBe('召回完成');
  const { pending, summary } = await startSecondSummary();
  const rank = deferred<embed.RerankResult[]>();
  vi.mocked(embed.rerankDocuments).mockReturnValueOnce(rank.promise);
  const recall = runVectorRecall();
  await vi.waitFor(() => expect(embed.rerankDocuments).toHaveBeenCalledTimes(2));
  expect(recallDebug.fusion.length).toBeGreaterThan(0);
  const before = hostVersion(), recallVersion = recallHostVersion();
  pending.resolve(summaryResult); await summary; await nextTick();
  expect(ctx.chat[3].extra?.bbs_leaf?.text).toBe('第一轮新摘要');
  expect(ctx.chat[3].mes).toContain('bbs_vars');
  expect(hostVersion()).not.toBe(before);
  expect(recallHostVersion()).toBe(recallVersion);
  expect(recallDebug.status).toContain('进行中…重排');
  expectBaseInjection(); // 归档尚在排队时也不能清掉基础槽。
  await syncDaily();
  expect(canonicalLeaves()).toHaveLength(2);
  rank.resolve([{ index: 0, score: .99 }]); await recall;
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
  expect(recallDebug.status).toBe('召回完成');
  expect(recallDebug.contextRanked?.length).toBeGreaterThan(0);
  expect(recallDebug.rerank.length).toBeGreaterThan(0);
  expect(injected()).toContain('旧剧情');
  expect(injected()).not.toContain('第一轮新摘要');
  expect(injected()).not.toContain('第一轮新回复');
  expectBaseInjection();
});

test('召回先完成时，不等后台补摘；补摘及归档随后完成也保留三处注入', async () => {
  await runVectorRecall();
  const { pending, summary } = await startSecondSummary();
  await runVectorRecall();
  expect(ctx.chat[3].extra?.bbs_leaf).toBeUndefined();
  expect(recallDebug.status).toBe('召回完成');
  const recalled = injected(); expect(recalled).toContain('旧剧情');
  pending.resolve(summaryResult); await summary; await nextTick();
  expect(injected()).toBe(recalled); expectBaseInjection();
  await syncDaily();
  expect(injected()).toBe(recalled); expectBaseInjection();
});

test.each(['embedding', 'abort'] as const)('召回 %s 失败与可见补摘交错，只清向量槽；下一轮能再召回', async failure => {
  const { pending, summary } = await startSecondSummary();
  const vectors = deferred<Float32Array[]>();
  vi.mocked(embed.embedTexts).mockReturnValueOnce(vectors.promise);
  const controller = new AbortController();
  const recall = runVectorRecall(controller.signal);
  await vi.waitFor(() => expect(embed.embedTexts).toHaveBeenCalledOnce());
  pending.resolve(summaryResult); await summary; await nextTick();
  if (failure === 'abort') controller.abort();
  else vectors.resolve([]);
  await recall;
  expect(recallDebug.status).toContain('召回失败'); expect(injected()).toBe('');
  expectBaseInjection();
  await syncDaily(); await runVectorRecall();
  expect(recallDebug.status).toBe('召回完成'); expectBaseInjection();
});

test('RRF 已有候选时，无内容变化的派生刷新不取消重排', async () => {
  const pending = deferred<embed.RerankResult[]>();
  vi.mocked(embed.rerankDocuments).mockReturnValueOnce(pending.promise);
  const recall = runVectorRecall();
  await vi.waitFor(() => expect(embed.rerankDocuments).toHaveBeenCalledOnce());
  expect(recallDebug.fusion.length).toBeGreaterThan(0);
  const version = hostVersion(), generation = dailyState.generation;
  recomputeDerived(); await nextTick(); scheduleDaily();
  expect(hostVersion()).toBe(version);
  expect(dailyState.generation).toBe(generation);
  expect(recallDebug.status).toContain('进行中…重排');
  pending.resolve([{ index: 0, score: .99 }]); await recall;
  expect(recallDebug.status).toBe('召回完成');
});

test.each([1, 3])('重排期间真实编辑 #%s 正文依然取消，并保留取消时所处阶段', async floor => {
  if (floor === 3) {
    ctx.chat.push(message(false, '近期可见回复'), message(true, '新的提问')); scheduleDaily(); await syncDaily();
  }
  const pending = deferred<embed.RerankResult[]>();
  vi.mocked(embed.rerankDocuments).mockReturnValueOnce(pending.promise);
  const recall = runVectorRecall();
  await vi.waitFor(() => expect(embed.rerankDocuments).toHaveBeenCalledOnce());
  ctx.chat[floor].mes = '人工编辑后的剧情'; scheduleDaily(); await recall;
  expect(recallDebug.status).toContain('正文或摘要已更新');
  expect(recallDebug.status).toContain('阶段：重排候选原文');
  expect(injected()).toBe('');
  pending.resolve([{ index: 0, score: 1 }]); await nextTick();
  expect(injected()).toBe('');
});

test.each(['visibility', 'event'] as const)('重排期间 %s 实际改变，即使宿主正文未变也丢弃旧结果', async change => {
  const rank = deferred<embed.RerankResult[]>();
  vi.mocked(embed.rerankDocuments).mockReturnValueOnce(rank.promise);
  const recall = runVectorRecall();
  await vi.waitFor(() => expect(embed.rerankDocuments).toHaveBeenCalledOnce());
  if (change === 'visibility') ctx.chat[1].is_system = false;
  else await editEvent(lib, await syncDaily(), (await lib.all('event_chains'))[0].id,
    { title: '旧事件已被改动', status: 'open', keywords: [] });
  rank.resolve([{ index: 0, score: .99 }]); await recall;
  expect(recallDebug.status).toContain('召回失败'); expect(injected()).toBe('');
});

test('与旧候选无关的事件更新不取消本轮召回', async () => {
  const rank = deferred<embed.RerankResult[]>();
  vi.mocked(embed.rerankDocuments).mockReturnValueOnce(rank.promise);
  const recall = runVectorRecall();
  await vi.waitFor(() => expect(embed.rerankDocuments).toHaveBeenCalledOnce());
  await editEvent(lib, await syncDaily(), null, { title: '无关事件', status: 'open', keywords: [] });
  rank.resolve([{ index: 0, score: .99 }]); await recall;
  expect(recallDebug.status).toBe('召回完成'); expect(injected()).toContain('旧剧情');
});

test.each(['chat', 'input'] as const)('后台摘要并行时 %s 改变，旧召回仍取消', async change => {
  const { pending, summary } = await startSecondSummary();
  const rank = deferred<embed.RerankResult[]>();
  vi.mocked(embed.rerankDocuments).mockReturnValueOnce(rank.promise);
  const recall = runVectorRecall();
  await vi.waitFor(() => expect(embed.rerankDocuments).toHaveBeenCalledOnce());
  if (change === 'chat') chatId = 'other';
  else ctx.chat.push(message(true, '另一个新输入'));
  scheduleDaily(); await recall;
  expect(recallDebug.status).toContain('召回失败'); expect(injected()).toBe('');
  pending.resolve(summaryResult); rank.resolve([{ index: 0, score: 1 }]);
  await summary; await nextTick(); expect(injected()).toBe('');
});

test('新输入归档失败不撤销未变的历史；显式权限/档案失效仍立即撤销', async () => {
  expectBaseInjection();
  ctx.chat.push(message(false, '新回复'), message(true, '新提问')); scheduleDaily();
  expectBaseInjection();
  vi.mocked(ctx.saveChat).mockRejectedValueOnce(new Error('合成存储失败'));
  await expect(syncDaily()).rejects.toThrow('合成存储失败');
  refreshInjection(); expectBaseInjection();
  invalidateDaily('权限或档案已改变');
  expect(promptText('mnemosyne_memory_history')).toBe('');
  expect(promptText('mnemosyne_memory_state')).not.toContain('持续约定');
});
