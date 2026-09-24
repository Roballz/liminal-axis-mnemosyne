import { previewReconnect, commitReconnect } from './binding-recovery';
import { readTables, renderTableState, commitSummaryTables, type SummaryTablePlan } from './tables';
import { TABLE_OUTPUT_KEY } from './summary-tables';
/** The only daily-library module that observes the ST host. */
import { reactive, watch } from 'vue';
import { getContext, type STMessage } from '@/st/context';
import { derivedMeta, memory } from '@/memory/store';
import { getLeaf, leafValid } from '@/memory/apply';
import { clearRecallInjection } from '@/memory/vector/recall';
import { refreshInjection } from '@/memory/inject';
import { activeLibrary } from './db';
import {
    capture,
    synchronize,
    statuses,
    current,
    forkBranch,
    type HostObservation,
    type HostMemory,
    type MemoryStatus,
} from './canonical';
import { row, check, type CapturedView, type SourceRef, type Branch, type Binding } from './model';
export const dailyState = reactive({
    status: '未归档',
    error: '',
    pending: false,
    generation: 0,
    tableError: '',
    tableRevision: 0,
    scope: '',
    branch: '',
    archived: 0,
    summaries: 0,
    review: 0,
    conflict: false,
    revision: 0,
});
let installed = false;
interface DailyCache {
    view: CapturedView;
    allowed: Set<string>;
    leaves: CanonicalLeaf[];
    host: string;
    tableText: string;
    library: string;
    reviewCount: number;
}
let cache: DailyCache | null = null;
let lastCache: DailyCache | null = null;
let serial: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let savedHost = '';
const MESSAGE_KEY = 'mnemosyne_message_v1';
const BINDING_KEY = 'mnemosyne_binding_v1';
const EVIDENCE_KEY = 'mnemosyne_summary_evidence_v1';
const MANUAL_KEY = 'mnemosyne_manual_summary_v1';
export function markManualSummaryEdit(message: STMessage) {
    if (!installed) return;
    const leaf = getLeaf(message);
    if (!leaf) return;
    message.extra ??= {};
    const previous = message.extra[MANUAL_KEY] as { generationKey?: number } | undefined;
    message.extra[MANUAL_KEY] = { leaf: leaf.id, text: leaf.text, generationKey: Math.max(Date.now(), (previous?.generationKey ?? 0) + 1) };
}
/** Source authorship follows the engine's isRealAiReply rule, not context visibility.
 * ST /hide also sets is_system on real replies without adding bbs_hidden.
 * Keep native typed system messages and our internal notices as system sources.
 */
