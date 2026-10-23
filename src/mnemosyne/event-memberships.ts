/** Human membership editing. No host writes, model calls or source-body reads. */
import { Library } from './db';
import { eventView, type EventCard } from './events';
import { check, row, type Branch, type CapturedView, type EventChain, type EventRevision, type Membership } from './model';
import { statuses } from './canonical';

export interface MembershipHint {
    id: string;
    title: string;
    archived: boolean;
    needsReview: boolean;
}
export type MembershipProjection = Map<string, MembershipHint[]>;
/** Retained links remain visible even when an overview/source needs review. */
export function membershipProjection(view: CapturedView, cards: EventCard[]): MembershipProjection {
    const result: MembershipProjection = new Map();
    const memories = new Map(view.memories.map(m => [m.id, m]));
    for (const card of cards) for (const member of card.members) {
        const memory = memories.get(member.memory);
        if (!memory || memory.level !== 0) continue;
        const list = result.get(memory.hostId) ?? [];
        if (!list.some(item => item.id === card.chain.id)) list.push({ id: card.chain.id, title: card.meta.title,
            archived: !!card.chain.archived, needsReview: !!card.needsReview || !!card.blocked });
        result.set(memory.hostId, list);
    }
    return result;
}
export interface MembershipRequest {
    /** Replace is single-summary only; bulk mode never removes other links. */
    mode: 'replace' | 'add';
    memories: string[];
    eventIds: string[];
    newTitle?: string;
}
export interface MembershipResult { added: number; removed: number; already: number; created: string | null }
export async function saveMemberships(lib: Library, view: CapturedView, request: MembershipRequest,
    guard: () => boolean = () => true): Promise<MembershipResult> {
    const keys = [...new Set(request.memories)], targets = new Set(request.eventIds);
    check(keys.length > 0, '请先选择摘要');
    check(request.mode === 'add' || (request.mode === 'replace' && keys.length === 1), '一次只修改一条摘要的完整关联');
    check(request.mode !== 'add' || targets.size + (request.newTitle === undefined ? 0 : 1) === 1, '批量加入请选择一条目标链');
    const title = request.newTitle?.trim();
    check(request.newTitle === undefined || !!title && title.length <= 300, '事件链名称需为1至300字');
    const selected = keys.map(id => view.memories.find(m => m.id === id));
    check(selected.every(m => m && m.level === 0 && !m.seed && m.story === view.branch.story && m.branch === view.branch.id), '摘要不属于当前分支或不是逐楼摘要');
    check(new Set(selected.map(m => m!.owner)).size === keys.length, '摘要身份重复，请刷新');
    const projection = await eventView(lib, view);
    const cards = new Map(projection.cards.map(card => [card.chain.id, card]));
    check([...targets].every(id => cards.has(id)), '事件不存在或不属于当前分支');
    const changes: { card: EventCard | null; adds: string[]; removes: string[] }[] = [];
    let already = 0;
    for (const card of projection.cards) {
        const members = new Set(card.members.map(m => m.memory));
        const adds = targets.has(card.chain.id) ? keys.filter(id => !members.has(id)) : [];
        const removes = request.mode === 'replace' && !targets.has(card.chain.id) ? keys.filter(id => members.has(id)) : [];
        if (targets.has(card.chain.id)) already += keys.filter(id => members.has(id)).length;
        if (adds.length || removes.length) changes.push({ card, adds, removes });
    }
    if (title) changes.push({ card: null, adds: keys, removes: [] });
    for (const change of changes) check(change.adds.every(id => projection.validity.get(id) === 'valid'), '请先审核来源摘要；无效摘要只能解除已有关联');
    return lib.transaction(['branches', 'event_chains', 'event_revisions', 'event_memberships'], 'readwrite', async tx => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(guard() && branch && branch.story === view.branch.story && branch.epoch === view.branch.epoch &&
            branch.head === view.branch.head && branch.view === view.branch.view && view.snapshot.id === branch.head && view.cutoff === view.snapshot.length,
            '聊天、摘要或事件已改变，请重新打开');
        const result: MembershipResult = { added: 0, removed: 0, already, created: null };
        if (!changes.length) return result;
        branch.epoch++;
        for (const change of changes) {
            let eventId = change.card?.chain.id;
            if (eventId) {
                const chain = await tx.get<EventChain>('event_chains', eventId);
                check(chain?.branch === branch.id && chain.story === branch.story, '事件已删除或不属于当前分支');
            } else {
                eventId = row('ev').id;
                await tx.add('event_chains', { id: eventId, schema: 1, story: branch.story, branch: branch.id, created: Date.now() } as EventChain);
                result.created = eventId;
            }
            const base = { story: branch.story, branch: branch.id, owner: eventId, snapshot: view.snapshot.id, cutoff: view.cutoff, epoch: branch.epoch };
            const meta = change.card?.meta;
            await tx.add('event_revisions', { ...(meta ?? { eventSchema: 2, title, status: 'open', keywords: [], overview: '', summarized: [], refs: [], latestProgress: null }),
                ...row('er'), ...base, created: Date.now() } as EventRevision);
            for (const [active, ids] of [[true, change.adds], [false, change.removes]] as const) for (const memory of ids) {
                await tx.add('event_memberships', { ...row('link'), ...base, memory, active, kind: 'progress', origin: 'manual', locked: true } as Membership);
                if (active) result.added++; else result.removed++;
            }
        }
        check(guard(), '聊天已改变，本次关联未保存');
        await tx.put('branches', branch);
        return result;
    });
}

