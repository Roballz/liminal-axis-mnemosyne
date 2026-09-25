import { nameKey, type RecallContext } from '../contextTags';
import { candidateKey, type HybridHit } from './hybrid';

export interface ContextRecallSettings {
  rrfContextEnabled: boolean;
  rrfOtherEmbeddingThreshold: number;
  rrfBm25Exemption: number;
  rrfAssociationBoost: number;
}
export interface ContextHit extends HybridHit {
  contextPriority: boolean;
  contextReason: string;
  contextScore: number;
}
/** Only the independent RRF summary lane uses this list. Raw lists/scores stay intact. */
export function prioritizeRrf(fused: HybridHit[], lexical: HybridHit[], context: RecallContext | undefined, cfg: ContextRecallSettings): ContextHit[] {
  const active = cfg.rrfContextEnabled && !!context;
  const names = new Set(context?.participants.map(nameKey) ?? []);
  const plans = new Set(context?.planIds ?? []), events = new Set(context?.eventIds ?? []);
  const exempt = new Set(lexical.slice(0, Math.max(0, Math.floor(cfg.rrfBm25Exemption || 0))).map(candidateKey));
  const threshold = Number.isFinite(cfg.rrfOtherEmbeddingThreshold) ? Math.max(0, Math.min(1, cfg.rrfOtherEmbeddingThreshold)) : .9;
  const boost = Number.isFinite(cfg.rrfAssociationBoost) ? Math.max(0, Math.min(.5, cfg.rrfAssociationBoost)) : .15;
  return fused.map(hit => {
    const tags = hit.tags;
    const present = tags?.participants?.some(n => names.has(nameKey(n)));
    const high = hit.similarity !== null && hit.similarity >= threshold;
    const lexicalTop = exempt.has(candidateKey(hit));
    const priority = !active || !names.size || !!present || !!tags?.public || high || lexicalTop;
    const related = active && (tags?.planIds.some(id => plans.has(id)) || tags?.eventIds.some(id => events.has(id)));
    return { ...hit, contextPriority: priority,
      contextReason: !active ? '未启用' : !names.size ? '人物未确定' : present ? '在场人物' : tags?.public ? '公开'
        : high ? '向量高相关例外' : lexicalTop ? 'BM25 前列例外' : tags?.participants === undefined ? '旧摘要/人物未知补位' : '其他人物补位',
      // One bounded relative bonus, even when several plans/events match. Never a rerank score.
      contextScore: (hit.rrfScore ?? 0) * (related ? 1 + boost : 1),
    };
  }).sort((a, b) => Number(b.contextPriority) - Number(a.contextPriority) || b.contextScore - a.contextScore);
}
