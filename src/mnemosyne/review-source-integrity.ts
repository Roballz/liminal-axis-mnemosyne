import type { MemoryRevision, Review, SourceRef } from './model';

/** Reviews may approve newer source versions, never a different set of messages. */
export function sameSourceMessages(left: readonly SourceRef[], right: readonly SourceRef[]): boolean {
    return left.length === right.length && left.every((ref, i) => !!ref && ref.message === right[i]?.message);
}

/** Pure provenance check shared by live eligibility and branch inheritance. The
 * caller supplies an indexed legacy prefix so no full history is copied here. */
export function reviewMatchesMemory(review: Review, memory: MemoryRevision,
    matchesSources: (approved: readonly SourceRef[]) => boolean,
    revisions: ReadonlyMap<string, MemoryRevision | undefined>): boolean {
    if ('disabled' in review || memory.sourceRecovery || review.reviewSchema !== 2 ||
        review.story !== memory.story || review.branch !== memory.branch ||
        review.decision !== 'compatible' || !['manual', 'generated_sidecar'].includes(review.origin) ||
        !Array.isArray(review.sourceRefs) || !Array.isArray(review.coverage) || !Array.isArray(review.dependencies) ||
        !matchesSources(review.sourceRefs) || !sameSourceMessages(review.coverage, memory.coverage) ||
        review.dependencies.length !== memory.dependencies.length) return false;
    return review.dependencies.every((id, i) => {
        if (id === review.owner || id === memory.id) return false;
        const approved = revisions.get(id), original = revisions.get(memory.dependencies[i]);
        return !!approved && !!original && approved.owner === original.owner &&
            approved.story === memory.story && original.story === memory.story &&
            approved.branch === memory.branch && original.branch === memory.branch;
    });
}
