import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { apiSettings } from '@/api/settings';
import * as embed from './embed';
import { localStore } from './store';
import { deleteKnowledge, editKnowledge, embeddingIdentity, eligibleKnowledge, importKnowledge, knowledgeFingerprint,
  knowledgeScope, knowledgeText, listKnowledge, readKnowledgeFile, readKnowledgeSource, recallKnowledge, setKnowledgeEnabled, splitKnowledge } from './knowledge';

const original = structuredClone(JSON.parse(JSON.stringify(apiSettings.vector)));
const config = { enabled: true, count: 3, threshold: 0.8, maxChars: 6000 };
let database: string;
beforeEach(() => {
  database = `test-${crypto.randomUUID()}`;
  Object.assign(apiSettings.vector.embedding, { url: 'https://example.test', model: 'synthetic', key: '' });
  vi.spyOn(embed, 'embedTexts').mockImplementation(async texts => texts.map(text => text.includes('BB')
    ? new Float32Array([0, 1]) : new Float32Array([1, 0])));
});
afterEach(() => { Object.assign(apiSettings.vector, original); vi.restoreAllMocks(); });

it('只按完整分隔行切分，不把行内等号或 Markdown 正文拆开；跳过空块', () => {
  expect(splitKnowledge('\uFEFF设定AA\r\n=========\r\n\r\n=========\r\n# 设定BB\n行内=========保留', '=========')).toEqual(['设定AA', '# 设定BB\n行内=========保留']);
  expect(splitKnowledge('AA\n.*\nBB', '.*')).toEqual(['AA', 'BB']);
  expect(() => splitKnowledge('AA', '')).toThrow();
  expect(() => splitKnowledge('AA', '\n===\n')).toThrow('单行');
  expect(() => splitKnowledge('a'.repeat(24001), '===')).toThrow('24000');
});

it('TXT/MD 编码读取，拒绝超限及不支持格式', async () => {
  expect(await readKnowledgeFile(new File(['AA\n===\nBB'], '设定.MD'), '===')).toEqual(['AA', 'BB']);
  expect(await readKnowledgeFile(new File([new Uint8Array([0xff, 0xfe, 65, 0])], 'a.txt'), '===', 'utf-16le')).toEqual(['A']);
  await expect(readKnowledgeFile(new File(['doc'], 'a.doc'), '===')).rejects.toThrow('TXT');
  await expect(readKnowledgeFile(new File([new Uint8Array([0xff])], 'a.txt'), '===')).rejects.toThrow();
});

it('真实本地向量检索只返回 BB，不连带 AA；重读持久化、角色隔离、停用和删除', async () => {
  const file = await importKnowledge(database, '设定.txt', '=========', ['设定AA', '设定BB']);
  const reloaded = await listKnowledge(database);
  expect(reloaded).toEqual([file]);
  expect(await listKnowledge(`${database}-other`)).toEqual([]);
  const query = [embed.encodeFloat32Base64(new Float32Array([0, 1]))];
  const text = await recallKnowledge(database, reloaded, query, config);
  expect(text).toContain('设定BB'); expect(text).not.toContain('设定AA');
  expect(text).toContain('第2块');
  expect(await recallKnowledge(database, reloaded, query, { ...config, maxChars: 2 })).toBe('');
  expect(await recallKnowledge(database, reloaded, query, { ...config, count: 0 })).toBe('');
  await setKnowledgeEnabled(reactive(file), false);
  expect(knowledgeFingerprint(await listKnowledge(database))).not.toBe(knowledgeFingerprint(reloaded));
  expect(await recallKnowledge(database, await listKnowledge(database), query, config)).toBe('');
  await deleteKnowledge((await listKnowledge(database))[0]);
  expect(await listKnowledge(database)).toEqual([]);
  expect((await localStore.stats(database, [knowledgeScope(file)])).stats[knowledgeScope(file)]).toBe(0);
});

it('跨批次失败和取消不发布半成品，也不影响已导入的文件', async () => {
  const good = await importKnowledge(database, 'good.txt', '===', ['AA']);
  vi.mocked(embed.embedTexts).mockResolvedValueOnce(Array.from({ length: 16 }, () => new Float32Array([1, 0])))
    .mockRejectedValueOnce(new Error('service failed'));
  await expect(importKnowledge(database, 'bad.txt', '===', Array(17).fill('BB'))).rejects.toThrow('service failed');
  expect(await listKnowledge(database)).toEqual([good]);
  const abort = new AbortController();
  await expect(importKnowledge(database, 'cancel.txt', '===', ['BB'], abort.signal, () => abort.abort())).rejects.toThrow();
  expect(await listKnowledge(database)).toEqual([good]);
});

