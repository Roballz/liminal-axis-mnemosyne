import { sameNarrativeRevision, summarySources } from './canonical';
import { sourceRefMatches } from './source-equivalence';
import type { Transaction } from './db';
import type { EventView } from './events';
import { inheritForkEvents } from './fork-events';
import { row, type Binding, type Branch, type CapturedView, type Memory, type MemoryRevision, type MemoryView, type Review } from './model';

/** Copy a validated fixed-prefix projection inside the fork transaction, with new branch-local IDs. */
export async function inheritForkMemory(tx: Transaction, parent: CapturedView, branch: Branch,
    binding: Binding, selection: MemoryView, events: EventView) {
    const ids = new Map(events.valid.map(m => [m.id, row('mr').id]));
    const families = new Map<string, Memory>();
    for (const memory of events.valid) {
        const original = await tx.get<Memory>('memories', memory.owner);
        if (!original) throw new Error('继承摘要身份缺失');
        const family: Memory = { ...original, ...row('mem'), owner: binding.id };
        families.set(memory.owner, family);
        await tx.add('memories', family);
    }
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
    const historical = new Map<string, string>();
    const copyDependency = async (id: string): Promise<string> => {
        const selected = await equivalent(id);
        if (selected) return selected;
        if (historical.has(id)) return historical.get(id)!;
        const prior = await tx.get<MemoryRevision>('memory_revisions', id);
        const family = prior && families.get(prior.owner);
        if (!prior || !family) return id;
        const key = row('mr').id;
        historical.set(id, key);
        // Keep the old narrative unselected, in the same child family as the approved
        // replacement. A copied review must not compare parent and child family IDs.
        await tx.add('memory_revisions', { ...prior, id: key, branch: branch.id, owner: family.id,
            dependencies: await Promise.all(prior.dependencies.map(copyDependency)) } as MemoryRevision);
        return key;
    };
    for (const memory of events.valid) {
        const family = families.get(memory.owner)!;
        const copied = { ...memory, id: ids.get(memory.id)!, branch: branch.id, owner: family.id,
            dependencies: await Promise.all(memory.dependencies.map(copyDependency)) };
        await tx.add('memory_revisions', copied);
        selection.selections[family.id] = copied.id;
        // Parent-confirmed role-only repairs remain exact approvals on the copied summary.
        const sources = await summarySources(tx, memory);
        const resolved = sources.map(r => parent.refs.find(p => sourceRefMatches(parent.branch, r, p)));
        if (resolved.every(Boolean) && sources.some((r, i) => r.revision !== resolved[i]!.revision)) {
            const coverage = memory.coverage.map(r => parent.refs.find(p => sourceRefMatches(parent.branch, r, p)));
            if (coverage.every(Boolean)) await tx.add('reviews', { ...row('review'), story: branch.story,
                branch: branch.id, owner: copied.id, snapshot: branch.head, decision: 'compatible', origin: 'manual',
                // An explicit copied dependency review below has precedence over role-only compatibility.
                created: 0, reviewSchema: 2, sourceRefs: resolved, coverage, dependencies: copied.dependencies } as Review);
        }
    }
    // Preserve existing explicit approvals; never manufacture an approval for an invalid source.
    for (const review of await tx.all<Review>('reviews', 'branch', parent.branch.id)) {
        const owner = await equivalent(review.owner);
        if (!owner) continue;
        if (review.reviewSchema !== 2 && review.snapshot !== parent.snapshot.id) continue;
        const sourceRefs = review.sourceRefs?.map(r => parent.refs.find(p => sourceRefMatches(parent.branch, r, p)));
        const coverage = review.coverage?.map(r => parent.refs.find(p => sourceRefMatches(parent.branch, r, p)));
        if (sourceRefs?.some(r => !r) || coverage?.some(r => !r)) continue;
        if (review.dependencies && (await Promise.all(review.dependencies.map(equivalent))).some(id => !id)) continue;
        await tx.add('reviews', { ...review, ...row('review'), branch: branch.id, owner, snapshot: branch.head,
            ...(sourceRefs ? { sourceRefs } : {}), ...(coverage ? { coverage } : {}),
            ...(review.dependencies ? { dependencies: await mapIds(review.dependencies) } : {}) } as Review);
    }
    await inheritForkEvents(tx, parent, branch, events.cards, mapIds);
}
