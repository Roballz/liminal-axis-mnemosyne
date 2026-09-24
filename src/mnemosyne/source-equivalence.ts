import type { Branch, CapturedView, Revision, SourceRef } from './model';

/** Directional and exact: a confirmation never blesses a future revision or another message. */
export function sourceRefMatches(branch: Branch, before: SourceRef, after: SourceRef | undefined): boolean {
    return !!after && before.message === after.message && (before.revision === after.revision ||
        (branch.sourceRoleRepairSchema === 1 && !!branch.sourceRoleRepairs?.some(pair =>
            pair.before.message === before.message && pair.before.revision === before.revision &&
            pair.after.message === after.message && pair.after.revision === after.revision)));
}
export function sourceRefsMatch(branch: Branch, before: SourceRef[], after: SourceRef[]): boolean {
    return before.length === after.length && before.every((ref, i) => sourceRefMatches(branch, ref, after[i]));
}
export function sourceContent(view: CapturedView, ref: SourceRef): string | undefined {
    const current = view.refs.find(r => sourceRefMatches(view.branch, ref, r));
    return current ? view.sources.get(current.revision)?.content : undefined;
}
export function isRoleOnlyPair(before: Revision, after: Revision): boolean {
    return before.owner === after.owner && before.story === after.story &&
        before.role === 'system' && after.role === 'assistant' && before.content === after.content &&
        before.provenance.hostKey === after.provenance.hostKey && before.provenance.swipe === after.provenance.swipe;
}