function sourceRole(message: STMessage): 'user' | 'assistant' | 'system' {
    if (message.is_user) return 'user';
    if (
        message.extra?.bbs_internal_notice ||
        (message.is_system && message.extra?.type && !message.extra?.bbs_hidden)
    ) return 'system';
    return 'assistant';
}
export function hostScope(): string {
    const ctx = getContext();
    const chat = ctx?.getCurrentChatId?.();
    if (!ctx || !chat) return '';
    const avatar = ctx.characters?.[Number(ctx.characterId)]?.avatar ?? ctx.groupId ?? '';
    return JSON.stringify([avatar, chat]);
}
export function hostVersion(): string {
    const ctx = getContext();
    return JSON.stringify([
        hostScope(),
        (ctx?.chat ?? []).map((m) => [
            m.extra?.[MESSAGE_KEY],
            sourceRole(m),
            m.mes,
            m.swipe_id,
            m.extra?.bbs_omit,
            m.extra?.bbs_leaf,
            m.extra?.[EVIDENCE_KEY],
            m.extra?.[MANUAL_KEY],
            m.extra?.[TABLE_OUTPUT_KEY],
        ]),
        memory.summaries,
    ]);
}
/** Separate from source identity: hide/unhide can revoke a pending repair preview. */
export function hiddenRoleRepairRefs(view: CapturedView): SourceRef[] {
    const chat = getContext()?.chat ?? [];
    return view.refs.filter((ref, i) => {
        const message = chat[i], source = view.sources.get(ref.revision);
        return message && message.is_system && !message.is_user && !message.extra?.type &&
            !message.extra?.bbs_internal_notice && source?.role === 'assistant' &&
            source.content === message.mes && source.provenance.hostKey === message.extra?.[MESSAGE_KEY] &&
            source.provenance.swipe === (message.swipe_id ?? 0);
    });
}
export function invalidateDaily() {
    const scope = hostScope();
    if (dailyState.scope !== scope)
        Object.assign(dailyState, {
            scope,
            status: '等待当前聊天归档',
            error: '',
            branch: '',
            archived: 0,
            summaries: 0,
            review: 0,
            conflict: false,
            tableError: '',
        });
    dailyState.generation++;
    cache = null;
    dailyState.pending = true;
    if (installed) {
        clearRecallInjection();
        refreshInjection();
    }
}
export interface CanonicalLeaf {
    leafId: string;
    hostId: string;
    docHash: string;
    payloadHash: string;
    document: string;
    mesFull: string;
    storyTime: string;
    msgIndex: number;
}
export function dailyInstalled() {
    return installed;
}
export function summaryPermission(): (hostId: string) => boolean {
    if (!installed) return () => true;
    const allowed = cache && cache.host === hostVersion() ? cache.allowed : new Set<string>();
    return (hostId) => allowed.has(hostId);
}
export function summaryAllowed(hostId: string): boolean {
    return summaryPermission()(hostId);
}
/** A page may inspect scope without loading a single source/summary body or saving the host. */
export async function dailyBranch(): Promise<Branch | null> {
    const ctx = getContext(),
        scope = hostScope();
    const binding = ctx?.chatMetadata[BINDING_KEY] as { scope?: string; branch?: string } | undefined;
    if (!binding?.branch || binding.scope !== scope) return null;
    return (await (await activeLibrary()).get<Branch>('branches', binding.branch)) ?? null;
}

