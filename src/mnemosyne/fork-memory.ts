import { sameNarrativeRevision, summarySources } from './canonical';
import { sourceRefMatches } from './source-equivalence';
import type { Transaction } from './db';
import type { EventView } from './events';
import { row, type Binding, type Branch, type CapturedView, type Memory, type MemoryView, type Review, type EventRevision, type Membership, type Progress } from './model';

/** Copy a validated fixed-prefix projection inside the fork transaction, with new branch-local IDs. */
export async function inheritForkMemory(tx: Transaction, parent: CapturedView, branch: Branch,
    binding: Binding, selection: MemoryView, events: EventView) {
    const ids = new Map(events.valid.map(m => [m.id, row('mr').id]));
    // Metadata-only revisions can retain dependencies on an equivalent older revision.
    const equivalent = async (id: string) => {
        if (ids.has(id)) return ids.get(id)!;
        const prior = await tx.get<import('./model').MemoryRevision>('memory_revisions', id);
        const next = prior && events.valid.find(m => m.owner === prior.owner);
        return prior && next && sameNarrativeRevision(prior, next) ? ids.get(next.id) : undefined;
    };
    const mapIds = async (values: string[]) => {
        const result = await Promise.all(values.map(equivalent));
        if (result.some(id => !id)) throw new Error('继承摘要依赖不完整，请先审核父分支');
        return result as string[];
    };
    for (const memory of events.valid) {
        const original = await tx.get<Memory>('memories', memory.owner);
        if (!original) throw new Error('继承摘要身份缺失');
        const family: Memory = { ...original, ...row('mem'), owner: binding.id };
        await tx.add('memories', family);
        const copied = { ...memory, id: ids.get(memory.id)!, branch: branch.id, owner: family.id,
            // Unselected historical dependencies stay immutable provenance; copied explicit
            // reviews below supply the approved current dependencies when applicable.
            dependencies: await Promise.all(memory.dependencies.map(async id => await equivalent(id) ?? id)) };
        await tx.add('memory_revisions', copied);
        selection.selections[family.id] = copied.id;
        // Parent-confirmed role-only repairs remain exact approvals on the copied summary.
        const sources = await summarySources(tx, memory);
        const resolved = sources.map(r => parent.refs.find(p => sourceRefMatches(parent.branch, r, p)));
        if (resolved.every(Boolean) && sources.some((r, i) => r.revision !== resolved[i]!.revision)) {
            const coverage = memory.coverage.map(r => parent.refs.find(p => sourceRefMatches(parent.branch, r, p)));
            if (coverage.every(Boolean)) await tx.add('reviews', { ...row('review'), story: branch.story,
                branch: branch.id, owner: copied.id, snapshot: branch.head, decision: 'compatible', origin: 'manual',
                created: Date.now(), reviewSchema: 2, sourceRefs: resolved, coverage, dependencies: copied.dependencies } as Review);
        }
    }
    // Preserve existing explicit approvals; never manufacture an approval for an invalid source.
    for (const review of await tx.all<Review>('reviews', 'branch', parent.branch.id)) {
        const owner = await equivalent(review.owner);
        if (!owner) continue;
        if (review.reviewSchema !== 2 && review.snapshot !== parent.snapshot.id) continue;
        const sourceRefs = review.sourceRefs?.map(r => parent.refs.find(p => p.message === r.message && p.revision === r.revision));
        const coverage = review.coverage?.map(r => parent.refs.find(p => p.message === r.message && p.revision === r.revision));
        if (sourceRefs?.some(r => !r) || coverage?.some(r => !r)) continue;
        if (review.dependencies && (await Promise.all(review.dependencies.map(equivalent))).some(id => !id)) continue;
        await tx.add('reviews', { ...review, ...row('review'), branch: branch.id, owner, snapshot: branch.head,
            ...(review.dependencies ? { dependencies: await mapIds(review.dependencies) } : {}) } as Review);
    }
    for (const card of events.cards) {
        if (card.blocked || card.needsReview) continue;
        const chain = { ...card.chain, ...row('ev'), branch: branch.id };
        const base = { branch: branch.id, owner: chain.id, snapshot: branch.head, cutoff: parent.cutoff, epoch: branch.epoch };
        await tx.add('event_chains', chain);
        await tx.add('event_revisions', { ...card.meta, ...row('er'), ...base,
            refs: await mapIds(card.meta.refs),
            ...(card.meta.summarized ? { summarized: await mapIds(card.meta.summarized) } : {}),
            ...(card.meta.latestProgress ? { latestProgress: { ...card.meta.latestProgress,
                memory: (await mapIds([card.meta.latestProgress.memory]))[0] } } : {}) } as EventRevision);
        for (const member of card.members)
            await tx.add('event_memberships', { ...member, ...row('link'), ...base, memory: (await mapIds([member.memory]))[0] } as Membership);
        for (const progress of card.progress)
            await tx.add('event_progress', { ...progress, ...row('ep'), ...base, memories: await mapIds(progress.memories) } as Progress);
    }
}
