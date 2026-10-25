import { eventOverviewMaxChars, DEFAULT_EVENT_OVERVIEW_MAX_CHARS, eventMaterialMode } from './event-settings';
import { EVENT_PROGRESS_MAX_CHARS, EVENT_APPEND_MAX_CHARS, EVENT_APPEND_PROMPT_MAX_CHARS } from '@/memory/limits';
import { cleanBody, splitTimeLabel } from '@/memory/timeTag';
import type { EventHint } from '@/memory/contextTags';
import { sourceContent, sourceRefMatches, sourceRefsMatch } from './source-equivalence';
import { parseStrictJson } from './json';
import { Library } from './db';
import { snapshotRefs, summarySources, statuses, capture, current, sameNarrativeRevision } from './canonical';
import { snapshotVariants } from './current-body';
import { currentEventCache, publishCurrentEvents, sameEventValidity, type CurrentEventCache } from './event-current-cache';
import { row, check, equal, fingerprint, type CapturedView, type EventChain, type EventRevision, type Membership, type Progress, type EventReceipt, type Branch, type Snapshot, type MemoryRevision } from './model';
export interface EventCard {
    issues?: { memory: string; roles: string[]; reason: string; floor?: number; deleted: boolean; text: string }[];
    chain: EventChain;
    meta: EventRevision;
    members: Membership[];
    progress: Progress[];
    needsReview?: boolean;
    blocked?: boolean;
    memberDetails?: MemoryRevision[];
    /** Current family-resolved removals; AI must respect manual unlink decisions. */
    removedMembers?: Membership[];
    history?: { revisions: EventRevision[]; memberships: Membership[]; progress: Progress[] };
    inheritanceKey?: string;
}
export interface EventView {
    cards: EventCard[];
    valid: MemoryRevision[];
    validity: Map<string, import('./canonical').MemoryStatus>;
    storedCount: number;
}
export interface EventViewOptions {
    /** Already verified for this exact captured source/selection/cutoff. Never reuse across an unverified change. */
    validity?: Map<string, import('./canonical').MemoryStatus>;
}
// getAll(owner) breaks equal cutoff/epoch ties by the primary key. Preserve that
// order when new progress is appended to an already warm Map in commit order.
const progressOrder = (a: Progress, b: Progress) => a.cutoff - b.cutoff || a.epoch - b.epoch ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export async function eventView(lib: Library, view: CapturedView, includeHistory = false, eventId?: string, includeIssues = false, options: EventViewOptions = {}): Promise<EventView> {
    const validStates = options.validity ?? await statuses(lib, view);
    const valid = view.memories.filter(m => validStates.get(m.id) === 'valid');
    const permitted = new Set(valid.map(m => m.id));
    const live = view.snapshot.id === view.branch.head && view.cutoff === view.snapshot.length;
    const selected = new Map(view.memories.map(m => [m.owner, m]));
    const positions = new Map(view.refs.map((ref, index) => [ref.message, index]));
    let publish: CurrentEventCache | undefined;
    const result = await lib.transaction(['branches', 'event_chains', 'event_revisions', 'event_memberships', 'event_progress',
        'memory_revisions', 'history_snapshots', 'manifest_blocks'], 'readonly', async (tx) => {
        const working = live && !includeHistory ? await currentEventCache(lib, tx, view) : undefined;
        // Single-chain work must not reproject every unrelated chain on each batch job.
        const requested = eventId === undefined ? undefined : await tx.get<EventChain>('event_chains', eventId);
        const chains = eventId === undefined ? await tx.all<EventChain>('event_chains', 'branch', view.branch.id)
            : requested?.branch === view.branch.id && requested.story === view.branch.story ? [requested] : [];
        if (eventId === undefined && working?.projection && equal(chains, working.chains) &&
            sameEventValidity(validStates, working.projection.validity)) {
            publish = working;
            return working.projection;
        }
        // Share reads only inside this projection. Never reuse across a branch/epoch change.
        const memories = new Map(view.memories.map(m => [m.id, Promise.resolve<MemoryRevision | undefined>(m)]));
        const readMemory = (id: string) => {
            if (!memories.has(id)) memories.set(id, tx.get<MemoryRevision>('memory_revisions', id));
            return memories.get(id)!;
        };
        const snapshots = new Map<string, Promise<Snapshot | undefined>>();
        const readSnapshot = (id: string) => {
            if (!snapshots.has(id)) snapshots.set(id, tx.get<Snapshot>('history_snapshots', id));
            return snapshots.get(id)!;
        };
        const inRange = async (snapshotId: string, cutoff: number) => {
            const snapshot = await readSnapshot(snapshotId);
            return !!snapshot && snapshot.branch === view.branch.id && cutoff <= view.cutoff;
        };
        const cache = new Map<string, boolean>();
        const within = async (snapshotId: string, cutoff: number): Promise<boolean> => {
            const key = `${snapshotId}:${cutoff}`;
            if (cache.has(key))
                return cache.get(key)!;
            const snapshot = await readSnapshot(snapshotId);
            const ok = !!snapshot && snapshot.branch === view.branch.id && cutoff <= view.cutoff &&
                sourceRefsMatch(view.branch, (await snapshotRefs(tx, snapshot)).slice(0, cutoff), view.refs.slice(0, cutoff));
            cache.set(key, ok);
            return ok;
        };
        const cards: EventCard[] = [];
        const equivalents = new Map<string, string>();
        const resolveMemory = async (id: string): Promise<string> => {
            if (equivalents.has(id)) return equivalents.get(id)!;
            const prior = await readMemory(id);
            const next = prior && selected.get(prior.owner);
            const resolved = prior && next && sameNarrativeRevision(prior, next) ? next.id : id;
            equivalents.set(id, resolved);
            return resolved;
        };
        // Fork/resync may use material recorded long after its plot floors. Validity still
        // comes from statuses (including explicit reviews); floor numbers alone prove nothing.
        const floorMessages = new Map<string, Promise<string[] | null>>();
        const materialFloors = (id: string): Promise<string[] | null> => {
            if (!floorMessages.has(id)) floorMessages.set(id, (async () => {
                const memory = await readMemory(id);
                if (!memory || !permitted.has(id)) return null;
                const messages = [...(await summarySources(tx, memory)), ...memory.coverage].map(r => r.message);
                if (memory.anchor) {
                    const basis = await readSnapshot(memory.basis);
                    if (!basis || !(await snapshotRefs(tx, basis)).some(ref => ref.message === memory.anchor)) return null;
                    messages.push(memory.anchor);
                }
                for (const dependency of memory.dependencies) {
                    const prior = await readMemory(dependency);
                    // statuses already checked exact dependencies or their explicit approval.
                    const child = prior && selected.get(prior.owner);
                    const floors = child && await materialFloors(child.id);
                    if (!floors) return null;
                    messages.push(...floors);
                }
                return messages.length ? [...new Set(messages)] : null;
            })());
            return floorMessages.get(id)!;
        };
        const floorSnapshots = new Map<string, Promise<{ refs: import('./model').SourceRef[]; variants: number[] }>>();
        const byFloors = async (record: { snapshot: string; cutoff: number }, ids: string[]) => {
            if (!includeHistory || !ids.length || !ids.every(id => permitted.has(id))) return false;
            const snapshot = await readSnapshot(record.snapshot);
            if (!snapshot || snapshot.branch !== view.branch.id || !Number.isSafeInteger(record.cutoff) ||
                record.cutoff < 0 || record.cutoff > snapshot.length) return false;
            const floors = await Promise.all([...new Set(ids)].map(materialFloors));
            if (floors.some(f => !f)) return false;
            if (!floorSnapshots.has(snapshot.id)) floorSnapshots.set(snapshot.id, (async () => ({
                refs: await snapshotRefs(tx, snapshot), variants: await snapshotVariants(tx, snapshot),
            }))());
            const evidence = await floorSnapshots.get(snapshot.id)!;
            return floors.every(f => f!.every(message => {
                const index = positions.get(message);
                return index !== undefined && index < record.cutoff &&
                    sourceRefMatches(view.branch, evidence.refs[index], view.refs[index]) &&
                    evidence.variants[index] === view.snapshot.variants?.[index];
            }));
        };
        for (const chain of chains) {
            const compact = working?.rows.get(chain.id);
            const [revisions, memberships, allProgress] = compact
                ? [compact.revision ? [compact.revision] : [], [...compact.members.values()], [...compact.progress.values()]]
                : await Promise.all([
                tx.all<EventRevision>('event_revisions', 'owner', chain.id),
                tx.all<Membership>('event_memberships', 'owner', chain.id),
                tx.all<Progress>('event_progress', 'owner', chain.id),
            ]);
            revisions.sort((a, b) => b.epoch - a.epoch);
            const candidates = live && !includeHistory ? revisions.slice(0, 1) : revisions;
            await Promise.all([...new Set([
                ...candidates.flatMap(r => [...r.refs, ...(r.summarized ?? []), ...(r.latestProgress ? [r.latestProgress.memory] : [])]),
                ...memberships.map(m => m.memory), ...allProgress.flatMap(p => p.memories),
            ])].map(readMemory));
            memberships.sort((a, b) => a.epoch - b.epoch);
            const activeAt = async (epoch: number) => {
                const latest = new Map<string, Membership>();
                for (const member of memberships) {
                    if (member.epoch > epoch) break;
                    const prior = await readMemory(member.memory);
                    if (!prior) return null;
                    latest.set(prior.owner, { ...member, memory: selected.get(prior.owner)?.id ?? member.memory });
                }
                // Do not backdate metadata from a removal while the removal itself rolls back.
                for (const member of latest.values())
                    if (!member.active && !await inRange(member.snapshot, member.cutoff)) return null;
                return [...latest.values()].filter(m => m.active).map(m => m.memory);
            };
            const history: NonNullable<EventCard['history']> = { revisions: [], memberships: [], progress: [] };
            let meta: EventRevision | undefined;
            for (const original of candidates) {
                const r = { ...original, refs: await Promise.all(original.refs.map(resolveMemory)),
                    ...(original.summarized ? { summarized: await Promise.all(original.summarized.map(resolveMemory)) } : {}),
                    ...(original.latestProgress ? { latestProgress: { ...original.latestProgress, memory: await resolveMemory(original.latestProgress.memory) } } : {}),
                };
                const dependencies = [...r.refs, ...(r.summarized ?? []), ...(r.latestProgress ? [r.latestProgress.memory] : [])];
                const associated = includeHistory ? await activeAt(r.epoch) : null;
                // Unsourced prose still uses the old operation cutoff. A title-only chain
                // may instead be grounded in its recorded links, even before its first overview.
                const grounded = dependencies.length > 0 || (!r.overview && !r.latestProgress && !allProgress.some(p => p.epoch <= r.epoch && p.text));
                const eligible = (!live || includeHistory) && dependencies.every(id => permitted.has(id)) &&
                    ((grounded && !!associated?.length && await byFloors(r, [...dependencies, ...associated])) ||
                        (await inRange(r.snapshot, r.cutoff) && (dependencies.length > 0 || await within(r.snapshot, r.cutoff))));
                if (eligible && includeHistory) history.revisions.push(r);
                if (!meta && (live || eligible)) meta = r;
                if (meta && !includeHistory) break;
            }
            if (!meta)
                continue;
            const latest = new Map<string, Membership>();
            const latestOriginal = new Map<string, Membership>();
            const memberDetails = new Map<string, MemoryRevision>();
            for (const original of memberships) {
                const previous = await readMemory(original.memory);
                if (!previous) continue;
                // The link belongs to the summary family; narrative text above still requires
                // the exact/equivalent revision or an explicit overview confirmation.
                const memory = selected.get(previous.owner) ?? previous;
                const m = { ...original, memory: memory.id };
                // Unlinks are user operations, not plot facts: retain their historical cutoff.
                const eligible = (!live || includeHistory) && permitted.has(m.memory) &&
                    ((m.active && await byFloors(m, [m.memory])) || await inRange(m.snapshot, m.cutoff));
                if (eligible && includeHistory) history.memberships.push(m);
                if (live || eligible) {
                    latest.set(previous.owner, m);
                    latestOriginal.set(previous.owner, original);
                    memberDetails.set(memory.id, memory);
                }
            }
            const members = [...latest.values()].filter(m => m.active).sort((a, b) => {
                const anchor = (key: string) => positions.get(memberDetails.get(key)?.anchor ?? '') ?? -1;
                return anchor(a.memory) - anchor(b.memory);
            });
            const memberSet = new Set(members.map(m => m.memory));
            const progress: Progress[] = [];
            for (const original of allProgress) {
                const p = { ...original, memories: await Promise.all(original.memories.map(resolveMemory)) };
                const eligible = (!live || includeHistory) && p.memories.every(m => permitted.has(m)) &&
                    (await byFloors(p, p.memories) || await inRange(p.snapshot, p.cutoff));
                if (eligible && includeHistory) history.progress.push(p);
                // Current workbench retains historical text locally; recall still requires every dependency.
                if (p.memories.every(m => memberSet.has(m) && permitted.has(m)) && (live || eligible)) progress.push(p);
            }
            progress.sort(progressOrder);
            if (live && meta.overview === undefined) {
                const history = allProgress.sort(progressOrder);
                meta = { ...meta, overview: history.map(p => p.text).join('\n'), summarized: [...new Set(history.flatMap(p => p.memories))] };
            }
            const blocked = live && members.some(m => !permitted.has(m.memory));
            const needsReview = live && ((!!meta.latestProgress && (!permitted.has(meta.latestProgress.memory) || !memberSet.has(meta.latestProgress.memory))) || meta.refs.some(id => !permitted.has(id)) || !!meta.summarized?.some(id => !memberSet.has(id) || !permitted.has(id)));
            if (!live && (meta.summarized?.some(id => !memberSet.has(id)) || (meta.latestProgress && (!permitted.has(meta.latestProgress.memory) || !memberSet.has(meta.latestProgress.memory))))) meta = { ...meta, overview: '', summarized: [], latestProgress: null };
            cards.push({ chain, meta, members, removedMembers: [...latest.values()].filter(m => !m.active), progress, needsReview, blocked, memberDetails: [...memberDetails.values()],
                ...(includeHistory ? { history } : {}) });
            if (working) working.rows.set(chain.id, { revision: revisions[0], members: latestOriginal,
                progress: new Map(allProgress.map(record => [record.id, record])) });
        }
        const projection = { cards, valid, validity: validStates, storedCount: chains.length };
        if (working) {
            if (eventId === undefined) {
                const present = new Set(chains.map(chain => chain.id));
                for (const id of working.rows.keys()) if (!present.has(id)) working.rows.delete(id);
                working.chains = chains; working.projection = projection;
            }
            // Keep only family identities still referenced by compact current links.
            // Hundreds of obsolete membership revisions must not linger in a side Map.
            working.families = new Map();
            for (const rows of working.rows.values()) for (const [family, member] of rows.members)
                working.families.set(member.memory, family);
            publish = working;
        }
        return projection;
    });
    if (publish && lib.changes.version === publish.version) publishCurrentEvents(lib, publish);
    // Hash only after the IndexedDB transaction has completed.
    if (includeHistory) for (const card of result.cards)
        card.inheritanceKey = await fingerprint([!!card.chain.archived, card.meta, card.members, card.progress, card.history]);
    return includeIssues ? eventViewIssues(lib, view, result) : result;
}
/** Add workbench diagnostics to an existing projection without rereading all events/statuses. */
export async function eventViewIssues(lib: Library, view: CapturedView, projection: EventView): Promise<EventView> {
    if (!projection.cards.some(card => card.blocked || card.needsReview)) return projection;
    const permitted = new Set(projection.valid.map(m => m.id));
    const validStates = projection.validity;
    const positions = new Map(view.refs.map((ref, index) => [ref.message, index]));
    return lib.transaction(['memory_revisions', 'history_snapshots', 'manifest_blocks'], 'readonly', async tx => {
        const memories = new Map([...projection.cards.flatMap(c => c.memberDetails ?? []), ...view.memories].map(m => [m.id, m]));
        const readMemory = async (id: string) => memories.get(id) ?? tx.get<MemoryRevision>('memory_revisions', id);
        const diagnosticFloors = new Map<string, Map<string, number>>();
        const cards: EventCard[] = [];
        for (const card of projection.cards) {
            if (!card.blocked && !card.needsReview) { cards.push(card); continue; }
            const { meta, members } = card;
            const memberSet = new Set(members.map(m => m.memory));
            const issues: NonNullable<EventCard['issues']> = [];
            const references = new Map<string, string[]>();
            const add = (id: string, role: string, membershipRequired = true) => {
                if (permitted.has(id) && (!membershipRequired || memberSet.has(id))) return;
                references.set(id, [...(references.get(id) ?? []), role]);
            };
            for (const m of members) add(m.memory, '关联成员');
            for (const id of new Set([...meta.refs, ...(meta.summarized ?? [])])) add(id, '旧概要', false);
            for (const id of meta.summarized ?? []) if (!memberSet.has(id)) add(id, '已解除关联');
            if (meta.latestProgress) add(meta.latestProgress.memory, '最新进展');
            for (const [id, roles] of references) {
                const memory = await readMemory(id);
                const deleted = !!memory?.anchor && !positions.has(memory.anchor);
                let floor = memory?.anchor ? positions.get(memory.anchor) : undefined;
                if (deleted && memory) {
                    const basis = await tx.get<Snapshot>('history_snapshots', memory.basis);
                    if (basis && !diagnosticFloors.has(basis.id)) diagnosticFloors.set(basis.id,
                        new Map((await snapshotRefs(tx, basis)).map((ref, index) => [ref.message, index])));
                    floor = basis ? diagnosticFloors.get(basis.id)?.get(memory.anchor!) : undefined;
                }
                const state = validStates.get(id);
                const reason = deleted ? '来源楼层已删除' : state === 'needs_review' ? '来源变化，摘要待审核'
                    : state === 'needs_rebuild' ? '下级摘要变化，需重建' : state === 'excluded' ? '摘要未参与记忆'
                    : !memberSet.has(id) && permitted.has(id) ? '已解除关联，旧内容仍引用'
                    : '旧摘要已被替换或移出当前视图';
                issues.push({ memory: id, roles: [...new Set(roles)], reason, floor, deleted, text: memory?.content ?? '' });
            }
            cards.push({ ...card, issues });
        }
        return { ...projection, cards };
    });
}
export const EVENT_PROMPT = `你只整理事件，不重新生成摘要，不结算物品、人物、变量。
围绕具体事项、目标、约定、冲突或重要变化归组。相同人物/地点/物品或时间接近不等于同事件。
已有事项的新行动、结果、转折、新证据续接旧 event_id；独立事项才新建。
重复提及可以 reference，不冒充 progress。没有事件明确 none；证据不足 needs_review。
只能引用提供的旧 event_id 和本批 memory_revision_id；新事件用 null，由程序生成 ID。
概述只追加本批一到两句，progress 不超过${EVENT_APPEND_PROMPT_MAX_CHARS}字，不重写旧叙事，不编造动机、结局，不撤销人工关联。
每个输入摘要必须恰有一个 decisions 项，可在多个 events 中关联。none 和 needs_review 不得同时关联。
严格 JSON：{"decisions":[{"memory":"mr_...","result":"linked|none|needs_review"}],
"events":[{"event_id":null,"title":"事项","status":"open","keywords":[],
"members":[{"memory":"mr_...","kind":"progress|reference"}],"progress":"本批新增进展；仅reference则空字符串","latestProgress":{"memory":"实际最近进展的摘要ID","text":"${EVENT_PROGRESS_MAX_CHARS}字内小结"}}]}。
latestProgress 只在本批有 progress 成员时填写，不能使用 reference；时间由来源摘要确定，重复提及不刷新进展。`;
export interface EventOutput {
    decisions: {
        memory: string;
        result: 'linked' | 'none' | 'needs_review';
    }[];
    events: {
        latestProgress?: { memory: string; text: string } | null;
        event_id: string | null;
        title: string;
        status: string;
        keywords: string[];
        members: {
            memory: string;
            kind: 'progress' | 'reference';
        }[];
        progress: string;
    }[];
}
export interface EventBatch {
    operation: string;
    view: CapturedView;
    memories: MemoryRevision[];
    catalog: EventCard[];
    fingerprint: string;
    prompt: string;
    chars: number;
}
export async function prepareEventBatch(lib: Library, view: CapturedView, maxMemories: number, maxChars: number): Promise<EventBatch | null> {
    check(Number.isInteger(maxMemories) && maxMemories > 0 && maxMemories <= 200, '批量上限应为1～200条摘要');
    const states = await statuses(lib, view);
    const valid = view.memories.filter(m => states.get(m.id) === 'valid');
    const receipts = await lib.all<EventReceipt>('event_processing_receipts', 'branch', view.branch.id);
    const processed = new Set<string>();
    for (const receipt of receipts) {
        const legal = await lib.transaction(['history_snapshots', 'manifest_blocks'], 'readonly', async (tx) => {
            const snapshot = await tx.get<Snapshot>('history_snapshots', receipt.snapshot);
            return snapshot && snapshot.branch === view.branch.id && receipt.cutoff <= view.cutoff && sourceRefsMatch(view.branch, (await snapshotRefs(tx, snapshot)).slice(0, receipt.cutoff), view.refs.slice(0, receipt.cutoff));
        });
        // needs_review is held for human resolution, never an automatic paid retry loop.
        if (legal)
            for (const key of receipt.memories)
                processed.add(key);
    }
    const memories = valid.filter(m => m.level === 0 && !m.seed && !processed.has(m.id)).slice(0, maxMemories);
    if (!memories.length)
        return null;
    const end = Math.max(...memories.map(m => Math.max(view.refs.findIndex(r => r.message === m.anchor) + 1, ...m.inputRefs.map(ref => view.refs.findIndex(r => sourceRefMatches(view.branch, ref, r)) + 1))));
    const expectedEpoch=view.branch.epoch;
    view = await capture(lib, view.branch.id, Math.min(view.cutoff, end || view.cutoff), view.snapshot.id);
    check(view.branch.epoch===expectedEpoch,'事件准备期间视图已改变');
    const { cards } = await eventView(lib, view);
    const safeCards = cards.filter(c => !c.needsReview && !c.blocked);
    const catalog = safeCards.map(c => ({ event_id: c.chain.id, title: c.meta.title, status: c.meta.status,
        keywords: c.meta.keywords, overview: c.progress.map(p => p.text) }));
    const directory = JSON.stringify(catalog);
    check(directory.length + EVENT_PROMPT.length <= maxChars, '事件目录过大/任务暂停：全量目录超出预算，未裁剪任何事件');
    const input = memories.map(m => {
        const anchor = view.sources.get(view.refs.find(r => r.message === m.anchor)?.revision ?? '')?.content;
        return { memory_revision_id: m.id, text: m.content, source_declaration: m.declaration,
            sources: m.inputRefs.map(r => {
                const content = sourceContent(view, r);
                return { ...r, content: content == null ? content : cleanBody(content) };
            }),
            current_anchor_body: anchor == null ? null : cleanBody(anchor) };
    });
    const prompt = `${EVENT_PROMPT}\n全量合法事件目录：${directory}\n本批材料：${JSON.stringify(input)}`;
    check(prompt.length <= maxChars, '本批材料超过预算，请缩小摘要批量上限');
    check(await current(lib,view),'事件准备期间视图已改变');
    const digest = await fingerprint([view.branch.id, view.snapshot.id, view.selection.id, view.branch.epoch, memories.map(m => m.id), directory]);
    return { operation: `op_${digest}`, view, memories, catalog: safeCards, fingerprint: digest, prompt, chars: prompt.length };
}
export function parseEventOutput(raw: string, batch: EventBatch): EventOutput {
    const output = parseStrictJson(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as EventOutput;
    check(output && Array.isArray(output.decisions) && Array.isArray(output.events), '缺少 decisions/events，不能视为无事件');
    const inputs = new Set(batch.memories.map(m => m.id));
    const catalog = new Set(batch.catalog.map(c => c.chain.id));
    check(output.decisions.length === inputs.size && new Set(output.decisions.map(d => d.memory)).size === inputs.size, '每条摘要必须有唯一处理决定');
    for (const d of output.decisions)
        check(inputs.has(d.memory) && ['linked', 'none', 'needs_review'].includes(d.result), '非法处理决定');
    const existing = new Set<string>();
    const linked = new Set<string>();
    for (const e of output.events) {
        check(e && (e.event_id === null || catalog.has(e.event_id)), '未知旧 event_id');
        if (e.event_id) {
            check(!existing.has(e.event_id), '同批同链必须合并');
            existing.add(e.event_id);
        }
        check(typeof e.title === 'string' && e.title.trim() && e.title.length <= 300 && typeof e.status === 'string' && e.status.length <= 100, '事件元信息不完整');
        check(Array.isArray(e.keywords) && e.keywords.length <= 100 && e.keywords.every(k => typeof k === 'string' && k.length <= 100), '关键词非法');
        check(typeof e.progress === 'string' && Array.from(e.progress).length <= EVENT_APPEND_MAX_CHARS, `progress（追加进展）必须是文本，最多${EVENT_APPEND_MAX_CHARS}字`);
        check(Array.isArray(e.members) && e.members.length > 0, '事件成员缺失');
        const members = new Set<string>();
        for (const m of e.members) {
            check(inputs.has(m.memory) && !members.has(m.memory) && ['progress', 'reference'].includes(m.kind), '非法或重复摘要成员');
            members.add(m.memory);
            linked.add(m.memory);
        }
        if (e.latestProgress) check(typeof e.latestProgress.text === 'string' && e.latestProgress.text.trim() && Array.from(e.latestProgress.text.trim()).length <= EVENT_PROGRESS_MAX_CHARS && e.members.some(m => m.memory === e.latestProgress!.memory && m.kind === 'progress'), `最新进展必须引用真实进展成员且不超过${EVENT_PROGRESS_MAX_CHARS}字`);
        check(e.members.some(m => m.kind === 'progress') ? !!e.progress.trim() : !e.progress.trim(), 'progress/reference 与概述不一致');
    }
    for (const d of output.decisions)
        check((d.result === 'linked') === linked.has(d.memory), '处理决定与事件关联不一致');
    return output;
}
export async function commitEventBatch(lib: Library, batch: EventBatch, output: EventOutput, isCurrent: () => boolean = () => true): Promise<EventReceipt> {
    // Revalidate untrusted structured input too, not just the text parser entry point.
    parseEventOutput(JSON.stringify(output), batch);
    return lib.transaction(['branches', 'event_chains', 'event_revisions', 'event_memberships', 'event_progress', 'event_processing_receipts'], 'readwrite', async (tx) => {
        const previous = await tx.get<EventReceipt>('event_processing_receipts', batch.operation);
        if (previous) {
            check(previous.fingerprint === batch.fingerprint && equal(previous.output, output), '操作ID冲突');
            return previous;
        }
        const branch = await tx.get<Branch>('branches', batch.view.branch.id);
        check(isCurrent() && branch && branch.epoch === batch.view.branch.epoch && branch.head === batch.view.branch.head && branch.view === batch.view.branch.view, '事件结果已过期；进度未推进');
        branch.epoch++;
        for (const event of output.events) {
            let chainId = event.event_id;
            if (!chainId) {
                const chain: EventChain = { ...row('ev'), story: branch.story, branch: branch.id, created: Date.now() };
                await tx.add('event_chains', chain);
                chainId = chain.id;
            }
            const base = { schema: 1 as const, story: branch.story, branch: branch.id, owner: chainId,
                snapshot: batch.view.snapshot.id, cutoff: batch.view.cutoff, epoch: branch.epoch };
            const previous = batch.catalog.find(c => c.chain.id === chainId)?.meta.latestProgress;
            const latest = event.latestProgress;
            const source = latest ? batch.memories.find(m => m.id === latest.memory)! : undefined;
            const latestProgress = latest && source ? { version: 1 as const, memory: source.id, text: latest.text.trim(), time: splitTimeLabel(source.storyTime).end || source.storyTime } : previous ?? null;
            const meta: EventRevision = { ...row('er'), ...base, latestProgress, title: event.title, status: event.status,
                keywords: event.keywords, refs: batch.memories.map(m => m.id), created: Date.now() };
            await tx.add('event_revisions', meta);
            for (const m of event.members) {
                const prior = (await tx.all<Membership>('event_memberships', 'owner', chainId))
                    .filter(x => x.memory === m.memory).sort((a, b) => b.epoch - a.epoch)[0];
                if (prior?.locked)
                    continue;
                const link: Membership = { ...row('link'), ...base, memory: m.memory, kind: m.kind, origin: 'ai', locked: false, active: true };
                await tx.add('event_memberships', link);
            }
            if (event.progress.trim()) {
                const p: Progress = { ...row('ep'), ...base, text: event.progress, memories: event.members.map(m => m.memory), operation: batch.operation };
                await tx.add('event_progress', p);
            }
        }
        const receipt: EventReceipt = { id: batch.operation, schema: 1, story: branch.story, branch: branch.id,
            snapshot: batch.view.snapshot.id, cutoff: batch.view.cutoff, view: batch.view.selection.id,
            fingerprint: batch.fingerprint, memories: batch.memories.map(m => m.id),
            result: output.decisions.some(d => d.result === 'needs_review') ? 'needs_review' : 'success', output, created: Date.now() };
        await tx.add('event_processing_receipts', receipt);
        await tx.put('branches', branch);
        return receipt;
    });
}
export const EVENT_OVERVIEW_MAX_CHARS = DEFAULT_EVENT_OVERVIEW_MAX_CHARS;
/** Archive changes presentation only, so in-flight narrative updates remain valid. */
export async function setEventArchived(lib: Library, view: CapturedView, eventId: string, archived: boolean, guard: () => boolean = () => true) {
    check(typeof archived === 'boolean', '归档标记无效');
    await lib.transaction(['branches', 'event_chains'], 'readwrite', async tx => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        const chain = await tx.get<EventChain>('event_chains', eventId);
        check(guard() && branch && branch.epoch === view.branch.epoch && branch.head === view.branch.head && branch.view === view.branch.view && chain?.branch === branch.id && chain.story === branch.story, '事件已改变，请刷新');
        if (chain.archived === archived) return;
        await tx.put('event_chains', { ...chain, archiveSchema: 1, archived } as EventChain);
    });
}
export const eventOverviewLength = (text: string) => Array.from(text.trim()).length;
export function checkEventOverview(text: string, maxChars = eventOverviewMaxChars()) {
    check(eventOverviewLength(text) <= maxChars, `事件概要不能超过${maxChars}字（含标点），未保存；请精简后重试`);
}
/** Rebind retained progress only when the user/model confirms the current event material. */
export async function confirmLatestProgressSource(lib: Library, progress: EventRevision['latestProgress'], members: MemoryRevision[]) {
    if (!progress || members.some(m => m.id === progress.memory)) return progress;
    const previous = await lib.get<MemoryRevision>('memory_revisions', progress.memory);
    const source = previous && members.find(m => m.owner === previous.owner);
    check(source, '最新进展来源已解除关联或失效，请手动选择有效摘要或清空最新进展');
    // Summary revision changes are not new plot progress: retain text and original story time.
    return { ...progress, memory: source.id };
}
export async function editEvent(lib: Library, view: CapturedView, eventId: string | null, patch: {
    title: string;
    status: string;
    keywords: string[];
    overview?: string;
    latestProgress?: EventRevision['latestProgress'];
    summarized?: string[];
    confirmOverview?: boolean;
}, member?: {
    memory: string;
    active: boolean;
    kind: 'progress' | 'reference';
}, guard: () => boolean = () => true) {
    check(patch.title.trim() && patch.title.length <= 300, '事件标题不能为空或过长');
    const { valid, cards } = await eventView(lib, view, false, eventId ?? undefined);
    const existing = cards.find(c => c.chain.id === eventId);
    // Membership-only changes must still work for pre-limit overviews, without rewriting them.
    if (patch.overview !== undefined && patch.overview !== existing?.meta.overview)
        checkEventOverview(patch.overview);
    if (eventId)
        check(cards.some(c => c.chain.id === eventId), '事件不属于合法视图');
    if (member)
        check(valid.some(m => m.id === member.memory) || (!member.active && existing?.members.some(m => m.memory === member.memory)), '摘要无效或不属于当前范围');
    const progressChanged = patch.latestProgress !== undefined && !equal(patch.latestProgress, existing?.meta.latestProgress);
    if (progressChanged && patch.latestProgress) {
        const progress = patch.latestProgress;
        check(progress.version === 1 && progress.text.trim() && Array.from(progress.text.trim()).length <= EVENT_PROGRESS_MAX_CHARS, `最新进展需为1至${EVENT_PROGRESS_MAX_CHARS}字`);
        check(valid.some(m => m.id === progress.memory) && existing?.members.some(m => m.memory === progress.memory), '最新进展须引用当前事件的有效关联摘要');
    }
    if (patch.confirmOverview) {
        check(!existing?.blocked, '请先审核来源摘要，或解除已删除来源的关联');
        check(equal([...(patch.summarized ?? [])].sort(), (existing?.members.map(m => m.memory) ?? []).sort()), '确认范围必须包含当前全部关联摘要');
    }
    const retainedProgress = patch.latestProgress === undefined ? existing?.meta.latestProgress : patch.latestProgress;
    const latestProgress = patch.confirmOverview
        ? await confirmLatestProgressSource(lib, retainedProgress, valid.filter(m => patch.summarized?.includes(m.id)))
        : retainedProgress;
    return lib.transaction(['branches', 'event_chains', 'event_revisions', 'event_memberships'], 'readwrite', async (tx) => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(guard() && branch && branch.story === view.branch.story && branch.epoch === view.branch.epoch &&
            branch.head === view.branch.head && branch.view === view.branch.view, '视图已改变，请刷新');
        branch.epoch++;
        let key = eventId;
        if (!key) {
            const chain: EventChain = { ...row('ev'), story: branch.story, branch: branch.id, created: Date.now() };
            await tx.add('event_chains', chain);
            key = chain.id;
        }
        const base = { story: branch.story, branch: branch.id, owner: key, snapshot: view.snapshot.id, cutoff: view.cutoff, epoch: branch.epoch };
        const progressSource = progressChanged && patch.latestProgress && valid.find(m => m.id === patch.latestProgress!.memory);
        await tx.add('event_revisions', { ...row('er'), ...base, eventSchema: 2,
            ...(patch.confirmOverview || (existing?.meta.overviewCoverage === 1 &&
                (patch.summarized === undefined || equal(patch.summarized, existing.meta.summarized))) ? { overviewCoverage: 1, overviewMaterialMode: patch.confirmOverview ? eventMaterialMode() : existing?.meta.overviewMaterialMode } : {}),
            ...(latestProgress !== undefined ? { latestProgress: latestProgress && progressSource ? {
                ...latestProgress, text: latestProgress.text.trim(),
                time: splitTimeLabel(progressSource.storyTime).end || progressSource.storyTime,
            } : latestProgress } : {}),
            overview: patch.overview ?? existing?.meta.overview ?? existing?.progress.map(p => p.text).join('\n') ?? '', summarized: patch.summarized ?? existing?.meta.summarized ?? existing?.progress.flatMap(p => p.memories) ?? [], title: patch.title, status: patch.status, keywords: [...patch.keywords], refs: patch.confirmOverview ? patch.summarized ?? [] : existing?.meta.refs ?? [], created: Date.now() } as EventRevision);
        if (member)
            await tx.add('event_memberships', { ...row('link'), ...base, ...member, locked: true, origin: 'manual' } as Membership);
        check(guard(), '聊天已改变，编辑未提交');
        await tx.put('branches', branch);
        return key;
    });
}
export interface EventBudget {
    chains: number;
    excerptChars: number;
    totalChars: number;
    extra: number;
}
export function wrapEvents(cards: EventCard[], view: CapturedView, selected: string[], recent: string[], budget: EventBudget): string {
    const hits = new Set(selected);
    const used = new Set([...selected, ...recent]);
    const chunks: string[] = [];
    let remaining = Math.max(0, budget.totalChars);
    let count = 0;
    for (const card of cards) {
        if (card.needsReview || card.blocked) continue;
        const matched = card.members.filter(m => hits.has(m.memory));
        if (!matched.length || count >= Math.max(0, budget.chains))
            continue;
        const relevant = [card.progress[0], ...card.progress.filter(p => p.memories.some(m => hits.has(m))), card.progress.at(-1)]
            .filter((p): p is Progress => !!p);
        const excerpts = (card.meta.overview ?? [...new Map(relevant.map(p => [p.id, p])).values()].map(p => p.text).join('\n')).slice(0, Math.max(0, budget.excerptChars));
        const positions = matched.map(m => card.members.indexOf(m) + 1).join(',');
        let text = `[事件：${card.meta.title} · ${card.meta.status} · 位置 ${positions}/${card.members.length}]\n事件概述节选：${excerpts}`;
        const latest = [...card.members].reverse().find(m => m.kind === 'progress');
        if (budget.extra > 0 && latest && !used.has(latest.memory)) {
            const memory = view.memories.find(m => m.id === latest.memory);
            if (memory) {
                text += `\n补充最新进展：${memory.content}`;
                used.add(latest.memory);
            }
        }
        if (text.length > remaining)
            text = text.slice(0, remaining);
        if (text) {
            chunks.push(text);
            remaining -= text.length + 2;
            count++;
        }
        if (remaining <= 0)
            break;
    }
    return chunks.join('\n\n');
}
export async function eventProgressState(lib: Library, view: CapturedView) {
    const validity = await statuses(lib, view);
    const receipts = await lib.all<EventReceipt>('event_processing_receipts', 'branch', view.branch.id);
    const completed = new Set<string>(), held = new Set<string>(), stale = new Set<string>();
    for (const receipt of receipts) {
        const legal = await lib.transaction(['history_snapshots', 'manifest_blocks'], 'readonly', async (tx) => {
            const snapshot = await tx.get<Snapshot>('history_snapshots', receipt.snapshot);
            return snapshot && snapshot.branch === view.branch.id && receipt.cutoff <= view.cutoff && sourceRefsMatch(view.branch, (await snapshotRefs(tx, snapshot)).slice(0, receipt.cutoff), view.refs.slice(0, receipt.cutoff));
        });
        for (const key of receipt.memories) {
            if (!legal || validity.get(key) !== 'valid')
                stale.add(key);
            else if (receipt.result === 'success')
                completed.add(key);
            else
                held.add(key);
        }
    }
    for (const key of completed)
        held.delete(key);
    return { total: view.memories.filter(m => m.level === 0 && !m.seed).length, completed: completed.size,
        needsReview: held.size, needsRecheck: stale.size, receipts: receipts.filter(r => r.result === 'needs_review' && r.memories.some(m => held.has(m))) };
}
export async function resolveEventReceipt(lib: Library, view: CapturedView, receiptId: string) {
    const source = await lib.get<EventReceipt>('event_processing_receipts', receiptId);
    check(source && source.branch === view.branch.id && source.result === 'needs_review', '未找到当前分支待确认回执');
    const { valid, cards } = await eventView(lib, view);
    const permitted = new Set(valid.map(m => m.id));
    check(source.memories.every(id => permitted.has(id)), '来源已改变，请先审核摘要');
    const output: EventOutput = { decisions: source.memories.map(memory => ({ memory, result: cards.some(c => c.members.some(m => m.memory === memory)) ? 'linked' : 'none' })), events: [] };
    await lib.transaction(['branches', 'event_processing_receipts'], 'readwrite', async (tx) => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(branch && branch.epoch === view.branch.epoch, '视图已改变');
        const receipt: EventReceipt = { ...source, ...row('op'), snapshot: view.snapshot.id, cutoff: view.cutoff, view: view.selection.id,
            result: 'success', output: { manual_resolution_of: receiptId, decisions: output.decisions }, created: Date.now() };
        await tx.add('event_processing_receipts', receipt);
        branch.epoch++;
        await tx.put('branches', branch);
    });
}

