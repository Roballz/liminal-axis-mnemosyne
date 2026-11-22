import type { MemoryRevision, SourceRef } from './model';
import { manualPrefixCandidate } from './stored-source-prefix';

/** Generation context is historical evidence, not a live edge between L0 summaries. */
export const summaryDependencies = (memory: MemoryRevision): readonly string[] =>
    memory.level > 0 ? memory.dependencies : [];

export const localSummaryFallback = (memory: MemoryRevision) => memory.level === 0 && !!memory.anchor &&
    !memory.coverage.length && (!memory.inputRefs.length || manualPrefixCandidate(memory));

/** Explicit coverage belongs to this summary. A legacy applicability prefix does
 * not make every earlier turn its source. Keep unusual explicit input groups and
 * inputs beyond the anchor intact: they still constrain cutoffs and inheritance. */
export function ownSummarySources(memory: MemoryRevision, basisRefs: readonly SourceRef[], previousUser?: string): readonly SourceRef[] {
    if (memory.level > 0 && memory.dependencies.length) return [];
    if (memory.coverage.length) return memory.coverage;
    if (memory.inputRefs.length && !localSummaryFallback(memory)) return memory.inputRefs;
    if (memory.level === 0 && memory.anchor) {
        const anchor = basisRefs.findIndex(ref => ref.message === memory.anchor);
        if (anchor < 0) return [];
        const start = anchor > 0 && basisRefs[anchor - 1].message === previousUser ? anchor - 1 : anchor;
        return basisRefs.slice(start, anchor + 1);
    }
    return basisRefs;
}