/** Inclusive, displayed host floors. Reject malformed/out-of-bounds input instead of silently clipping. */
export function parseFloorRanges(text: string, maxFloor: number): Set<number> | null {
    if (!text.trim()) return null;
    const floors = new Set<number>();
    for (const token of text.trim().replace(/\s*([-–—])\s*/g, '$1').split(/[,，、\s]+/)) {
        const match = /^#?(\d+)(?:\s*[-–—]\s*#?(\d+))?$/.exec(token);
        check(match, '楼层格式例如 100-150,180');
        const lo = Number(match[1]), hi = Number(match[2] ?? match[1]);
        check(Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo <= hi && lo >= 0 && hi <= maxFloor, `楼层范围需在 #0 至 #${maxFloor} 内，起点不能大于终点`);
        for (let floor = lo; floor <= hi; floor++) floors.add(floor);
    }
    return floors;
}

/**
 * Materialize validated, generated summary eventIds as ordinary AI memberships.
 * Only current confirmed leaf revisions qualify; missing/reviewed/blocked events
 * and stale sources cannot be promoted. No network/model calls or host writes.
 * Transactionally advancing the branch epoch makes retries idempotent.
 */
export async function syncGeneratedEventMemberships(lib: Library, view: CapturedView,
    guard: () => boolean = () => true): Promise<boolean> {
    const validity = await statuses(lib, view);
    const leaves = view.memories.filter(m => m.level === 0 && !m.seed && validity.get(m.id) === 'valid' && m.tags?.eventIds?.length);
    if (!leaves.length) return false;
    const { cards } = await eventView(lib, view);
    const pending = new Map<string, { card: EventCard; memories: string[] }>();
    for (const card of cards) {
        if (card.blocked || card.needsReview) continue;
        const owned = new Set(card.members.map(m => m.memory));
        const ids = leaves.filter(m => m.tags!.eventIds.includes(card.chain.id) && !owned.has(m.id)).map(m => m.id);
        if (ids.length) pending.set(card.chain.id, { card, memories: ids });
    }
    if (!pending.size) return false;
    return lib.transaction(['branches', 'event_chains', 'event_revisions', 'event_memberships'], 'readwrite', async tx => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(guard() && branch && branch.story === view.branch.story && branch.head === view.branch.head &&
            branch.view === view.branch.view && branch.epoch === view.branch.epoch &&
            view.snapshot.id === branch.head && view.cutoff === view.snapshot.length,
            '事件标签同步期间视图已改变');
        branch.epoch++;
        for (const [id, { card, memories }] of pending) {
            const chain = await tx.get<EventChain>('event_chains', id);
            check(chain?.branch === branch.id && chain.story === branch.story, '事件链已改变');
            const base = { story: branch.story, branch: branch.id, owner: id,
                snapshot: view.snapshot.id, cutoff: view.cutoff, epoch: branch.epoch };
            await tx.add('event_revisions', { ...card.meta, ...row('er'), ...base, created: Date.now() } as EventRevision);
            for (const memory of memories) await tx.add('event_memberships', {
                ...row('link'), ...base, memory, kind: 'progress', origin: 'ai', locked: false, active: true,
            } as Membership);
        }
        check(guard(), '事件标签同步期间聊天已改变');
        await tx.put('branches', branch);
        return true;
    });
}
