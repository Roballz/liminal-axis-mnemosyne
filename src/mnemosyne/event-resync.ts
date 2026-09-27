import type { Library } from './db';
import { capture, current, statuses, summarySources } from './canonical';
import { eventView, type EventCard } from './events';
import { inheritForkEvents } from './fork-events';
import { sourceRefsMatch } from './source-equivalence';
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
    const signature = (m: MemoryRevision) => [m.hostId, m.content, m.level, m.anchor, m.storyTime, m.seed, m.recall, m.visibility];
    await lib.transaction(STORES, 'readonly', async tx => {
        for (const source of projection.valid) {
            const candidates = valid.filter(m => equal(signature(m), signature(source)));
            if (candidates.length !== 1) continue;
            const target = candidates[0];
            if (sourceRefsMatch(child.branch, await summarySources(tx, source), await summarySources(tx, target)) &&
                sourceRefsMatch(child.branch, source.coverage, target.coverage)) ids.set(source.id, target.id);
        }
        // Higher summaries also need the same selected dependencies, not just equal prose.
        let changed = true;
        while (changed) {
            changed = false;
            for (const source of projection.valid) {
                const target = valid.find(m => m.id === ids.get(source.id));
                if (!target) continue;
                const resolve = async (id: string, selection: MemoryRevision[]) => {
                    const prior = await tx.get<MemoryRevision>('memory_revisions', id);
                    const next = prior && selection.find(m => m.owner === prior.owner);
                    // Both high summaries already passed statuses (including explicit
                    // dependency approvals). Compare their currently selected families.
                    return next?.id ?? id;
                };
                const a = await Promise.all(source.dependencies.map(async id => ids.get(await resolve(id, projection.valid))));
                const b = await Promise.all(target.dependencies.map(id => resolve(id, valid)));
                if (a.some(id => !id) || !equal(a, b)) { ids.delete(source.id); changed = true; }
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
    const legacyMatch = (source: EventCard, target: EventChain) => {
        const rows = childRows.get(target.id)!;
        const signature = (r: EventRevision) => [r.created, r.title, r.status, r.keywords];
        return !target.inheritance && target.created === source.chain.created && rows.revisions.length === 1 &&
            [source.meta, ...(source.history?.revisions ?? [])].some(r => equal(signature(r), signature(rows.revisions[0])));
    };
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
        const exact = childChains.filter(c => c.inheritance?.branch === parent.branch.id && c.inheritance.event === card.chain.id);
        const candidates = exact.length ? exact : childChains.filter(c => legacyMatch(card, c));
        if (candidates.length > 1 || candidates.some(c => claimed.has(c.id) || (!c.inheritance && projection.cards.filter(p => legacyMatch(p, c)).length > 1))) {
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
            const uncertain = childChains.filter(c => !c.inheritance && !projection.cards.some(p => legacyMatch(p, c)));
            if (uncertain.some(c => childRows.get(c.id)!.revisions.some(r => r.title === card.meta.title))) {
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
    for (const chain of parentChains.filter(c => !projection.cards.some(p => p.chain.id === c.id)))
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
