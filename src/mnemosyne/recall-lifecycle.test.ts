import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
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
import { bindDaily, syncDaily, scheduleDaily, canonicalLeaves, dailyState, hostVersion } from './bridge';

const original = JSON.parse(JSON.stringify(api.apiSettings));
const message = (user: boolean, text: string): STMessage => ({ name: user ? 'User' : 'Character', is_user: user, is_system: false, mes: text, extra: {} });
let ctx: STContext, lib: Library, dispose: (() => void) | undefined, chatId: string;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
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
  ctx.chat[1].is_system = true;
  ctx.chat[1].extra = { bbs_hidden: true, bbs_leaf: { id: 'old-leaf', text: '旧摘要', delta: {}, createdAt: 1, v: 1 } };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
  Object.assign(api.apiSettings, { autoSummaryEnabled: true, autoHideEnabled: false });
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
  dispose = bindDaily(); await syncDaily();
});
afterEach(async () => {
  clearRecallInjection();
  await engine.currentAutoSummaryPromise(); await engine.currentSummaryPromise();
  flushLeavesNow(); dispose?.(); lib.close();
  Object.assign(api.apiSettings, original); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const injected = () => vi.mocked(ctx.setExtensionPrompt!).mock.calls.filter(c => c[0] === 'mnemosyne_vector_recall').at(-1)?.[1];

test.each([false, true])('真实桥接连续两轮：第二轮等摘要及隐藏收尾（隐藏=%s）', async hide => {
  api.apiSettings.autoHideEnabled = hide;
  api.apiSettings.keepRecent = 0;
  const hidden = deferred<void>();
  ctx.executeSlashCommandsWithOptions = vi.fn(async () => { await hidden.promise; }) as any;
  await runVectorRecall(); expect(recallDebug.status).toBe('召回完成');
  ctx.chat.push(message(false, '第一轮新回复'), message(true, '第二轮提问')); scheduleDaily();
  const pending = deferred<string>();
  const sender = vi.spyOn(client, 'requestViaMainApi').mockReturnValueOnce(pending.promise);
  const summary = engine.maybeSummarizePrevAi(false);
  await vi.waitFor(() => expect(sender).toHaveBeenCalledOnce());
  const recall = runVectorRecall();
  await nextTick();
  expect(recallDebug.status).toContain('等待本轮自动摘要');
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
  pending.resolve('{"summary":"第一轮新摘要"}');
  if (hide) {
    await vi.waitFor(() => expect(ctx.executeSlashCommandsWithOptions).toHaveBeenCalled());
    expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
  }
  hidden.resolve();
  await summary; await recall;
  expect(ctx.chat[3].extra?.bbs_leaf?.text).toBe('第一轮新摘要');
  expect(canonicalLeaves()).toHaveLength(2);
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
  expect(recallDebug.status).toBe('召回完成');
  expect(recallDebug.contextRanked?.length).toBeGreaterThan(0);
  expect(recallDebug.rerank.length).toBeGreaterThan(0);
  expect(injected()).toContain('旧剧情');
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

test('重排期间真实编辑依然取消，并保留取消时所处阶段', async () => {
  const pending = deferred<embed.RerankResult[]>();
  vi.mocked(embed.rerankDocuments).mockReturnValueOnce(pending.promise);
  const recall = runVectorRecall();
  await vi.waitFor(() => expect(embed.rerankDocuments).toHaveBeenCalledOnce());
  ctx.chat[1].mes = '人工编辑后的剧情'; scheduleDaily(); await recall;
  expect(recallDebug.status).toContain('正文或摘要已更新');
  expect(recallDebug.status).toContain('阶段：重排候选原文');
  expect(injected()).toBe('');
  pending.resolve([{ index: 0, score: 1 }]); await nextTick();
  expect(injected()).toBe('');
});

test.each(['chat', 'input'] as const)('等待摘要时 %s 改变，旧召回不可进入查询阶段', async change => {
  const pending = deferred<void>();
  vi.spyOn(engine, 'currentSummaryPromise').mockReturnValue(pending.promise);
  const recall = runVectorRecall(); await nextTick();
  if (change === 'chat') chatId = 'other';
  else ctx.chat.push(message(true, '另一个新输入'));
  scheduleDaily(); await recall;
  expect(recallDebug.status).toContain('召回失败');
  pending.resolve(); await nextTick();
  expect(rewrite.rewriteQuery).not.toHaveBeenCalled();
});
