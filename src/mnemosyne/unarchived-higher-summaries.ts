import type { MemSummary } from '@/memory/types';
import type { CapturedView } from './model';

export type UnarchivedHigherSummary = Pick<MemSummary, 'id' | 'level' | 'text'>;

/** Retired host summaries remain real, persistent drafts. Show them for explicit
 * review without fabricating an archived revision or approving current children. */
export function unarchivedHigherSummaryRows(view: Pick<CapturedView, 'memories'>,
    summaries: readonly MemSummary[]): UnarchivedHigherSummary[] {
    const selected = new Set(view.memories.map(memory => memory.hostId));
    return summaries.filter(summary => summary.level > 0 && !summary.imported && summary.childIds.length &&
        !selected.has(summary.id)).map(({ id, level, text }) => ({ id, level, text }))
        .sort((a, b) => a.level - b.level);
}
