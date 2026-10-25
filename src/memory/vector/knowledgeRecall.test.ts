import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as engine from '../engine';
import * as index from './index';
import * as scope from './scope';
import * as store from './store';
import * as embed from './embed';
import * as rewrite from './rewrite';
import * as knowledge from './knowledge';
import { recallDebug } from './debug';
import * as contextRecall from './contextRecall';
import * as bm25 from './bm25';
import { clearRecallInjection, runVectorRecall } from './recall';

const original = JSON.parse(JSON.stringify(settings.apiSettings.vector));
const originalAutoHide = settings.apiSettings.autoHideEnabled;
let database: string;
let chatId: string;
let inject: ReturnType<typeof vi.fn>;
let file: knowledge.KnowledgeFile;
beforeEach(async () => {
  database = `recall-${crypto.randomUUID()}`; chatId = 'chat-A'; inject = vi.fn();
  const cache = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => cache.get(k) ?? null,
    setItem: (k: string, v: string) => cache.set(k, v), removeItem: (k: string) => cache.delete(k) });
  settings.apiSettings.vector.enabled = true;
  settings.apiSettings.vector.knowledge = { enabled: true, count: 1, threshold: 0.8, maxChars: 2000 };
  Object.assign(settings.apiSettings.vector.embedding, { url: 'https://example.test', model: 'test' });
  Object.assign(settings.apiSettings.vector.recall, { minAiFloors: 0, finalRecallCount: 1, fullTextCount: 0, embeddingThreshold: 0.8 });
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(scope, 'currentVectorDb').mockImplementation(() => database);
  vi.spyOn(scope, 'currentChatId').mockImplementation(() => chatId);
  vi.spyOn(scope, 'currentChatScope').mockImplementation(() => `chat:${chatId}`);
  vi.spyOn(scope, 'recallScopes').mockImplementation(() => [`chat:${chatId}`]);
  vi.spyOn(scope, 'currentBundleHashes').mockReturnValue([]);
  const chat = [{ is_user: false, mes: 'earlier' }, { is_user: true, mes: '问BB' }] as STMessage[];
  vi.spyOn(context, 'getContext').mockReturnValue({ chat, setExtensionPrompt: inject } as unknown as STContext);
  vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(1);
  vi.spyOn(index, 'ensureRecallIndex').mockResolvedValue(undefined);
  vi.spyOn(embed, 'embedTexts').mockImplementation(async texts => texts.map(() => new Float32Array([0, 1])));
  vi.spyOn(embed, 'rerankDocuments').mockResolvedValue([{ index: 0, score: 0.95 }]);
  vi.spyOn(rewrite, 'rewriteQuery').mockResolvedValue({ intent: 'BB', queries: ['BB'] });
  vi.spyOn(store, 'vecSearch').mockResolvedValue({ results: [{ leafId: 'old-leaf', scope: 'chat:chat-A',
    similarity: 0.95, queryIndex: 0, document: '旧剧情摘要', mesFull: '旧全文', storyTime: null, msgIndex: 0 }] });
  file = await knowledge.importKnowledge(database, '设定.md', '===', ['BB设定']);
  vi.mocked(embed.embedTexts).mockClear();
  clearRecallInjection(); inject.mockClear();
});
afterEach(() => { Object.assign(settings.apiSettings.vector, original); settings.apiSettings.autoHideEnabled = originalAutoHide; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const finalText = () => String(inject.mock.calls.at(-1)?.[1] ?? '');

it('自动隐藏开关均排除尚未隐藏的叶子，真正隐藏后才召回；切换开关失效旧缓存', async () => {
  const chat = context.getContext()!.chat;
  chat[0].extra = { bbs_leaf: { id: 'visible-old', text: 'visible summary', delta: {}, createdAt: 1, swipe: 0, v: 1 } };
  settings.apiSettings.autoHideEnabled = true;
  await runVectorRecall();
  expect(store.vecSearch).toHaveBeenLastCalledWith(database, expect.anything(), expect.anything(), expect.objectContaining({ excludeLeafIds: ['visible-old'] }));
  settings.apiSettings.autoHideEnabled = false;
  await runVectorRecall();
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
  expect(store.vecSearch).toHaveBeenLastCalledWith(database, expect.anything(), expect.anything(), expect.objectContaining({ excludeLeafIds: ['visible-old'] }));
  chat[0].is_system = true;
  await runVectorRecall();
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(3);
  expect(store.vecSearch).toHaveBeenLastCalledWith(database, expect.anything(), expect.anything(), expect.objectContaining({ excludeLeafIds: [] }));
});

it('摘要与知识库共享一次 query/embedding，独立额度并按摘要后顺序注入；再次运行命中缓存', async () => {
  const readAll = vi.spyOn(IDBIndex.prototype, 'getAll'), readOne = vi.spyOn(IDBObjectStore.prototype, 'get');
  await runVectorRecall();
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
  expect(embed.embedTexts).toHaveBeenCalledTimes(1);
  expect(finalText()).toContain('旧剧情摘要'); expect(finalText()).toContain('BB设定');
  expect(finalText().indexOf('【额外信息】')).toBeGreaterThan(finalText().indexOf('旧剧情摘要'));
  expect(readAll.mock.contexts.some(index => (index as IDBIndex).objectStore.name === 'files')).toBe(false);
  expect(readOne.mock.contexts.some(store => (store as IDBObjectStore).name === 'files')).toBe(false);
  expect(readOne.mock.contexts.filter(store => (store as IDBObjectStore).name === 'file_blocks')).toHaveLength(1);
  readAll.mockClear(); readOne.mockClear();
  const text = finalText(); await runVectorRecall();
  expect(finalText()).toBe(text); expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
  expect(readAll.mock.contexts.map(index => (index as IDBIndex).objectStore.name)).toEqual(['file_metadata', 'file_metadata']);
  expect(readOne).not.toHaveBeenCalled();
  settings.apiSettings.vector.knowledge.threshold = 1;
  await runVectorRecall(); expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
});

it('无窗口外摘要的新聊天仍召回知识库，不补建摘要索引', async () => {
  vi.mocked(engine.resolveKeepStart).mockReturnValue(0);
  await runVectorRecall();
  expect(index.ensureRecallIndex).not.toHaveBeenCalled(); expect(store.vecSearch).not.toHaveBeenCalled();
  expect(finalText()).toContain('BB设定'); expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
});

it('摘要没有候选也不跳过知识库；知识库阈值不改变摘要额度', async () => {
  vi.mocked(store.vecSearch).mockResolvedValueOnce({ results: [] });
  await runVectorRecall(); expect(finalText()).toContain('BB设定');
  await knowledge.setKnowledgeEnabled(file, false);
  await runVectorRecall(); expect(finalText()).toContain('旧剧情摘要'); expect(finalText()).not.toContain('BB设定');
});

it('召回中切聊天或取消，不把旧结果注入新聊天', async () => {
  vi.mocked(rewrite.rewriteQuery).mockImplementationOnce(async () => {
    chatId = 'chat-B'; return { intent: 'BB', queries: ['BB'] };
  });
  await runVectorRecall(); expect(inject.mock.calls.every(call => call[1] === '')).toBe(true);
  const signal = new AbortController();
  vi.mocked(rewrite.rewriteQuery).mockImplementationOnce(async () => {
    signal.abort(); return { intent: 'BB', queries: ['BB'] };
  });
  await runVectorRecall(signal.signal); expect(finalText()).toBe('');
});

it('召回中知识库被删除，丢弃旧命中，缓存不复用', async () => {
  vi.mocked(rewrite.rewriteQuery).mockImplementationOnce(async () => {
    await knowledge.deleteKnowledge(file); return { intent: 'BB', queries: ['BB'] };
  });
  await runVectorRecall(); expect(finalText()).toContain('旧剧情摘要'); expect(finalText()).not.toContain('BB设定');
  expect(recallDebug.knowledgeStatus).toBe('结果已失效');
  await runVectorRecall(); expect(finalText()).toContain('旧剧情摘要'); expect(finalText()).not.toContain('BB设定');
});

it('知识库读取失败不阻断摘要召回', async () => {
  vi.spyOn(knowledge, 'listKnowledgeMetadata').mockRejectedValue(new Error('storage unavailable'));
  await runVectorRecall(); expect(finalText()).toContain('旧剧情摘要');
});


it.each(['index', 'search', 'render'] as const)('摘要 %s 失败仍注入知识库，显示独立状态且不缓存失败', async stage => {
  if (stage === 'index') vi.mocked(index.ensureRecallIndex).mockRejectedValueOnce(new Error('index unavailable'));
  if (stage === 'search') vi.mocked(store.vecSearch).mockRejectedValueOnce(new Error('search unavailable'));
  if (stage === 'render') vi.spyOn(contextRecall, 'prioritizeRrf').mockImplementationOnce(() => { throw new Error('summary processing failed'); });
  await runVectorRecall();
  expect(finalText()).toContain('BB设定'); expect(finalText()).not.toContain('旧剧情摘要');
  expect(recallDebug.status).toBe('降级召回');
  expect(recallDebug.summaryStatus).toContain('失败');
  expect(recallDebug.knowledgeStatus).toBe('已注入');
  await runVectorRecall();
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
  expect(finalText()).toContain('旧剧情摘要');
});

it('无命中与检索失败分开显示，短状态按汉字和英文单词计数', async () => {
  vi.mocked(store.vecSearch).mockResolvedValueOnce({ results: [] });
  await runVectorRecall();
  expect(recallDebug.summaryStatus).toBe('未命中'); expect(recallDebug.knowledgeStatus).toBe('已注入');
  for (const label of [recallDebug.status, `摘要：${recallDebug.summaryStatus}`, `知识库：${recallDebug.knowledgeStatus}`])
    expect(label.match(/[\p{Script=Han}]|[A-Za-z]+|[0-9]+/gu)?.length ?? 0).toBeLessThanOrEqual(10);
});


it.each(['BM25', 'rerank'] as const)('%s 失败且摘要无可用结果时不误报未命中', async stage => {
  settings.apiSettings.vector.recall.embeddingThreshold = 1;
  if (stage === 'BM25') {
    settings.apiSettings.vector.recall.bm25Candidates = 1;
    vi.spyOn(bm25, 'searchBm25').mockRejectedValueOnce(new Error('BM25 unavailable'));
    vi.mocked(store.vecSearch).mockResolvedValueOnce({ results: [] });
  } else vi.mocked(embed.rerankDocuments).mockRejectedValueOnce(new Error('rerank unavailable'));
  await runVectorRecall();
  expect(recallDebug.summaryStatus).toContain(stage);
  expect(recallDebug.summaryStatus).toContain('失败');
  expect(recallDebug.knowledgeStatus).toBe('已注入');
  expect(finalText()).toContain('BB设定'); expect(finalText()).not.toContain('旧剧情摘要');
});

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const vectorResult = (): Awaited<ReturnType<typeof store.vecSearch>> => ({ results: [{ leafId: 'old-leaf', scope: 'chat:chat-A',
  similarity: .95, queryIndex: 0, document: '旧剧情摘要', mesFull: '旧全文', storyTime: null, msgIndex: 0 }] });
const lexicalResult = { hits: [], persistent: true };
const knowledgeResult: knowledge.KnowledgeRecallResult = { text: '并行 BB 设定', status: '已命中', hits: [{ name: '设定.md', block: 1, score: 1 }] };

it.each(['knowledge-first', 'vector-first'])('三路在任何一路完成前均启动，%s 完成顺序不改变注入和成功缓存', async order => {
  settings.apiSettings.vector.recall.bm25Candidates = 2;
  const kb = pending<knowledge.KnowledgeRecallResult>(), lexical = pending<typeof lexicalResult>(), vector = pending<ReturnType<typeof vectorResult>>();
  const knowledgeSearch = vi.spyOn(knowledge, 'searchKnowledge').mockReturnValue(kb.promise);
  const lexicalSearch = vi.spyOn(bm25, 'searchBm25').mockReturnValue(lexical.promise);
  vi.mocked(store.vecSearch).mockReturnValue(vector.promise);
  const run = runVectorRecall();
  await vi.waitFor(() => {
    expect(knowledgeSearch).toHaveBeenCalledTimes(1); expect(lexicalSearch).toHaveBeenCalledTimes(1); expect(store.vecSearch).toHaveBeenCalledTimes(1);
  });
  expect(finalText()).toBe('');
  const signal = knowledgeSearch.mock.calls[0][4];
  expect(lexicalSearch.mock.calls[0][1]).toBe(signal); expect(vi.mocked(store.vecSearch).mock.calls[0][3]?.signal).toBe(signal);
  if (order === 'knowledge-first') { kb.resolve(knowledgeResult); lexical.resolve(lexicalResult); vector.resolve(vectorResult()); }
  else { vector.resolve(vectorResult()); lexical.resolve(lexicalResult); kb.resolve(knowledgeResult); }
  await run;
  expect(finalText()).toContain('旧剧情摘要'); expect(finalText()).toContain('并行 BB 设定');
  expect(finalText().indexOf('旧剧情摘要')).toBeLessThan(finalText().indexOf('并行 BB 设定'));
  expect(recallDebug.status).toBe('召回完成');
  const text = finalText(); await runVectorRecall();
  expect(finalText()).toBe(text); expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
});

it.each(['knowledge', 'lexical', 'vector'])('并行 %s 失败保留其他路线并允许下一轮重试', async failed => {
  settings.apiSettings.vector.recall.bm25Candidates = 2;
  const kb = vi.spyOn(knowledge, 'searchKnowledge'), lexical = vi.spyOn(bm25, 'searchBm25').mockResolvedValue(lexicalResult);
  if (failed === 'knowledge') kb.mockRejectedValueOnce(new Error('knowledge unavailable'));
  if (failed === 'lexical') lexical.mockRejectedValueOnce(new Error('lexical unavailable'));
  if (failed === 'vector') vi.mocked(store.vecSearch).mockRejectedValueOnce(new Error('vector unavailable'));
  await runVectorRecall();
  expect(recallDebug.status).toBe('降级召回');
  if (failed !== 'knowledge') expect(finalText()).toContain('BB设定');
  if (failed !== 'vector') expect(finalText()).toContain('旧剧情摘要');
  await runVectorRecall();
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
  expect(finalText()).toContain('BB设定'); expect(finalText()).toContain('旧剧情摘要');
});

it('三路挂起时取消及时结束，新轮完成后旧结果不覆盖调试状态或注入', async () => {
  settings.apiSettings.vector.recall.bm25Candidates = 2;
  const kb = pending<knowledge.KnowledgeRecallResult>(), lexical = pending<typeof lexicalResult>(), vector = pending<ReturnType<typeof vectorResult>>();
  const knowledgeSearch = vi.spyOn(knowledge, 'searchKnowledge').mockReturnValueOnce(kb.promise);
  const lexicalSearch = vi.spyOn(bm25, 'searchBm25').mockResolvedValue(lexicalResult).mockReturnValueOnce(lexical.promise);
  vi.mocked(store.vecSearch).mockReturnValueOnce(vector.promise);
  const old = runVectorRecall();
  await vi.waitFor(() => expect(store.vecSearch).toHaveBeenCalledTimes(1));
  clearRecallInjection('合成取消'); await old;
  expect(knowledgeSearch.mock.calls[0][4]?.aborted).toBe(true);
  expect(lexicalSearch.mock.calls[0][1]?.aborted).toBe(true);
  expect(vi.mocked(store.vecSearch).mock.calls[0][3]?.signal?.aborted).toBe(true);
  await runVectorRecall();
  const text = finalText(), debug = JSON.stringify([recallDebug, knowledge.knowledgeDebug]);
  kb.resolve(knowledgeResult); lexical.resolve(lexicalResult); vector.resolve(vectorResult());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(finalText()).toBe(text); expect(JSON.stringify([recallDebug, knowledge.knowledgeDebug])).toBe(debug);
  expect(text).not.toContain('并行 BB 设定'); expect(text).toContain('BB设定');
});

it('知识检索先完成后文件改变，只丢弃知识，保留仍有效的并行摘要', async () => {
  const vector = pending<ReturnType<typeof vectorResult>>();
  vi.spyOn(knowledge, 'searchKnowledge').mockResolvedValue(knowledgeResult);
  vi.mocked(store.vecSearch).mockReturnValueOnce(vector.promise);
  const run = runVectorRecall();
  await vi.waitFor(() => expect(store.vecSearch).toHaveBeenCalledTimes(1));
  await knowledge.setKnowledgeEnabled(file, false);
  vector.resolve(vectorResult()); await run;
  expect(finalText()).toContain('旧剧情摘要'); expect(finalText()).not.toContain('并行 BB 设定');
  expect(recallDebug.knowledgeStatus).toBe('结果已失效');
});
