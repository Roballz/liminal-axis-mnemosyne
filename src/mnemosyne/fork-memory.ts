import { dependencyOnly, sameNarrativeRevision, summarySources } from './canonical';
import { sourceRefResolver } from './source-equivalence';
import { sourcePrefixes } from './source-prefixes';
import { reviewMatchesMemory, sameSourceMessages } from './review-source-integrity';
import type { Transaction } from './db';
import type { EventView } from './events';
import { inheritForkEvents } from './fork-events';
import { row, type Binding, type Block, type Branch, type CapturedView, type Memory, type MemoryRevision, type MemoryView, type Review, type Snapshot, type SourceRef } from './model';

/** Copy a validated fixed-prefix projection inside the fork transaction, with new branch-local IDs. */
export async function inheritForkMemory(tx: Transaction, parent: CapturedView, branch: Branch,
    binding: Binding, selection: MemoryView, events: EventView) {
    const ids = new Map(events.valid.map(m => [m.id, row('mr').id]));
    const selectedByOwner = new Map<string, MemoryRevision>();
    for (const memory of events.valid) if (!selectedByOwner.has(memory.owner)) selectedByOwner.set(memory.owner, memory);
    const resolveRef = sourceRefResolver(parent.branch, parent.refs);
    const revisionRows = new Map<string, MemoryRevision | undefined>(events.valid.map(m => [m.id, m]));
    const revisions = new Map<string, Promise<MemoryRevision | undefined>>(events.valid.map(m => [m.id, Promise.resolve(m)]));
    const readRevision = (id: string) => {
        if (!revisions.has(id)) revisions.set(id, tx.get<MemoryRevision>('memory_revisions', id).then(memory => {
            revisionRows.set(id, memory); return memory;
        }));
        return revisions.get(id)!;
    };
    const families = new Map<string, Memory>();
    const originals = await Promise.all(events.valid.map(memory => tx.get<Memory>('memories', memory.owner)));
    for (const [index, memory] of events.valid.entries()) {
        const original = originals[index];
        if (!original) throw new Error('继承摘要身份缺失');
        const family: Memory = { ...original, ...row('mem'), owner: binding.id };
        families.set(memory.owner, family);
        await tx.add('memories', family);
    }
    // Metadata-only revisions can retain dependencies on an equivalent older revision.
    const equivalents = new Map<string, Promise<string | undefined>>();
    const equivalent = (id: string) => {
        if (!equivalents.has(id)) equivalents.set(id, (async () => {
            if (ids.has(id)) return ids.get(id)!;
            const prior = await readRevision(id), next = prior && selectedByOwner.get(prior.owner);
            return prior && next && sameNarrativeRevision(prior, next) ? ids.get(next.id) : undefined;
        })());
        return equivalents.get(id)!;
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
        const prior = await readRevision(id);
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
        if (parent.branch.sourceRoleRepairSchema === 1 && parent.branch.sourceRoleRepairs?.length) {
            const sources = await summarySources(tx, memory);
            const resolved = sources.map(resolveRef);
            if (resolved.every(Boolean) && sources.some((r, i) => r.revision !== resolved[i]!.revision)) {
                const coverage = memory.coverage.map(resolveRef);
                if (coverage.every(Boolean)) await tx.add('reviews', { ...row('review'), story: branch.story,
                    branch: branch.id, owner: copied.id, snapshot: branch.head, decision: 'compatible', origin: 'manual',
                    // An explicit copied dependency review below has precedence over role-only compatibility.
                    created: 0, reviewSchema: 2, sourceRefs: resolved, coverage, dependencies: copied.dependencies } as Review);
            }
        }
    }
    // Preserve existing explicit approvals; never manufacture an approval for an invalid source.
    const inherited = (await Promise.all((await tx.all<Review>('reviews', 'branch', parent.branch.id))
        .filter(review => !('disabled' in review) && review.decision === 'compatible' &&
            ['manual', 'generated_sidecar'].includes(review.origin) && Number.isSafeInteger(review.created))
        .map(async review => ({ review, owner: await equivalent(review.owner), memory: await readRevision(review.owner) }))))
        .filter((item): item is { review: Review; owner: string; memory: MemoryRevision } => !!item.owner && !!item.memory);
    const modern = inherited.filter(({ review }) => review.reviewSchema === 2);
    await Promise.all([...new Set(modern.flatMap(({ memory, review }) =>
        [...memory.dependencies, ...(Array.isArray(review.dependencies) ? review.dependencies : [])]))]
        .filter(id => typeof id === 'string' && id).map(readRevision));
    const legacyBases = [...new Set(modern.filter(({ memory }) =>
        !memory.sourceRecovery && !memory.inputRefs.length && !dependencyOnly(memory)).map(({ memory }) => memory.basis))];
    const snapshots = (await Promise.all(legacyBases.map(id => tx.get<Snapshot>('history_snapshots', id))))
        .filter((snapshot): snapshot is Snapshot => !!snapshot);
    const blocks = (await Promise.all([...new Set(snapshots.flatMap(snapshot => snapshot.blocks))]
        .map(id => tx.get<Block>('manifest_blocks', id)))).filter((block): block is Block => !!block);
    const prefixes = sourcePrefixes(parent.branch, parent.refs, snapshots, blocks);
    for (const { review, owner, memory } of inherited) {
        if (review.reviewSchema === 2) {
            const basis = prefixes.get(memory.basis);
            const required = !memory.inputRefs.length && !dependencyOnly(memory)
                ? basis && (memory.anchor ? basis.through(memory.anchor) : basis.length) : undefined;
            const matchesSources = (approved: readonly SourceRef[]) => !memory.inputRefs.length && !dependencyOnly(memory)
                ? !!basis && required !== undefined && basis.matchesMessages(approved, required)
                : sameSourceMessages(approved, memory.inputRefs);
            if (!reviewMatchesMemory(review, memory, matchesSources, revisionRows)) continue;
        } else if (['reviewSchema', 'sourceRefs', 'coverage', 'dependencies'].some(key => key in review) ||
            review.snapshot !== parent.snapshot.id || review.story !== memory.story || review.branch !== memory.branch) continue;
        const sourceRefs = review.sourceRefs?.map(resolveRef);
        const coverage = review.coverage?.map(resolveRef);
        if (sourceRefs?.some(r => !r) || coverage?.some(r => !r)) continue;
        const dependencies = review.dependencies && await Promise.all(review.dependencies.map(equivalent));
        if (dependencies?.some(id => !id)) continue;
        await tx.add('reviews', { ...review, ...row('review'), branch: branch.id, owner, snapshot: branch.head,
            ...(sourceRefs ? { sourceRefs } : {}), ...(coverage ? { coverage } : {}),
            ...(dependencies ? { dependencies } : {}) } as Review);
    }
    await inheritForkEvents(tx, parent, branch, events.cards, mapIds);
    // Table history can refer to an older, now unselected summary. Preserve that evidence
    // locally without selecting it or promoting it to valid recall material.
    const tableEvidence = new Map<string, string>();
    const copyTableEvidence = async (id: string): Promise<string | undefined> => {
        const selected = await equivalent(id);
        if (selected) return selected;
        if (tableEvidence.has(id)) return tableEvidence.get(id)!;
        const prior = await readRevision(id);
        if (!prior) return undefined;
        let family = families.get(prior.owner);
        if (!family) {
            const original = await tx.get<Memory>('memories', prior.owner);
            if (!original) return undefined;
            family = { ...original, ...row('mem'), owner: binding.id };
            families.set(prior.owner, family);
            await tx.add('memories', family);
        }
        const key = row('mr').id; tableEvidence.set(id, key);
        const dependencies = await Promise.all(prior.dependencies.map(copyTableEvidence));
        if (dependencies.some(id => !id)) throw new Error('继承表格历史来源依赖缺失');
        await tx.add('memory_revisions', { ...prior, id: key, branch: branch.id, owner: family.id,
            dependencies: dependencies as string[] } as MemoryRevision);
        return key;
    };
    return copyTableEvidence;
}