it('模型切换后禁用不兼容向量，导入中途切换不发布', async () => {
  const file = await importKnowledge(database, 'old.md', '===', ['AA']);
  apiSettings.vector.embedding.model = 'new';
  expect(embeddingIdentity()).not.toBe(file.embedding);
  expect(eligibleKnowledge([file], config)).toEqual([]);
  await expect(importKnowledge(database, 'changed.md', '===', ['BB'], undefined,
    () => { apiSettings.vector.embedding.model = 'another'; })).rejects.toThrow('配置已改变');
  expect(await listKnowledge(database)).toEqual([file]);
});

it('新导入保存并重读完整原文，旧版只显示明确的分隔符还原文本', async () => {
  const raw = '\uFEFF  # AA\r\n\r\n === \r\n  BB  \r\n\r\n';
  const source = await readKnowledgeSource(new File([raw], 'raw.md'), '===');
  expect(source).toEqual({ text: raw, chunks: ['# AA', 'BB'] });
  const file = await importKnowledge(database, 'raw.md', '===', source.text);
  expect((await listKnowledge(database))[0]).toMatchObject({ sourceText: raw, sourceVersion: 1 });
  expect(knowledgeText(file)).toBe(raw);
  const legacy = await importKnowledge(database, 'legacy.txt', '===', ['AA', 'BB']);
  expect(legacy.sourceText).toBeUndefined();
  expect(knowledgeText(legacy)).toBe('AA\n===\nBB');
});

it('未改变原文不调用服务；编辑保存后重新分块向量化且身份、角色、停用状态不变', async () => {
  let file = await importKnowledge(database, 'edit.md', '===', '  AA  \n===\nBB\n');
  vi.mocked(embed.embedTexts).mockClear();
  expect(await editKnowledge(file, knowledgeText(file))).toEqual(file);
  expect(embed.embedTexts).not.toHaveBeenCalled();
  await setKnowledgeEnabled(file, false); file = (await listKnowledge(database))[0];
  const raw = '  BB 新内容\r\n===\r\n\r\n第三块\r\n===\r\n第四块  \n';
  const updated = await editKnowledge(file, raw);
  expect(updated).toMatchObject({ id: file.id, name: file.name, database, delimiter: '===', enabled: false,
    sourceText: raw, sourceVersion: 1, chunks: ['BB 新内容', '第三块', '第四块'], embedding: embeddingIdentity(), indexError: '' });
  expect(updated.revision).not.toBe(file.revision);
  expect(await listKnowledge(database)).toEqual([updated]);
  expect((await localStore.stats(database, [knowledgeScope(file)])).stats[knowledgeScope(file)]).toBe(0);
  expect((await localStore.stats(database, [knowledgeScope(updated)])).stats[knowledgeScope(updated)]).toBe(3);
  expect(await listKnowledge(`${database}-other`)).toEqual([]);
});

it('拒绝空文、过大区块、过多区块及二进制文本，不改文件也不调用向量服务', async () => {
  const file = await importKnowledge(database, 'edit.txt', '===', 'AA');
  vi.mocked(embed.embedTexts).mockClear();
  for (const raw of ['', ' \n===\n ', 'A'.repeat(24001), Array(1001).fill('AA').join('\n===\n'), 'AA\0BB']) {
    await expect(editKnowledge(file, raw)).rejects.toThrow();
    expect(await listKnowledge(database)).toEqual([file]);
  }
  expect(embed.embedTexts).not.toHaveBeenCalled();
});

it('跨批次向量化失败保留新原文、撤销旧向量并暂停召回，重试同文会重新向量化', async () => {
  const file = await importKnowledge(database, 'edit.txt', '===', 'AA');
  const raw = Array(17).fill('BB').join('\n===\n');
  vi.mocked(embed.embedTexts).mockResolvedValueOnce(Array.from({ length: 16 }, () => new Float32Array([0, 1])))
    .mockRejectedValueOnce(new Error('service failed'));
  await expect(editKnowledge(file, raw)).rejects.toThrow('service failed');
  const failed = (await listKnowledge(database))[0];
  expect(failed).toMatchObject({ sourceText: raw, enabled: true, embedding: '', indexError: 'Error: service failed' });
  expect(eligibleKnowledge([failed], config)).toEqual([]);
  for (const scope of [knowledgeScope(file), knowledgeScope(failed)]) {
    expect((await localStore.stats(database, [scope])).stats[scope]).toBe(0);
  }
  const retried = await editKnowledge(failed, raw);
  expect(retried).toMatchObject({ sourceText: raw, embedding: embeddingIdentity(), indexError: '' });
  expect(eligibleKnowledge([retried], config)).toEqual([retried]);
  expect((await localStore.stats(database, [knowledgeScope(retried)])).stats[knowledgeScope(retried)]).toBe(17);
});

