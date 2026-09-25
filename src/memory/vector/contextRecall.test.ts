import { expect, it } from 'vitest';
import { normalizeTags } from '../contextTags';
import { prioritizeRrf } from './contextRecall';
import { fuseCandidates, selectRecall, type HybridHit } from './hybrid';

const cfg = { rrfContextEnabled: true, rrfOtherEmbeddingThreshold: .9, rrfBm25Exemption: 1, rrfAssociationBoost: .15 };
const context = { participants: ['甲'], planIds: ['P'], eventIds: ['E'] };
const hit = (id: string, score: number, extra: Partial<HybridHit> = {}): HybridHit => ({ scope: 'chat:A', leafId: id,
  document: `摘要${id}`, mesFull: `正文${id}`, storyTime: null, msgIndex: 1, similarity: .5, queryIndex: 0,
  rrfScore: score, tags: normalizeTags({ participants: ['乙'] }), ...extra });
const limits = { rerankCandidates: 20, bm25Candidates: 20, fusionCandidates: 20, bm25Count: 2, rrfCount: 2,
  fullTextCount: 0, finalRecallCount: 6, embeddingThreshold: .8, rerankThreshold: .9 };

it('全量RRF后优先在场/公开/高相关例外，旧数据和其他人物仍可补位', () => {
  const inputs = [hit('other', .04), hit('unknown', .035, { tags: undefined }),
    hit('present', .03, { tags: normalizeTags({ participants: ['甲'] }) }),
    hit('public', .025, { tags: normalizeTags({ public: { reason: '新闻报道' } }) }),
    hit('high', .02, { similarity: .92 }), hit('lexical', .018, { similarity: null })];
  const ranked = prioritizeRrf(inputs, [inputs.at(-1)!], context, cfg);
  expect(ranked.map(h => h.leafId)).toEqual(['present', 'public', 'high', 'lexical', 'other', 'unknown']);
  expect(ranked.find(h => h.leafId === 'public')?.rrfScore).toBe(.025);
  expect(prioritizeRrf(inputs, [], undefined, cfg).map(h => h.leafId)).toEqual(inputs.map(h => h.leafId));
  expect(prioritizeRrf(inputs, [], { ...context, participants: [] }, cfg).map(h => h.leafId)).toEqual(inputs.map(h => h.leafId));
});

it('事件和计划只加一次有限分，不改原RRF分、向量分或原始榜', () => {
  const a = hit('A', .030), b = hit('B', .029, { tags: normalizeTags({ participants: ['甲'], planIds: ['P'], eventIds: ['E'] }) });
  const baseline = JSON.stringify([a, b]);
  const ranked = prioritizeRrf([a, b], [], { ...context, participants: [] }, cfg);
  expect(ranked[0].leafId).toBe('B');
  expect(ranked[0].contextScore).toBeCloseTo(.029 * 1.15);
  expect(ranked[0].rrfScore).toBe(.029);
  expect(JSON.stringify([a, b])).toBe(baseline);
});

it('只有RRF摘要名额使用筛后榜，原文/BM25/向量及跨路顺延继续工作', () => {
  const bm = [hit('B1', .032), hit('B2', .031)];
  const vector = [hit('V1', .034, { similarity: .85 }), hit('V2', .033, { similarity: .84 })];
  const preferred = ['P1', 'P2'].map(id => hit(id, .01, { tags: normalizeTags({ participants: ['甲'] }) }));
  const rrf = prioritizeRrf([...vector, ...bm, ...preferred], bm, context, cfg);
  const chosen = selectRecall([], bm, vector, limits, rrf);
  expect(chosen.map(s => [s.route, s.hit.leafId])).toEqual([['bm25','B1'], ['bm25','B2'], ['rrf','P1'], ['rrf','P2'], ['vector','V1'], ['vector','V2']]);
  const full = selectRecall([{ ...preferred[0], rerankScore: .95 }], bm, vector, { ...limits, fullTextCount: 1 }, rrf);
  expect(full.filter(s => s.hit.leafId === 'P1')).toHaveLength(1);
  expect(full.find(s => s.hit.leafId === 'P1')?.tier).toBe('full');
  expect(full.find(s => s.route === 'rrf')?.hit.leafId).toBe('P2');
  const sparse = selectRecall([], [], [], { ...limits, finalRecallCount: 2 }, prioritizeRrf([preferred[0], vector[0]], [], context, cfg));
  expect(sparse.map(s => s.hit.leafId)).toEqual(['P1', 'V1']);
});

it('同摘要的两路原始名次融合后再筛，不重新编号；低排名相关项不会先被top20截掉', () => {
  const vector = Array.from({length: 25}, (_, i) => hit(`v${i}`, 0));
  vector[24].tags = normalizeTags({ participants: ['甲'] });
  const fused = fuseCandidates(vector, [], 25);
  const selected = prioritizeRrf(fused, [], context, { ...cfg, rrfBm25Exemption: 0 });
  expect(selected[0].leafId).toBe('v24');
  expect(selected[0].rrfScore).toBe(1 / 85);
});
