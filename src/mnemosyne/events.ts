import { sourceContent, sourceRefMatches, sourceRefsMatch } from './source-equivalence';
import { parseStrictJson } from './json';
import { Library } from './db';
import { snapshotRefs, statuses, capture, current } from './canonical';
import { STORES, row, check, equal, fingerprint, type CapturedView, type EventChain, type EventRevision, type Membership, type Progress, type EventReceipt, type Branch, type Snapshot, type MemoryRevision } from './model';
export interface EventCard {
    chain: EventChain;
    meta: EventRevision;
    members: Membership[];
    progress: Progress[];
    needsReview?: boolean;
    blocked?: boolean;
    memberDetails?: MemoryRevision[];
}
export interface EventView {
    cards: EventCard[];
    valid: MemoryRevision[];
    storedCount: number;
}
export async function eventView(lib: Library, view: CapturedView): Promise<EventView> {
    const validStates = await statuses(lib, view);
    const valid = view.memories.filter(m => validStates.get(m.id) === 'valid');
    const permitted = new Set(valid.map(m => m.id));
    const live = view.snapshot.id === view.branch.head && view.cutoff === view.snapshot.length;
    const selected = new Map(view.memories.map(m => [m.owner, m]));
    return lib.transaction(STORES, 'readonly', async (tx) => {
        const chains = await tx.all<EventChain>('event_chains', 'branch', view.branch.id);
        const cache = new Map<string, boolean>();
        const within = async (snapshotId: string, cutoff: number): Promise<boolean> => {
            const key = `${snapshotId}:${cutoff}`;
            if (cache.has(key))
                return cache.get(key)!;
            const snapshot = await tx.get<Snapshot>('history_snapshots', snapshotId);
            const ok = !!snapshot && snapshot.branch === view.branch.id && cutoff <= view.cutoff &&
                sourceRefsMatch(view.branch, (await snapshotRefs(tx, snapshot)).slice(0, cutoff), view.refs.slice(0, cutoff));
            cache.set(key, ok);
            return ok;
        };
        const cards: EventCard[] = [];
        for (const chain of chains) {
            const revisions = await tx.all<EventRevision>('event_revisions', 'owner', chain.id);
            let meta: EventRevision | undefined;
            for (const r of revisions.sort((a, b) => b.epoch - a.epoch)) {
                if (live || (r.refs.every(id => permitted.has(id)) && await within(r.snapshot, r.cutoff))) {
                    meta = r;
                    break;
                }
            }
            if (!meta)
                continue;
            const memberships = await tx.all<Membership>('event_memberships', 'owner', chain.id);
            const latest = new Map<string, Membership>();
            const memberDetails = new Map<string, MemoryRevision>();
            for (const m of memberships.sort((a, b) => a.epoch - b.epoch)) {
                if (live) {
                    const previous = await tx.get<MemoryRevision>('memory_revisions', m.memory);
                    if (!previous) continue;
                    const memory = selected.get(previous.owner) ?? previous;
                    latest.set(previous.owner, { ...m, memory: memory.id });
                    memberDetails.set(memory.id, memory);
                } else if (permitted.has(m.memory) && await within(m.snapshot, m.cutoff)) latest.set(m.memory, m);
            }
            const members = [...latest.values()].filter(m => m.active).sort((a, b) => {
                const anchor = (key: string) => view.refs.findIndex(r => r.message === (memberDetails.get(key) ?? valid.find(v => v.id === key))?.anchor);
                return anchor(a.memory) - anchor(b.memory);
            });
            const memberSet = new Set(members.map(m => m.memory));
            const progress: Progress[] = [];
            const allProgress = await tx.all<Progress>('event_progress', 'owner', chain.id);
            for (const p of allProgress) {
                // Current workbench retains historical text locally; recall still requires every dependency.
                if (p.memories.every(m => memberSet.has(m) && permitted.has(m)) && (live || await within(p.snapshot, p.cutoff))) progress.push(p);
            }
            progress.sort((a,b) => a.cutoff - b.cutoff || a.epoch - b.epoch);
            if (live && meta.overview === undefined) {
                const history = allProgress.sort((a,b) => a.cutoff - b.cutoff || a.epoch - b.epoch);
                meta = { ...meta, overview: history.map(p => p.text).join('\n'), summarized: [...new Set(history.flatMap(p => p.memories))] };
            }
            const blocked = live && members.some(m => !permitted.has(m.memory));
            const needsReview = live && (meta.refs.some(id => !permitted.has(id)) || !!meta.summarized?.some(id => !memberSet.has(id) || !permitted.has(id)));
            if (!live && meta.summarized?.some(id => !memberSet.has(id))) meta = { ...meta, overview: '', summarized: [] };
            cards.push({ chain, meta, members, progress, needsReview, blocked, memberDetails: [...memberDetails.values()] });
        }
        return { cards, valid, storedCount: chains.length };
    });
}
export const EVENT_PROMPT = `你只整理事件，不重新生成摘要，不结算物品、人物、变量。
围绕具体事项、目标、约定、冲突或重要变化归组。相同人物/地点/物品或时间接近不等于同事件。
已有事项的新行动、结果、转折、新证据续接旧 event_id；独立事项才新建。
重复提及可以 reference，不冒充 progress。没有事件明确 none；证据不足 needs_review。
只能引用提供的旧 event_id 和本批 memory_revision_id；新事件用 null，由程序生成 ID。
概述只追加本批一到两句，不重写旧叙事，不编造动机、结局，不撤销人工关联。
每个输入摘要必须恰有一个 decisions 项，可在多个 events 中关联。none 和 needs_review 不得同时关联。
严格 JSON：{"decisions":[{"memory":"mr_...","result":"linked|none|needs_review"}],
"events":[{"event_id":null,"title":"事项","status":"open","keywords":[],
"members":[{"memory":"mr_...","kind":"progress|reference"}],"progress":"本批新增进展；仅reference则空字符串"}]}`;
export interface EventOutput {
    decisions: {
        memory: string;
        result: 'linked' | 'none' | 'needs_review';
    }[];
    events: {
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
    const input = memories.map(m => ({ memory_revision_id: m.id, text: m.content, source_declaration: m.declaration,
        sources: m.inputRefs.map(r => ({ ...r, content: sourceContent(view, r) })),
        current_anchor_body: view.sources.get(view.refs.find(r => r.message === m.anchor)?.revision ?? '')?.content ?? null }));
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
        check(typeof e.progress === 'string' && e.progress.length <= 4000 && Array.isArray(e.members) && e.members.length > 0, '事件进展/成员缺失');
        const members = new Set<string>();
        for (const m of e.members) {
            check(inputs.has(m.memory) && !members.has(m.memory) && ['progress', 'reference'].includes(m.kind), '非法或重复摘要成员');
            members.add(m.memory);
            linked.add(m.memory);
        }
        check(e.members.some(m => m.kind === 'progress') ? !!e.progress.trim() : !e.progress.trim(), 'progress/reference 与概述不一致');
    }
    for (const d of output.decisions)
        check((d.result === 'linked') === linked.has(d.memory), '处理决定与事件关联不一致');
    return output;
}
export async function commitEventBatch(lib: Library, batch: EventBatch, output: EventOutput, isCurrent: () => boolean = () => true): Promise<EventReceipt> {
    // Revalidate untrusted structured input too, not just the text parser entry point.
    parseEventOutput(JSON.stringify(output), batch);
    return lib.transaction(STORES, 'readwrite', async (tx) => {
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
            const meta: EventRevision = { ...row('er'), ...base, title: event.title, status: event.status,
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
export const EVENT_OVERVIEW_MAX_CHARS = 500;
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
export function checkEventOverview(text: string) {
    check(eventOverviewLength(text) <= EVENT_OVERVIEW_MAX_CHARS, `事件概要不能超过${EVENT_OVERVIEW_MAX_CHARS}字（含标点），未保存；请精简后重试`);
}
export async function editEvent(lib: Library, view: CapturedView, eventId: string | null, patch: {
    title: string;
    status: string;
    keywords: string[];
    overview?: string;
    summarized?: string[];
    confirmOverview?: boolean;
}, member?: {
    memory: string;
    active: boolean;
    kind: 'progress' | 'reference';
}, guard: () => boolean = () => true) {
    check(patch.title.trim() && patch.title.length <= 300, '事件标题不能为空或过长');
    const { valid, cards } = await eventView(lib, view);
    const existing = cards.find(c => c.chain.id === eventId);
    // Membership-only changes must still work for pre-limit overviews, without rewriting them.
    if (patch.overview !== undefined && patch.overview !== existing?.meta.overview)
        checkEventOverview(patch.overview);
    if (eventId)
        check(cards.some(c => c.chain.id === eventId), '事件不属于合法视图');
    if (member)
        check(valid.some(m => m.id === member.memory) || (!member.active && existing?.members.some(m => m.memory === member.memory)), '摘要无效或不属于当前范围');
    if (patch.confirmOverview) {
        check(!existing?.blocked, '请先审核来源摘要，或解除已删除来源的关联');
        check(equal([...(patch.summarized ?? [])].sort(), (existing?.members.map(m => m.memory) ?? []).sort()), '确认范围必须包含当前全部关联摘要');
    }
    return lib.transaction(STORES, 'readwrite', async (tx) => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(guard() && branch && branch.epoch === view.branch.epoch, '视图已改变，请刷新');
        branch.epoch++;
        let key = eventId;
        if (!key) {
            const chain: EventChain = { ...row('ev'), story: branch.story, branch: branch.id, created: Date.now() };
            await tx.add('event_chains', chain);
            key = chain.id;
        }
        const base = { story: branch.story, branch: branch.id, owner: key, snapshot: view.snapshot.id, cutoff: view.cutoff, epoch: branch.epoch };
        await tx.add('event_revisions', { ...row('er'), ...base, eventSchema: 2, overview: patch.overview ?? existing?.meta.overview ?? existing?.progress.map(p => p.text).join('\n') ?? '', summarized: patch.summarized ?? existing?.meta.summarized ?? existing?.progress.flatMap(p => p.memories) ?? [], title: patch.title, status: patch.status, keywords: [...patch.keywords], refs: patch.confirmOverview ? patch.summarized ?? [] : existing?.meta.refs ?? [], created: Date.now() } as EventRevision);
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
    await lib.transaction(STORES, 'readwrite', async tx => {
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