it('取消保存后不发布向量；更换模型时旧请求也不能被当作新模型结果', async () => {
  let file = await importKnowledge(database, 'edit.txt', '===', 'AA');
  const abort = new AbortController();
  await expect(editKnowledge(file, 'BB', abort.signal, () => abort.abort())).rejects.toThrow();
  file = (await listKnowledge(database))[0];
  expect(file.sourceText).toBe('BB'); expect(file.embedding).toBe('');
  await expect(editKnowledge(file, 'BB', undefined, () => { apiSettings.vector.embedding.model = 'changed'; })).rejects.toThrow('配置已改变');
  const failed = (await listKnowledge(database))[0];
  expect(failed.embedding).toBe('');
  expect((await localStore.stats(database, [knowledgeScope(failed)])).stats[knowledgeScope(failed)]).toBe(0);
});

function deferEmbedding() {
  let release!: (vectors: Float32Array[]) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(embed.embedTexts).mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  return { started, release: () => release([new Float32Array([0, 1])]) };
}

it('编辑期间停用不回滚正文或被完成回调重新启用；旧编辑快照不能覆盖新版本', async () => {
  const file = await importKnowledge(database, 'edit.txt', '===', 'AA');
  const wait = deferEmbedding(), saving = editKnowledge(file, 'BB 新文');
  await wait.started;
  const pending = (await listKnowledge(database))[0];
  expect(pending).toMatchObject({ sourceText: 'BB 新文', embedding: '' });
  expect(eligibleKnowledge([pending], config)).toEqual([]);
  await setKnowledgeEnabled(file, false); // A stale UI row may only change the enabled flag.
  await expect(editKnowledge(file, '旧编辑')).rejects.toThrow('其他操作中改变');
  wait.release(); const result = await saving;
  expect(result).toMatchObject({ sourceText: 'BB 新文', enabled: false, embedding: embeddingIdentity() });
});

it('两个编辑使用独立向量代次，先发后到的旧结果和旧错误不能覆盖新编辑', async () => {
  const file = await importKnowledge(database, 'edit.txt', '===', 'AA');
  const wait = deferEmbedding(), first = editKnowledge(file, 'BB 第一版');
  await wait.started;
  const pending = (await listKnowledge(database))[0];
  const second = await editKnowledge(pending, '最终版');
  wait.release(); await expect(first).rejects.toThrow('更新操作取代');
  expect(await listKnowledge(database)).toEqual([second]);
  expect((await localStore.stats(database, [knowledgeScope(pending)])).stats[knowledgeScope(pending)]).toBe(0);
  expect((await localStore.stats(database, [knowledgeScope(second)])).stats[knowledgeScope(second)]).toBe(1);
  expect(await recallKnowledge(database, [second], [embed.encodeFloat32Base64(new Float32Array([1, 0]))], config)).toContain('最终版');
});

it('编辑期间删除不复活文件，向量删除失败仍保留可恢复但不可召回的原文', async () => {
  const file = await importKnowledge(database, 'edit.txt', '===', 'AA');
  const wait = deferEmbedding(), saving = editKnowledge(file, 'BB');
  await wait.started; await deleteKnowledge(file);
  wait.release(); await expect(saving).rejects.toThrow('更新操作取代');
  expect(await listKnowledge(database)).toEqual([]);
  const another = await importKnowledge(database, 'keep.txt', '===', 'AA 保留');
  vi.spyOn(localStore, 'clearScope').mockRejectedValueOnce(new Error('storage failure'));
  await expect(deleteKnowledge(another)).rejects.toThrow('storage failure');
  expect((await listKnowledge(database))[0]).toMatchObject({ sourceText: 'AA 保留', enabled: false, embedding: '' });
});

it('召回检索期间编辑失效旧快照，不把旧向量结果用于新文本', async () => {
  const file = await importKnowledge(database, 'edit.txt', '===', 'AA');
  const search = localStore.search.bind(localStore);
  vi.spyOn(localStore, 'search').mockImplementationOnce(async (...args) => {
    const result = await search(...args);
    await editKnowledge(file, 'BB 新文本');
    return result;
  });
  const query = [embed.encodeFloat32Base64(new Float32Array([1, 0]))];
  expect(await recallKnowledge(database, [file], query, config)).toBe('');
});