export function canonicalLeaves(): CanonicalLeaf[] {
    return cache && cache.host === hostVersion() ? cache.leaves : [];
}
function projectView(view: CapturedView, validity: Map<string, MemoryStatus>) {
    const allowed = new Set(view.memories.filter((m) => validity.get(m.id) === 'valid').map((m) => m.hostId));
    const sourcePositions = new Map(view.refs.map((r, i) => [r.message, i]));
    const leaves: CanonicalLeaf[] = view.memories
        .filter((m) => m.level === 0 && !m.seed && validity.get(m.id) === 'valid')
        .map((m) => {
            const idx = sourcePositions.get(m.anchor ?? '') ?? -1;
            const source = view.sources.get(view.refs[idx]?.revision);
            return {
                leafId: m.id,
                hostId: m.hostId,
                docHash: m.fingerprint,
                payloadHash: source?.fingerprint || m.fingerprint,
                document: m.content,
                mesFull: source?.content ?? '',
                storyTime: m.storyTime,
                msgIndex: idx,
            };
        });
    return {
        allowed,
        leaves,
        reviewCount: [...validity.values()].filter((v) => v === 'needs_review' || v === 'needs_rebuild').length,
    };
}
export async function syncDaily(): Promise<CapturedView> {
    const job = serial
        .catch(() => {})
        .then(async () => {
            const ctx = getContext();
            const scope = hostScope();
            check(ctx && scope, '请先打开聊天');
            const lib = await activeLibrary();
            const observedHost = hostVersion(),
                observedGeneration = dailyState.generation;
            const reusable = cache ?? lastCache;
            if (
                reusable &&
                !dailyState.tableError &&
                reusable.host === observedHost &&
                reusable.library === lib.db.name
            ) {
                const live = await lib.get<Branch>('branches', reusable.view.branch.id);
                if (live && live.head === reusable.view.branch.head && live.view === reusable.view.branch.view) {
                    cache = reusable;
                    if (live.epoch !== reusable.view.branch.epoch) {
                        const generation = dailyState.generation,
                            view = { ...reusable.view, branch: live };
                        const validity = await statuses(lib, view),
                            inputs = await readTables(lib, live);
                        check(
                            observedHost === hostVersion() && generation === dailyState.generation,
                            '聊天已改变，请重试',
                        );
                        cache = {
                            ...reusable,
                            view,
                            ...projectView(view, validity),
                            tableText: renderTableState(
                                inputs,
                                new Set(view.memories.filter((m) => validity.get(m.id) === 'valid').map((m) => m.id)),
                            ),
                        };
                        dailyState.tableRevision++;
                        dailyState.revision++;
                    }
                    check(
                        observedHost === hostVersion() && observedGeneration === dailyState.generation,
                        '聊天已改变，请重试',
                    );
                    lastCache = cache;
                    Object.assign(dailyState, {
                        pending: false,
                        status: '已归档',
                        error: '',
                        scope,
                        branch: live.id,
                        archived: cache.view.refs.length,
                        summaries: cache.view.memories.length,
                        review: cache.reviewCount,
                    });
                    if (installed) refreshInjection();
                    return cache.view;
                }
            }
            dailyState.pending = true;
            dailyState.status = '正在归档';
            dailyState.error = '';
            const inherited = ctx.chatMetadata[BINDING_KEY] as
                | {
                      scope?: string;
                      branch?: string;
                  }
                | undefined;
            const bindings = inherited?.branch || inherited?.scope ? await lib.all<Binding>('host_bindings') : [];
            const activeBinding = bindings.find(b => !b.detached && b.scope === scope);
            if ((inherited?.scope && inherited.scope !== scope && activeBinding?.branch !== inherited.branch) ||
                (inherited?.branch && !activeBinding) ||
                (inherited?.branch && activeBinding?.branch !== inherited.branch && !bindings.some(b => b.detached && b.scope === scope && b.branch === inherited.branch))) {
                dailyState.conflict = true;
                throw new Error('聊天名称或绑定已改变：若只是改名，请接回原档案；若创建了新分支，请明确选择新故事或继承。不自动猜测分支。');
            }
            dailyState.conflict = false;
            let dirty = false;
            const keys = new Set<string>();
            for (const message of ctx.chat) {
                message.extra ??= {};
                let key = message.extra[MESSAGE_KEY];
                if (!key) {
                    key = row('hostmsg').id;
                    message.extra[MESSAGE_KEY] = key;
                    dirty = true;
                }
                check(typeof key === 'string' && !keys.has(key), '宿主消息映射重复，需要人工核对');
                keys.add(key);
            }
            const generation = dailyState.generation;
            const host = hostVersion();
            const observation: HostObservation = {
                scope,
                messages: ctx.chat.map((m) => ({
                    key: String(m.extra![MESSAGE_KEY]),
                    role: sourceRole(m),
                    content: m.mes,
                    swipe: m.swipe_id ?? 0,
                })),
                memories: [],
            };
            ctx.chat.forEach((m, i) => {
                const leaf = getLeaf(m);
                if (!leaf) return;
                const evidence = m.extra?.[EVIDENCE_KEY] as
                    | {
                          leaf: string;
                          text: string;
                          inputRefs: SourceRef[];
                          coverage: SourceRef[];
                          dependencies?: string[];
                          generatedContent?: string;
                          basis?: string;
                          generationKey?: number;
                      }
                    | undefined;
                const item: HostMemory = {
                    hostId: leaf.id,
                    content: leaf.text,
                    level: 0,
                    anchorKey: String(m.extra![MESSAGE_KEY]),
                    children: [],
                    storyTime: [leaf.timeStart, leaf.timeEnd].filter(Boolean).join(' - ') || leaf.timeLabel || '',
                    seed: !!leaf.seed,
                    enabled: leafValid(m) && !m.extra?.bbs_omit,
                };
                const manual = m.extra?.[MANUAL_KEY] as { leaf: string; text: string; generationKey: number } | undefined;
                if (manual?.leaf === leaf.id && manual.text === leaf.text) {
                    item.manualEdit = true;
                    item.generationKey = manual.generationKey;
                } else if (evidence?.leaf === leaf.id && evidence.text === leaf.text) {
                    if (evidence.generationKey !== undefined) item.generationKey = evidence.generationKey;
                    item.inputRefs = evidence.inputRefs;
                    item.coverage = evidence.coverage;
                    item.basisSnapshot = evidence.basis;
                    item.children = evidence.dependencies ?? [];
                    item.generatedSidecar = evidence.generatedContent === m.mes;
                    item.declaration =
                        '来源记录包含实际正文输入；角色卡、世界书及派生状态另作为非正文上下文，不等同已发生剧情。';
                }
                observation.memories.push(item);
            });
            for (const s of [...memory.summaries].sort((a, b) => a.level - b.level))
                observation.memories.push({
                    hostId: s.id,
                    content: s.text,
                    level: s.level,
                    anchorKey: null,
                    children: s.childIds,
                    generationKey: s.createdAt,
                    storyTime: s.timeStart || s.timeLabel || '',
                    seed: false,
                    enabled: true,
                });
            // Host writes happen first. If canonical fails, these IDs remain retryable; there is no cross-store atomicity claim.
            if (dirty || savedHost !== host) ctx.chatMetadata.mnemosyne_ids_pending = true;
            if (ctx.chatMetadata.mnemosyne_ids_pending) {
                await ctx.saveChat();
                delete ctx.chatMetadata.mnemosyne_ids_pending;
            }
            check(
                scope === hostScope() && generation === dailyState.generation && host === hostVersion(),
                '聊天在归档期间改变，待重试',
            );
            ctx.chatMetadata.mnemosyne_archive_v1 = { status: 'pending', scope };
            await ctx.saveMetadata();
            const branch = await synchronize(lib, observation);
            savedHost = host;
            check(
                scope === hostScope() && generation === dailyState.generation && host === hostVersion(),
                '归档已保存；界面已变化，请重试当前聊天',
            );
            ctx.chatMetadata[BINDING_KEY] = { scope, branch: branch.id };
            ctx.chatMetadata.mnemosyne_archive_v1 = { status: 'saved', scope, branch: branch.id, head: branch.head };
            await ctx.saveMetadata();
            const view = await capture(lib, branch.id);
            const validity = await statuses(lib, view);
            check(host === hostVersion() && generation === dailyState.generation, '归档完成；当前视图已变化');
            dailyState.tableError = '';
            const receipts = new Set((await lib.all('table_receipts', 'branch', branch.id)).map((r) => r.id));
            for (const [floor, message] of ctx.chat.entries()) {
                const saved = message.extra?.[TABLE_OUTPUT_KEY] as
                    { version: number; leaf: string; text: string; plan: SummaryTablePlan } | undefined;
                const leaf = getLeaf(message);
                if (
                    !saved ||
                    saved.version !== 2 ||
                    saved.plan.branch !== branch.id ||
                    leaf?.id !== saved.leaf ||
                    leaf.text !== saved.text
                )
                    continue;
                if (saved.plan.tables.every((t) => receipts.has(`${saved.plan.operation}:${t.id}`))) continue;
                const source = view.memories.find((m) => m.hostId === saved.leaf && validity.get(m.id) === 'valid');
                if (!source) continue;
                try {
                    check(host === hostVersion() && generation === dailyState.generation, '聊天已改变');
                    await commitSummaryTables(
                        lib,
                        view,
                        saved.plan,
                        [source.id],
                        () => host === hostVersion() && generation === dailyState.generation,
                    );
                } catch (error) {
                    dailyState.tableError = `摘要已保存，#${floor} 楼填表待处理：${String((error as Error).message)}。可刷新重试；若表已改动，请重新生成该楼摘要以替代旧请求。`;
                }
            }
            const inputs = await readTables(lib, view.branch);
            check(host === hostVersion() && generation === dailyState.generation, '归档完成；当前视图已变化');
            cache = {
                view,
                ...projectView(view, validity),
                host,
                library: lib.db.name,
                tableText: renderTableState(
                    inputs,
                    new Set(view.memories.filter((m) => validity.get(m.id) === 'valid').map((m) => m.id)),
                ),
            };
            lastCache = cache;
            Object.assign(dailyState, {
                branch: branch.id,
                archived: view.refs.length,
                summaries: view.memories.length,
                review: [...validity.values()].filter((v) => v === 'needs_review' || v === 'needs_rebuild').length,
                scope,
                tableRevision: dailyState.tableRevision + 1,
                pending: false,
                status: '已归档',
                error: '',
                revision: dailyState.revision + 1,
            });
            if (installed) refreshInjection();
            return view;
        });
    serial = job;
    return job.catch((error) => {
        dailyState.pending = true;
        dailyState.status = 'pending · 可重试';
        dailyState.error = String(error.message ?? error);
        cache = null;
        throw error;
    });
}
export function dailyTableText(): string {
    return cache && cache.host === hostVersion() ? cache.tableText : '';
}
/** Table-only mutations refresh state without re-archiving the chat or rereading source bodies. */
export async function refreshDailyTables() {
    if (!cache || cache.host !== hostVersion()) return;
    const previous = cache,
        lib = await activeLibrary(),
        host = previous.host;
    const branch = await lib.get<Branch>('branches', previous.view.branch.id);
    if (
        lib.db.name !== previous.library ||
        !branch ||
        branch.head !== previous.view.branch.head ||
        branch.view !== previous.view.branch.view
    )
        return;
    const inputs = await readTables(lib, branch);
    if (cache !== previous || host !== hostVersion()) return;
    const permitted = new Set(previous.view.memories.filter((m) => previous.allowed.has(m.hostId)).map((m) => m.id));
    cache = { ...previous, view: { ...previous.view, branch }, tableText: renderTableState(inputs, permitted) };
    lastCache = cache;
    dailyState.tableRevision++;
    if (installed) refreshInjection();
}
export function scheduleDaily() {
    if (!installed) return;
    invalidateDaily();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        void syncDaily().catch(() => {});
    }, 200);
}
export async function dailyCapture(cutoff?: number) {
    const view = await syncDaily();
    return cutoff === undefined ? view : capture(await activeLibrary(), view.branch.id, cutoff);
}
export async function dailyCurrent(view: CapturedView, host: string, generation: number) {
    return (
        host === hostVersion() && generation === dailyState.generation && (await current(await activeLibrary(), view))
    );
}
export async function chooseNewStory() {
    const ctx = getContext();
    check(ctx, '无聊天');
    delete ctx.chatMetadata[BINDING_KEY];
    for (const m of ctx.chat) {
        if (m.extra) {
            delete m.extra[MESSAGE_KEY];
            delete m.extra[EVIDENCE_KEY];
            delete m.extra[MANUAL_KEY];
        }
    }
    await ctx.saveChat();
    await ctx.saveMetadata();
    invalidateDaily();
    return syncDaily();
}
/** Explicitly reuse a known binding after host rename; no content-based identity guess. */
/** Dropdown metadata only: never load source bodies or summaries here. */
export async function dailyBranchChoices() {
    const ctx = getContext(), scope = hostScope(), generation = dailyState.generation;
    check(ctx && scope, '请先打开聊天');
    const inherited = ctx.chatMetadata[BINDING_KEY] as { branch?: string } | undefined;
    const parseScope = (value: string): string[] => {
        try {
            const parts = JSON.parse(value);
            return Array.isArray(parts) && parts.length === 2 && parts.every(p => typeof p === 'string') ? parts : [];
        } catch { return []; }
    };
    const character = parseScope(scope)[0];
    const lib = await activeLibrary();
    const choices = await lib.transaction(['host_bindings', 'branches', 'history_snapshots'], 'readonly', async tx => {
        const bindings = await tx.all<Binding>('host_bindings');
        const seen = new Set<string>();
        const result: { value: string; label: string; inherited: boolean; length: number; suggested: number }[] = [];
        for (const binding of bindings) {
            const [owner, name] = parseScope(binding.scope);
            if (owner !== character || !name || (!binding.detached && binding.scope === scope) || seen.has(binding.branch)) continue;
            const branch = await tx.get<Branch>('branches', binding.branch);
            if (!branch) continue;
            const snapshot = await tx.get<import('./model').Snapshot>('history_snapshots', branch.head);
            if (!snapshot) continue;
            seen.add(branch.id);
            const source = inherited?.branch === branch.id;
            result.push({ value: branch.id, label: `${name} · ${snapshot.length} 条消息${binding.detached ? ' · 未连接，档案保留' : ''}${source ? ' · 当前聊天的来源' : ''}`,
                inherited: source, length: snapshot.length, suggested: Math.min(snapshot.length, ctx.chat.length) });
        }
        return result.sort((a, b) => Number(b.inherited) - Number(a.inherited) || a.label.localeCompare(b.label));
    });
    check(scope === hostScope() && generation === dailyState.generation && lib === await activeLibrary(), '聊天已切换，请重新加载列表');
    return choices;
}
export async function previewArchiveReconnect(branchId: string) {
    const ctx = getContext(), scope = hostScope(), host = hostVersion(), generation = dailyState.generation;
    check(ctx && scope, '请先打开改名后的聊天');
    const lib = await activeLibrary();
    const plan = await previewReconnect(lib, branchId, scope, ctx.chat.map(m => ({
        key: String(m.extra?.[MESSAGE_KEY] ?? ''), role: sourceRole(m), content: m.mes, swipe: m.swipe_id ?? 0,
    })));
    check(host === hostVersion() && generation === dailyState.generation && lib === await activeLibrary(), '聊天已改变，请重新预览接回');
    return { lib, plan, host, generation };
}
export async function reconnectArchive(preview: Awaited<ReturnType<typeof previewArchiveReconnect>>, isCurrent: () => boolean = () => true) {
    const job = serial.catch(() => {}).then(async () => {
        const { lib, plan, host, generation } = preview, ctx = getContext();
        const guard = () => isCurrent() && host === hostVersion() && generation === dailyState.generation;
        check(ctx && guard() && lib === await activeLibrary(), '聊天已改变，请重新预览接回');
        await commitReconnect(lib, plan, guard);
        cache = null;
        lastCache = null;
        check(guard(), '档案连接已保存；聊天已切换，请返回后刷新');
        // Durable binding is committed first; a failed metadata save can retry the same binding.
        ctx.chatMetadata[BINDING_KEY] = { scope: plan.scope, branch: plan.branch.id };
        invalidateDaily();
        await ctx.saveMetadata();
    });
    serial = job;
    await job;
    return syncDaily();
}
/** Compatibility wrapper: the caller must have obtained explicit rename/reconnect consent. */
export async function confirmBinding(branchId: string) {
    return reconnectArchive(await previewArchiveReconnect(branchId));
}
export function bindDaily() {
    installed = true;
    savedHost = '';
    lastCache = null;
    const ctx = getContext();
    if (!ctx) return;
    const handlers: {
        event: string;
        callback: () => void;
    }[] = [];
    for (const key of [
        'CHAT_CHANGED',
        'MESSAGE_EDITED',
        'MESSAGE_DELETED',
        'MESSAGE_SWIPED',
        'MESSAGE_SENT',
        'CHARACTER_MESSAGE_RENDERED',
        'GENERATION_ENDED',
    ]) {
        const event = ctx.eventTypes[key];
        if (event) {
            ctx.eventSource.on(event, scheduleDaily);
            handlers.push({ event, callback: scheduleDaily });
        }
    }
    const unwatch = watch(() => derivedMeta.rev, scheduleDaily);
    scheduleDaily();
    return () => {
        installed = false;
        unwatch();
        if (timer) clearTimeout(timer);
        for (const h of handlers) ctx.eventSource.off?.(h.event, h.callback);
        cache = null;
    };
}
export async function captureSummaryEvidence(indices: number[], dependencies: string[] = []) {
    if (!installed) return null;
    const view = await syncDaily();
    const host = hostVersion();
    const generation = dailyState.generation;
    return { view, host, generation, dependencies, inputRefs: indices.map((i) => view.refs[i]).filter(Boolean) };
}
export function attachSummaryEvidence(
    chat: STMessage[],
    floor: number,
    evidence: Awaited<ReturnType<typeof captureSummaryEvidence>>,
    coverageIndices: number[],
) {
    if (!evidence) return;
    const leaf = getLeaf(chat[floor]);
    if (!leaf) return;
    const previous = chat[floor].extra![EVIDENCE_KEY] as { generationKey?: number } | undefined;
    delete chat[floor].extra![MANUAL_KEY];
    chat[floor].extra![EVIDENCE_KEY] = {
        generationKey: Math.max(Date.now(), (previous?.generationKey ?? 0) + 1),
        leaf: leaf.id,
        text: leaf.text,
        inputRefs: evidence.inputRefs,
        dependencies: evidence.dependencies,
        generatedContent: chat[floor].mes,
        basis: evidence.view.snapshot.id,
        coverage:
            coverageIndices.length === 2 &&
            coverageIndices[1] === coverageIndices[0] + 1 &&
            chat[coverageIndices[0]].is_user &&
            !chat[coverageIndices[1]].is_user
                ? coverageIndices.map((i) => evidence.view.refs[i]).filter(Boolean)
                : [],
    };
}
export function assertSummaryEvidence(evidence: Awaited<ReturnType<typeof captureSummaryEvidence>>) {
    if (evidence)
        check(
            evidence.generation === dailyState.generation && evidence.host === hostVersion(),
            '摘要请求期间正文已改变，旧结果不能应用',
        );
}
export async function confirmFork(parentId: string, prefixLength: number) {
    const ctx = getContext(), scope = hostScope(), host = hostVersion(), generation = dailyState.generation;
    check(ctx && scope, '无聊天');
    const job = serial.catch(() => {}).then(async () => {
        const guard = () => scope === hostScope() && host === hostVersion() && generation === dailyState.generation;
        check(guard(), '聊天已改变，请重新选择分支');
        const lib = await activeLibrary();
        const parent = await capture(lib, parentId, prefixLength);
        const bindings = await lib.all<Binding>('host_bindings', 'branch', parentId);
        const mappings = (await Promise.all(bindings.map((b) => lib.all<any>('message_mappings', 'owner', b.id)))).flat();
        check(guard() && prefixLength <= ctx.chat.length, '聊天已改变或分叉前缀超过聊天长度');
        for (let i = 0; i < prefixLength; i++) {
            const message = ctx.chat[i], ref = parent.refs[i], source = parent.sources.get(ref.revision)!;
            const identityMatches = mappings.some(m => m.message === ref.message && m.hostKey === message.extra?.[MESSAGE_KEY]);
            const bodyMatches = source.content === message.mes;
            const difference = [!identityMatches && '消息身份不同或缺失', !bodyMatches && '正文不同'].filter(Boolean).join('、');
            check(identityMatches && bodyMatches,
                `#${i} 分叉前缀身份或正文不匹配：${difference}；前 ${i} 条已匹配，未建立分支。若要找回原事件，请使用“聊天改名 / 接回已有档案”，不要通过缩短前缀新建分支来恢复。`);
        }
        const branch = await forkBranch(lib, parent, scope, guard);
        cache = null;
        lastCache = null;
        check(guard(), '分支已保存；聊天已切换，请返回后刷新');
        ctx.chatMetadata[BINDING_KEY] = { scope, branch: branch.id };
        await ctx.saveMetadata();
        invalidateDaily();
    });
    serial = job;
    await job;
    return syncDaily();
}
