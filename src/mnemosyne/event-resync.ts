import type { Library } from './db';
import { capture, current, statuses, summarySources } from './canonical';
import { eventView, type EventCard } from './events';
import { inheritForkEvents } from './fork-events';
import { sourceRefMatches, sourceRefsMatch } from './source-equivalence';
import { STORES, check, equal, type Branch, type CapturedView, type EventChain, type EventRevision, type Membership, type Progress, type MemoryRevision } from './model';

export interface EventResyncPlan {
    parent: CapturedView;
    child: CapturedView;
    parentChains: EventChain[];
    childChains: EventChain[];
    cards: EventCard[];
    ids: Map<string, string>;
    replacements: Map<string, string>;
    entries: { title: string; archived: boolean; action: 'add' | 'replace' | 'skip'; reason: string }[];
}
/** Read only: use the saved fork snapshot/length, never the parent's latest chat tail. */
export async function previewEventResync(lib: Library, child: CapturedView): Promise<EventResyncPlan> {
    const fork = child.branch.fork;
    check(fork, '当前档案没有父分支，不能重新继承事件链');
    const parent = await capture(lib, fork.branch, Math.min(fork.length, child.cutoff), fork.snapshot);
    const projection = await eventView(lib, parent, true);
    const states = await statuses(lib, child);
    const valid = child.memories.filter(m => states.get(m.id) === 'valid');
    const ids = new Map<string, string>();
    const signature = (m: MemoryRevision) => JSON.stringify([m.hostId, m.content, m.level, m.anchor, m.storyTime, m.seed, m.recall, m.visibility]);
    const candidatesBySignature = new Map<string, MemoryRevision[]>(), validById = new Map(valid.map(m => [m.id, m]));
    for (const memory of valid) {
        const key = signature(memory), candidates = candidatesBySignature.get(key) ?? [];
        candidates.push(memory); candidatesBySignature.set(key, candidates);
    }
    const parentPositions = new Map(parent.refs.map((ref, index) => [ref.message, index]));
    const childPositions = new Map(child.refs.map((ref, index) => [ref.message, index]));
    await lib.transaction(STORES, 'readonly', async tx => {
        const sourcesById = new Map<string, Promise<import('./model').SourceRef[]>>();
        const sourcesOf = (memory: MemoryRevision) => {
            if (!sourcesById.has(memory.id)) sourcesById.set(memory.id, summarySources(tx, memory));
            return sourcesById.get(memory.id)!;
        };
        for (const source of projection.valid) {
            const candidates = candidatesBySignature.get(signature(source)) ?? [];
            if (candidates.length !== 1) continue;
            const target = candidates[0];
            const sources = await sourcesOf(source);
            const floors = [...sources, ...source.coverage].map(ref => ref.message);
            if (source.anchor) floors.push(source.anchor);
            // Identical text may reuse a SourceRef after a swipe. Re-inheritance must
            // still match the child's actual material, not only equal summary text.
            const sameFloors = floors.every(message => {
                const index = parentPositions.get(message);
                return index !== undefined && childPositions.get(message) === index &&
                    sourceRefMatches(child.branch, parent.refs[index], child.refs[index]) &&
                    parent.snapshot.variants?.[index] === child.snapshot.variants?.[index];
            });
            if (sameFloors && sourceRefsMatch(child.branch, sources, await sourcesOf(target)) &&
                sourceRefsMatch(child.branch, source.coverage, target.coverage)) ids.set(source.id, target.id);
        }
        // Higher summaries also need the same selected dependencies, not just equal prose.
        const revisions = new Map<string, Promise<MemoryRevision | undefined>>();
        const resolver = (selection: MemoryRevision[]) => {
            const owners = new Map<string, MemoryRevision>(), resolved = new Map<string, Promise<string>>();
            for (const memory of selection) if (!owners.has(memory.owner)) owners.set(memory.owner, memory);
            return (id: string) => {
                if (!resolved.has(id)) resolved.set(id, (async () => {
                    if (!revisions.has(id)) revisions.set(id, tx.get<MemoryRevision>('memory_revisions', id));
                    const prior = await revisions.get(id)!;
                    // Both summaries passed statuses, including explicit dependency approvals.
                    return prior && owners.get(prior.owner)?.id || id;
                })());
                return resolved.get(id)!;
            };
        };
        const parentDependency = resolver(projection.valid), childDependency = resolver(valid);
        const dependencies = new Map<string, { parent: string[]; child: string[] }>();
        const dependents = new Map<string, Set<string>>();
        for (const source of projection.valid) {
            const target = validById.get(ids.get(source.id) ?? '');
            if (!target) continue;
            const [parent, child] = await Promise.all([
                Promise.all(source.dependencies.map(parentDependency)), Promise.all(target.dependencies.map(childDependency)),
            ]);
            dependencies.set(source.id, { parent, child });
            for (const id of parent) {
                const users = dependents.get(id) ?? new Set(); users.add(source.id); dependents.set(id, users);
            }
        }
        // Removing a child mapping invalidates only its ancestors. The mapping is
        // consulted again each time, so approved-family dependency failures still cascade.
        const queue = [...dependencies.keys()], pending = new Set(queue);
        for (let i = 0; i < queue.length; i++) {
            const id = queue[i]; pending.delete(id);
            if (!ids.has(id)) continue;
            const dependency = dependencies.get(id)!, mapped = dependency.parent.map(id => ids.get(id));
            if (mapped.some(id => !id) || !equal(mapped, dependency.child)) {
                ids.delete(id);
                for (const user of dependents.get(id) ?? []) if (ids.has(user) && !pending.has(user)) {
                    pending.add(user); queue.push(user);
                }
            }
        }
    });
    const parentChains = await lib.all<EventChain>('event_chains', 'branch', parent.branch.id);
    const childChains = await lib.all<EventChain>('event_chains', 'branch', child.branch.id);
    const childRows = await lib.transaction(STORES, 'readonly', async tx => new Map(await Promise.all(childChains.map(async c => [c.id, {
        revisions: await tx.all<EventRevision>('event_revisions', 'owner', c.id),
        memberships: await tx.all<Membership>('event_memberships', 'owner', c.id),
        progress: await tx.all<Progress>('event_progress', 'owner', c.id),
    }] as const))));
    const eventSignature = (created: number, r: EventRevision) => JSON.stringify([created, r.created, r.title, r.status, r.keywords]);
    const exactByEvent = new Map<string, EventChain[]>(), legacyBySignature = new Map<string, EventChain[]>();
    for (const chain of childChains) {
        if (chain.inheritance?.branch === parent.branch.id) {
            const matches = exactByEvent.get(chain.inheritance.event) ?? [];
            matches.push(chain); exactByEvent.set(chain.inheritance.event, matches);
        }
        const rows = childRows.get(chain.id)!;
        if (!chain.inheritance && rows.revisions.length === 1) {
            const key = eventSignature(chain.created, rows.revisions[0]), matches = legacyBySignature.get(key) ?? [];
            matches.push(chain); legacyBySignature.set(key, matches);
        }
    }
    const legacyByEvent = new Map<string, EventChain[]>(), matchCounts = new Map<string, number>();
    for (const card of projection.cards) {
        const matches = new Map<string, EventChain>();
        for (const key of new Set([card.meta, ...(card.history?.revisions ?? [])].map(r => eventSignature(card.chain.created, r))))
            for (const chain of legacyBySignature.get(key) ?? []) matches.set(chain.id, chain);
        legacyByEvent.set(card.chain.id, [...matches.values()]);
        for (const id of matches.keys()) matchCounts.set(id, (matchCounts.get(id) ?? 0) + 1);
    }
    const uncertainTitles = new Set(childChains.filter(c => !c.inheritance && !matchCounts.has(c.id))
        .flatMap(c => childRows.get(c.id)!.revisions.map(r => r.title)));
    const plan: EventResyncPlan = { parent, child, parentChains, childChains, ids, cards: [], replacements: new Map(), entries: [] };
    const claimed = new Set<string>();
    const revisionIds = (m: EventCard['meta']) => [...m.refs, ...(m.summarized ?? []), ...(m.latestProgress ? [m.latestProgress.memory] : [])];
    for (const card of projection.cards) {
        const entry: EventResyncPlan['entries'][number] = { title: card.meta.title, archived: !!card.chain.archived, action: 'skip', reason: '' };
        plan.entries.push(entry);
        const needed = [...revisionIds(card.meta), ...card.members.map(m => m.memory), ...card.progress.flatMap(p => p.memories)];
        if (card.blocked || card.needsReview || needed.some(id => !ids.has(id))) {
            entry.reason = '来源摘要缺失、已修改或待审核'; continue;
        }
        const exact = exactByEvent.get(card.chain.id) ?? [];
        const candidates = exact.length ? exact : legacyByEvent.get(card.chain.id) ?? [];
        if (candidates.length > 1 || candidates.some(c => claimed.has(c.id) || (!c.inheritance && (matchCounts.get(c.id) ?? 0) > 1))) {
            entry.reason = '存在多个可能对应的事件'; continue;
        }
        const target = candidates[0];
        if (target) {
            claimed.add(target.id);
            const history = childRows.get(target.id)!;
            const rows = [...history.revisions, ...history.memberships, ...history.progress];
            const receipt = target.inheritance;
            const untouched = receipt
                ? rows.every(r => r.epoch <= receipt.epoch) && !!target.archived === receipt.archived
                : rows.every(r => r.epoch === 1) && !!target.archived === !!card.chain.archived;
            if (!untouched) { entry.reason = '子分支已修改，或旧版来源无法可靠确认'; continue; }
            if (receipt?.key === card.inheritanceKey) { entry.reason = '已同步，无需重复继承'; continue; }
            plan.replacements.set(card.chain.id, target.id);
            entry.action = 'replace'; entry.reason = '补齐／更新未修改的继承事件';
        } else {
            // An old event with an uncertain identity must not silently become a duplicate.
            if (uncertainTitles.has(card.meta.title)) {
                entry.reason = '已有同名事件，无法可靠确认来源'; continue;
            }
            entry.action = 'add'; entry.reason = '补回缺失事件';
        }
        const history = card.history!;
        plan.cards.push({ ...card, history: {
            revisions: history.revisions.filter(r => revisionIds(r).every(id => ids.has(id))),
            memberships: history.memberships.filter(r => ids.has(r.memory)),
            progress: history.progress.filter(r => r.memories.every(id => ids.has(id))),
        } });
    }
    const projectedIds = new Set(projection.cards.map(card => card.chain.id));
    for (const chain of parentChains.filter(c => !projectedIds.has(c.id)))
        plan.entries.push({ title: '父档案中的事件', archived: !!chain.archived, action: 'skip', reason: '分叉点前无可用版本或来源已失效' });
    check(await current(lib, parent) && await current(lib, child), '档案已改变，请重新预览');
    return plan;
}

/** Only event records change; summaries, sources, bindings and the parent remain untouched. */
export async function commitEventResync(lib: Library, plan: EventResyncPlan, guard: () => boolean = () => true) {
    return lib.transaction(STORES, 'readwrite', async tx => {
        check(guard() && equal(await tx.get('branches', plan.parent.branch.id), plan.parent.branch) &&
            equal(await tx.get('branches', plan.child.branch.id), plan.child.branch) &&
            equal(await tx.all('event_chains', 'branch', plan.parent.branch.id), plan.parentChains) &&
            equal(await tx.all('event_chains', 'branch', plan.child.branch.id), plan.childChains), '档案或事件已改变，请重新预览');
        if (!plan.cards.length) return 0;
        const branch: Branch = { ...plan.child.branch, epoch: Math.max(plan.child.branch.epoch, plan.parent.branch.epoch) + 1 };
        const mapIds = async (values: string[]) => values.map(id => { const mapped = plan.ids.get(id); check(mapped, '继承来源不完整'); return mapped; });
        await inheritForkEvents(tx, plan.parent, branch, plan.cards, mapIds, plan.replacements);
        check(guard(), '聊天已改变，本次重新继承已撤销');
        await tx.put('branches', branch);
        return plan.cards.length;
    });
}
