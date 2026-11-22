import type { MemSummary } from '@/memory/types';
import { relatedHigherSummaries } from './higher-summary-confirmation';

export const SUMMARY_EDIT_NOTICE = '正文或摘要已修改，后续剧情可能与当前摘要不一致，请按需手动修订。';

export interface SummaryRevisionStep {
    hostId: string;
    level: number;
    floor?: number;
    label: string;
}

/** One upward traversal per edit; context citations are deliberately absent. */
export function higherRevisionSteps(summaries: readonly MemSummary[], source: string,
    floors: ReadonlyMap<string, number>, includeSource = false): SummaryRevisionStep[] {
    const related = relatedHigherSummaries(summaries, [source]);
    const sorted = [...summaries].sort((a, b) => a.level - b.level);
    const ranges = new Map<string, [number, number]>([...floors].map(([id, floor]) => [id, [floor, floor]]));
    for (const summary of sorted) {
        let lo = Infinity, hi = -Infinity;
        for (const child of summary.childIds) {
            const range = ranges.get(child);
            if (range) { lo = Math.min(lo, range[0]); hi = Math.max(hi, range[1]); }
        }
        if (Number.isFinite(lo)) ranges.set(summary.id, [lo, hi]);
    }
    return sorted.filter(summary => related.has(summary.id) || includeSource && summary.id === source).map(summary => {
        const range = ranges.get(summary.id);
        return { hostId: summary.id, level: summary.level,
            label: `L${summary.level} 总结${range ? ` · #${range[0]}${range[0] === range[1] ? '' : `–#${range[1]}`} 楼` : ''}` };
    });
}