/** Explicit user deletion: scoped transaction removes this chain, never source memories. */
export async function deleteEvent(lib: Library, view: CapturedView, eventId: string, guard: () => boolean = () => true) {
    await lib.transaction(['branches', 'event_chains', 'event_revisions', 'event_memberships', 'event_progress', 'event_processing_receipts'], 'readwrite', async tx => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        const chain = await tx.get<EventChain>('event_chains', eventId);
        check(guard() && branch && branch.epoch === view.branch.epoch && chain?.branch === branch.id, '事件已改变，请刷新');
        const operations = new Set((await tx.all<Progress>('event_progress', 'owner', eventId)).map(p => p.operation));
        for (const store of ['event_revisions', 'event_memberships', 'event_progress'] as const)
            for (const record of await tx.all(store, 'owner', eventId)) await tx.delete(store, record.id);
        for (const receipt of await tx.all<EventReceipt>('event_processing_receipts', 'branch', branch.id)) {
            const output = receipt.output as EventOutput;
            if (operations.has(receipt.id) || output?.events?.some(e => e.event_id === eventId)) await tx.delete('event_processing_receipts', receipt.id);
        }
        await tx.delete('event_chains', eventId);
        branch.epoch++;
        await tx.put('branches', branch);
    });
}

/** Compact, persistent state; the detailed event wrapper remains recall-only. */
export function renderPersistentEvents(cards: EventCard[]): string {
    let index = 0;
    return ([['open', '进行中的事件链'], ['dormant', '暂搁的事件链']] as const).flatMap(([status, label]) => {
        const group = cards.filter(c => c.meta.status === status && !c.blocked && !c.needsReview);
        if (!group.length) return [];
        return [`${label}:\n${group.map(c => {
            const p = c.meta.latestProgress;
            return `e${++index}. [事件] ${c.meta.title} · ${p ? `最新进展：${`${p.time} ${p.text}`.trim()}` : c.meta.latestProgress === null ? '暂无明确进展' : '尚未填写最新进展'}`;
        }).join('\n')}`];
    }).join('\n\n');
}
export async function eventHintsBefore(lib: Library, view: CapturedView | undefined, cutoff: number): Promise<EventHint[]> {
    if (!view) return [];
    check(Number.isInteger(cutoff) && cutoff >= 0, '截止点无效');
    check(await current(lib, view), '事件目录已改变，请重试');
    // Eligibility follows the earliest valid member summary's actual plot floor,
    // not the much later floor where the event chain was created/edited.
    // Read the verified current catalog once; do not load historical bodies or
    // reproject all event revisions separately for every summary request.
    const { cards, valid } = await eventView(lib, view);
    const positions = new Map(view.refs.map((ref, index) => [ref.message, index]));
    const floor = new Map(valid.filter(m => m.level === 0 && !m.seed)
        .map(m => [m.id, positions.get(m.anchor ?? '') ?? -1]));
    const end = Math.min(cutoff, view.cutoff);
    check(await current(lib, view), '事件目录已改变，请重试');
    return cards.filter(c => c.meta.status !== 'resolved' && !c.blocked && !c.needsReview &&
        c.members.some(m => (floor.get(m.memory) ?? -1) >= 0 && (floor.get(m.memory) ?? -1) < end))
        .map(c => {
            const latest = c.meta.latestProgress;
            // Never show a later source's progress when summarizing an earlier floor.
            const latestFloor = latest ? floor.get(latest.memory) : undefined;
            return { id: c.chain.id, title: c.meta.title, status: c.meta.status,
                ...(latest && latestFloor !== undefined && latestFloor >= 0 && latestFloor < end
                    ? { latest: `${latest.time} ${latest.text}`.trim() } : {}),
            };
        });
}
