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
/** Call-local lookup preserving first matching ref and directional role repairs. */
export function sourceRefResolver(branch: Branch, refs: SourceRef[]): (before: SourceRef) => SourceRef | undefined {
    const messages = new Map<string, SourceRef[]>(), resolved = new Map<string, Map<string, SourceRef | undefined>>();
    for (const ref of refs) { const rows = messages.get(ref.message) ?? []; rows.push(ref); messages.set(ref.message, rows); }
    return before => {
        let revisions = resolved.get(before.message);
        if (!revisions) { revisions = new Map(); resolved.set(before.message, revisions); }
        if (!revisions.has(before.revision)) revisions.set(before.revision,
            messages.get(before.message)?.find(after => sourceRefMatches(branch, before, after)));
        return revisions.get(before.revision);
    };
}
export function sourceContent(view: CapturedView, ref: SourceRef): string | undefined {
    const current = view.refs.find(r => sourceRefMatches(view.branch, ref, r));
    return current ? view.sources.get(current.revision)?.content : undefined;
}
export function isRoleOnlyPair(before: Revision, after: Revision): boolean {
    return before.owner === after.owner && before.story === after.story &&
        before.role === 'system' && after.role === 'assistant' &&
        ((typeof before.content === 'string' && typeof after.content === 'string' && before.content === after.content) ||
            (before.bodySchema === 1 && after.bodySchema === 1 && typeof before.bodyHash === 'string' &&
                before.bodyHash === after.bodyHash && Number.isSafeInteger(before.bodyLength) && before.bodyLength === after.bodyLength)) &&
        before.provenance.hostKey === after.provenance.hostKey && before.provenance.swipe === after.provenance.swipe;
}
