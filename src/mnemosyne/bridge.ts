import { sourceSnapshot, sameSourceSnapshot } from '@/memory/source-snapshot';
import { HostVersionMemo } from './host-version';
import { sourceNeutralChanges } from './change-journal';
import { beginBodyEdit, settleBodyEdit, cancelBodyEdit } from './summary-edit-signal';
import { sourceSyncBaseline } from './source-sync-guard';
import { membershipProjection, syncGeneratedEventMemberships, type MembershipProjection } from './event-memberships';
import { ReplyFinality, ReplyFinalityError, type ReplyBlocker, type ReplyBlockerCursor } from './reply-finality';
import { toast } from '@/st/toast';
import { archiveWasDeleted, allowArchiveCreation, commitArchiveDeletion, type ArchiveDeletionPlan } from './archive-deletion';
import { normalizeTags, type SummaryTags, type EventHint } from '@/memory/contextTags';
import { eventView, renderPersistentEvents, type EventView } from './events';
import { previewReconnect, commitReconnect } from './binding-recovery';
import { readTables, renderTableState, commitSummaryTables, type SummaryTablePlan } from './tables';
import { TABLE_OUTPUT_KEY } from './summary-tables';
/** The only daily-library module that observes the ST host. */
import { reactive, ref, shallowRef, watch } from 'vue';
import { locateReply } from '@/st/reply-location';
import { getContext, type STMessage } from '@/st/context';
import { saveChatNow } from '@/st/chat-save';
import { chatRenderBatch } from '@/st/render-batch';
import { derivedMeta, memory } from '@/memory/store';
import { getLeaf, leafValid } from '@/memory/apply';
import { apiSettings } from '@/api/settings';
import { resolveKeepStart } from '@/memory/engine';
import { clearRecallInjection } from '@/memory/vector/recall';
import { refreshInjection } from '@/memory/inject';
import { activeLibrary, libraryActivationGeneration, ACTIVE_KEY } from './db';
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
import { row, check, type CapturedView, type SourceRef, type Branch, type Binding, type MemoryView, type MemoryRevision } from './model';
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
    validity: Map<string, MemoryStatus>;
    allowed: Set<string>;
    leaves: CanonicalLeaf[];
    host: string;
    tableText: string;
    eventText: string;
    eventHints: EventHint[];
    eventDirectory: EventHint[];
    memberships: MembershipProjection;
    eventProjection: EventView;
    library: string;
    reviewCount: number;
    changeVersion: number;
    activation: number;
}
interface SummaryBaseline { scope: string; messages: unknown[]; summaries: unknown }
const summaryBaselines = new WeakMap<DailyCache, SummaryBaseline>();
function recordSummaryBaseline(value: DailyCache) {
    if (summaryBaselines.has(value)) return;
    summaryBaselines.set(value, { scope: hostScope(),
        messages: (getContext()?.chat ?? []).map(m => sourceSnapshot(hostMessageVersion(m))),
        summaries: sourceSnapshot(memory.summaries) });
}
let cache: DailyCache | null = null;
let lastCache: DailyCache | null = null;
// 已验证的基础注入投影独立于正在写入的档案缓存；只沿已证明无关的变化续用。
let injectionCache: DailyCache | null = null;
// This grants historical text only, never current archive/body/table/recall access.
let promptHistory: { allowed: Set<string>; current: () => boolean } | null = null;
let parallelHost: { host: string; version: string } | null = null;
let serial: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
let bindingEpoch = 0;
let summaryPolicyEpoch = 0;
let summaryCachePolicy = 0;
let automaticSync: Promise<unknown> | undefined;
let automaticAgain = false;
let savedHost = '';
let scheduledHost = '';
const autoForkAttempted = new Set<string>();
const replyFinality = new ReplyFinality(() => {
    const ctx = getContext();
    return { scope: hostScope(), chat: ctx?.chat ?? [], processor: ctx?.streamingProcessor,
        errorLabel: `[${ctx?.translate?.('API Error', 'API Error') || 'API Error'}]` };
});
/** Diagnostic state is temporary and never used as permission to archive. */
export const dailyReplyBlocker = shallowRef<ReplyBlocker | null>(null);
export const replyDiagnosticEpoch = ref(0);
function invalidateReplyDiagnostics() { replyDiagnosticEpoch.value++; dailyReplyBlocker.value = null; }
export async function readReplyBlockers(cursor?: ReplyBlockerCursor) {
    const epoch = replyDiagnosticEpoch.value, binding = bindingEpoch;
    const page = await replyFinality.inspectBlockers(cursor);
    const current = () => installed && epoch === replyDiagnosticEpoch.value && binding === bindingEpoch && page.current();
    if (!current()) throw new Error('聊天或正文已变化，请重新检查');
    const continuation = page.next?.current;
    const continuing = () => installed && epoch === replyDiagnosticEpoch.value && binding === bindingEpoch && !!continuation?.();
    return { ...page, current, items: page.items.map(item => ({ ...item, current: () => installed && epoch === replyDiagnosticEpoch.value && binding === bindingEpoch && item.current() })),
        ...(page.next ? { next: { ...page.next, current: continuing } } : {}) };
}
export function locateReplyBlocker(blocker: ReplyBlocker) {
    const epoch = replyDiagnosticEpoch.value, binding = bindingEpoch;
    return locateReply(blocker.floor, () => installed && epoch === replyDiagnosticEpoch.value && binding === bindingEpoch && blocker.current());
}
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
function hostMessageVersion(m: STMessage) {
    return [m.extra?.[MESSAGE_KEY], sourceRole(m), m.mes, m.swipe_id, m.extra?.bbs_omit,
        m.extra?.bbs_leaf, m.extra?.[EVIDENCE_KEY], m.extra?.[MANUAL_KEY], m.extra?.[TABLE_OUTPUT_KEY]];
}
const hostVersions = new HostVersionMemo();
export function hostVersion(): string {
    return hostVersions.read([hostScope(), (getContext()?.chat ?? []).map(hostMessageVersion), memory.summaries, replyFinality.revision]);
}
/** 只有引擎同步提交的可见近期补摘可以沿用版本；正文编辑始终得到新版本。 */
export function recallHostVersion(): string {
    const host = hostVersion();
    return JSON.stringify([parallelHost?.host === host ? parallelHost.version : host,
        getContext()?.chat.map(m => !m.is_user && !!m.is_system)]);
}
function readableProjection(): DailyCache | null {
    return injectionCache && injectionCache.activation === libraryActivationGeneration() &&
        injectionCache.host === hostVersion() ? injectionCache : null;
}
/** 在已校验来源之后、同步落叶之前调用；返回的提交器不得跨 await 使用。 */
export function beginVisibleSummaryCommit(floor: number): () => void {
    const ctx = getContext(), message = ctx?.chat[floor], projection = readableProjection();
    if (!installed || !ctx || !message || !projection || getLeaf(message) || message.is_system ||
        message.extra?.bbs_omit || (apiSettings.autoHideEnabled && floor < resolveKeepStart(ctx.chat))) return () => {};
    const ref = projection.view.refs[floor];
    // 既有记忆若实际依赖此楼，仍走完整失效；不把“可见”当成跳过来源校验的理由。
    if (!ref || projection.view.memories.some(m => m.anchor === ref.message ||
        [...m.inputRefs, ...m.coverage].some(r => r.message === ref.message))) return () => {};
    const before = hostVersion(), originalText = message.mes;
    const version = parallelHost?.host === before ? parallelHost.version : before;
    return () => {
        if (getContext()?.chat !== ctx.chat || ctx.chat[floor] !== message || message.is_system || !leafValid(message)) return;
        const after = hostVersion();
        const prior = JSON.parse(before), next = JSON.parse(after);
        const a = prior[1][floor], b = next[1][floor];
        if (!b || [0, 1, 3, 4].some(i => JSON.stringify(a[i]) !== JSON.stringify(b[i]))) return;
        prior[1][floor] = b;
        if (JSON.stringify(prior) !== after) return; // 不吞掉同时发生的其他楼/高层摘要修改。
        replyFinality.reconcileDerived(floor, originalText);
        parallelHost = { host: after, version };
        injectionCache = { ...projection, host: after };
        scheduledHost = after;
        dailyState.generation++;
        dailyState.pending = true;
    };
}

function appendedProjection(host: string): DailyCache | null {
    if (!injectionCache) return null;
    const before = JSON.parse(injectionCache.host), after = JSON.parse(host);
    if (before[0] !== after[0] || before[3] !== after[3] || JSON.stringify(before[2]) !== JSON.stringify(after[2]) ||
        after[1].length <= before[1].length ||
        JSON.stringify(before[1]) !== JSON.stringify(after[1].slice(0, before[1].length))) return null;
    return { ...injectionCache, host };
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
export function invalidateDaily(reason = '档案视图已更新', hostNotification = false) {
    if (!hostNotification) summaryPolicyEpoch++;
    promptHistory = null;
    const scope = hostScope();
    if (dailyState.scope !== scope) { reason = '已切换聊天'; invalidateReplyDiagnostics(); }
    scheduledHost = hostVersion();
    injectionCache = hostNotification ? appendedProjection(scheduledHost) : null;
    parallelHost = null;
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
        clearRecallInjection(reason);
        refreshInjection();
    }
}
export interface CanonicalLeaf {
    tags?: SummaryTags;
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
    const allowed = readableProjection()?.allowed ?? (promptHistory?.current() ? promptHistory.allowed : new Set<string>());
    return (hostId) => allowed.has(hostId);
}
/** Restore only unaffected, verified history at the uncreated-swipe prompt boundary.
 * The archive remains pending; this path performs no host or database writes. */
export async function preparePromptHistory(type: string | undefined): Promise<boolean> {
    if (type !== 'swipe' || !installed || readableProjection()) return false;
    return serializeDailyActivation(async () => {
        promptHistory = null;
        const prior = lastCache, chat = getContext()?.chat, host = hostVersion(), epoch = bindingEpoch;
        if (!prior || !chat) return false;
        const prefix = await replyFinality.assertPromptPrefix(type);
        if (!prefix) return false;
        const before = JSON.parse(prior.host), after = JSON.parse(host);
        // A different preceding message, summary payload or binding is not a swipe-only change.
        if (before[0] !== after[0] || before[1].length !== after[1].length ||
            prior.view.refs.length !== chat.length || JSON.stringify(before[2]) !== JSON.stringify(after[2]) ||
            JSON.stringify(before[1].slice(0, prefix.cutoff)) !== JSON.stringify(after[1].slice(0, prefix.cutoff))) return false;
        const library = activeLibrary(), lib = await library;
        const currentHost = () => installed && bindingEpoch === epoch && getContext()?.chat === chat &&
            hostVersion() === host && activeLibrary() === library && lastCache === prior && prefix.current() &&
            (getContext()?.chatMetadata[BINDING_KEY] as { branch?: string; scope?: string } | undefined)?.branch === prior.view.branch.id &&
            (getContext()?.chatMetadata[BINDING_KEY] as { scope?: string } | undefined)?.scope === hostScope();
        if (!currentHost() || lib.db.name !== prior.library || await archiveWasDeleted(lib, hostScope())) return false;
        const view = await capture(lib, prior.view.branch.id, prefix.cutoff);
        if (!currentHost() || view.branch.head !== prior.view.branch.head || view.branch.view !== prior.view.branch.view ||
            view.branch.epoch !== prior.view.branch.epoch) return false;
        const validity = await statuses(lib, view);
        if (!await current(lib, view) || !currentHost()) return false;
        promptHistory = { allowed: projectView(view, validity).allowed, current: currentHost };
        return true;
    });
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

/** Read-only review UI: reuse the archived projection after checking its exact live version. */
export async function readDailyReview() {
    if (!(await replyFinality.assertArchivable(false))()) throw new ReplyFinalityError();
    const host = hostVersion(), generation = dailyState.generation, lib = await activeLibrary();
    const branch = await dailyBranch();
    if (!branch) return null;
    const prior = cache;
    const reusable = prior && prior.activation === libraryActivationGeneration() && prior.library === lib.db.name && prior.host === host &&
        prior.view.branch.id === branch.id && prior.view.branch.head === branch.head &&
        prior.view.branch.view === branch.view && prior.view.branch.epoch === branch.epoch;
    const view = reusable ? prior.view : await capture(lib, branch.id);
    const validity = reusable ? prior.validity : await statuses(lib, view);
    check(await current(lib, view) && lib === await activeLibrary(), '聊天或摘要已改变，请刷新后再处理');
    check(host === hostVersion() && generation === dailyState.generation, '聊天或摘要已改变，请刷新后再处理');
    return { view, validity, host, generation, lib };
}

async function projectEvents(lib: Awaited<ReturnType<typeof activeLibrary>>, view: CapturedView,
    checkedValidity?: Map<string, MemoryStatus>, previous?: DailyCache) {
    const eventProjection = await eventView(lib, view, false, undefined, false, { validity: checkedValidity });
    const { cards, validity } = eventProjection;
    check(await current(lib, view), '事件状态已改变，请重试');
    if (previous?.eventProjection === eventProjection) return {
        validity, eventProjection, memberships: previous.memberships, eventText: previous.eventText,
        eventHints: previous.eventHints, eventDirectory: previous.eventDirectory,
    };
    const safe = cards.filter(c => !c.needsReview && !c.blocked);
    const asHint = (c: typeof cards[number]): EventHint => ({
        id: c.chain.id, title: c.meta.title, status: c.meta.status,
        latest: c.meta.latestProgress ? `${c.meta.latestProgress.time} ${c.meta.latestProgress.text}`.trim() : undefined,
    });
    return { validity, eventProjection, memberships: membershipProjection(view, cards), eventText: renderPersistentEvents(safe),
        eventHints: safe.map(asHint),
        eventDirectory: cards.map(c => ({ ...asHint(c), archived: !!c.chain.archived, needsReview: !!c.needsReview || !!c.blocked })),
    };
}
/** syncDaily also checks lightweight chain organization flags on a warm hit.
 * A projection published by another entry point is equally reusable. */
export function syncedEventProjection(lib: Awaited<ReturnType<typeof activeLibrary>>, view: CapturedView, _beforeRevision?: number): EventView | null {
    return cache?.view === view && cache.activation === libraryActivationGeneration() && cache.changeVersion === lib.changes.version &&
        cache.library === lib.db.name && cache.host === hostVersion() ? cache.eventProjection : null;
}
export function persistentEventText(): string {
    return readableProjection()?.eventText ?? '';
}
/** Read the already archived context without cold capture/synchronization or body reads.
 * A cold/stale archive must finish its normal sync first; opening a picker never starts it.
 */
export async function readDailyMembershipContext() {
    if (!(await replyFinality.assertArchivable(false))()) throw new ReplyFinalityError();
    const host = hostVersion(), generation = dailyState.generation, lib = await activeLibrary();
    const prior = cache ?? lastCache;
    check(prior && prior.activation === libraryActivationGeneration() && prior.host === host && prior.library === lib.db.name &&
        (getContext()?.chatMetadata[BINDING_KEY] as { branch?: string } | undefined)?.branch === prior.view.branch.id,
        '档案尚未同步完成，请等待“已归档”后重试');
    const branch = await lib.get<Branch>('branches', prior.view.branch.id);
    check(branch && branch.head === prior.view.branch.head && branch.view === prior.view.branch.view,
        '档案正在更新，请稍后重新打开');
    check(host === hostVersion() && generation === dailyState.generation && lib === await activeLibrary(), '聊天已改变，请重新打开');
    return { view: { ...prior.view, branch }, lib, host, generation };
}
/** Shared editor catalog: includes archived/review chains, independently of injection cache. */
export async function readDailyEventEditor() {
    const context = await readDailyMembershipContext();
    const prior = cache ?? lastCache;
    const unchangedSources = prior && prior.host === context.host && prior.library === context.lib.db.name &&
        sourceNeutralChanges(context.lib.changes, prior.changeVersion, prior.view.branch, context.view.branch);
    const projection = await eventView(context.lib, context.view, false, undefined, false,
        { validity: unchangedSources ? prior!.validity : undefined });
    check(await dailyCurrent(context.view, context.host, context.generation) && context.lib === await activeLibrary(), '聊天已改变，请重新打开');
    return { ...context, projection };
}
/** UI membership is independent of recall eligibility; null means not currently verified. */
export function currentMembershipHints(): MembershipProjection | null {
    return readableProjection()?.memberships ?? null;
}
export function currentEventHints(): EventHint[] {
    return readableProjection()?.eventHints ?? [];
}
/** Full branch catalog for the editor only; never supplied to summary prompts. */
export function currentEventDirectory(): EventHint[] {
    return readableProjection()?.eventDirectory ?? [];
}
export function canonicalLeaves(): CanonicalLeaf[] {
    return readableProjection()?.leaves ?? [];
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
                tags: m.tags,
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

/** Preserve independently verified source/table state only across observed, committed
 * event/table edits. Unknown connections or a lost journal take the full-check path. */
async function refreshCachedProjection(lib: Awaited<ReturnType<typeof activeLibrary>>, previous: DailyCache, branch: Branch) {
    const selectedLibrary = activeLibrary();
    check(await selectedLibrary === lib && selectedLibrary === activeLibrary(), '档案库已切换，请重试');
    const version = lib.changes.version;
    const activation = libraryActivationGeneration();
    const changes = previous.activation === activation &&
        sourceNeutralChanges(lib.changes, previous.changeVersion, previous.view.branch, branch);
    const view = sameSourceSnapshot(previous.view.branch, branch) ? previous.view : { ...previous.view, branch };
    const validity = changes ? previous.validity : await statuses(lib, view);
    // Always check the small chain records: organization flags intentionally do not advance epoch.
    const events = await projectEvents(lib, view, validity, previous);
    const tablesChanged = !changes || changes.tables;
    const tableText = tablesChanged ? renderTableState(await readTables(lib, branch),
        new Set(view.memories.filter(memory => validity.get(memory.id) === 'valid').map(memory => memory.id))) : previous.tableText;
    check(await current(lib, view) && selectedLibrary === activeLibrary() && version === lib.changes.version,
        '档案在刷新期间改变，请重试');
    const changed = view !== previous.view || events.eventProjection !== previous.eventProjection ||
        validity !== previous.validity || tablesChanged;
    const value: DailyCache = changed ? { ...previous, view, ...events,
        ...(validity === previous.validity ? {} : projectView(view, validity)),
        tableText, changeVersion: version, activation } : previous;
    value.changeVersion = version;
    const baseline = summaryBaselines.get(previous);
    if (baseline) summaryBaselines.set(value, baseline);
    return { value, changed, tablesChanged };
}
/** Drain/serialize source synchronization during a library activation. This is not
 * a global lock for independent event/table writers. Never await syncDaily inside
 * action: any refresh belongs after this promise resolves. Settled errors do not
 * prevent recovery merely because dailyState.pending remains latched. */
export function serializeDailyActivation<T>(action: () => Promise<T>): Promise<T> {
    const job = serial.catch(() => {}).then(action);
    serial = job;
    return job;
}

export async function syncDaily(): Promise<CapturedView> {
    return syncDailyGuarded(() => true);
}
/** Automatic notifications may wait behind a writer; check their binding again
 * when they actually start. Direct user/request-time sync keeps its own barrier. */
async function syncDailyGuarded(isActive: () => boolean): Promise<CapturedView> {
    const job = serial
        .catch(() => {})
        .then(async () => {
            check(isActive(), '归档通知已取消');
            const ctx = getContext();
            const scope = hostScope();
            check(ctx && scope, '请先打开聊天');
            if (!(await replyFinality.assertArchivable())()) throw new ReplyFinalityError();
            check(isActive() && getContext()?.chat === ctx.chat && hostScope() === scope, '聊天已改变');
            const deletionSelector = localStorage.getItem(ACTIVE_KEY), deletionChat = ctx.chat;
            const selectedLibrary = activeLibrary(), lib = await selectedLibrary;
            check(isActive() && selectedLibrary === activeLibrary(), '归档通知已取消');
            if (injectionCache?.library !== lib.db.name) injectionCache = null;
            if (await archiveWasDeleted(lib, scope)) {
                dailyState.conflict = true;
                throw new Error('这个聊天的档案已手动删除，自动归档已暂停。如需重新建档，请明确选择“作为独立新故事”或手动继承。');
            }
            const observedHost = hostVersion(),
                observedGeneration = dailyState.generation;
            const reusable = cache ?? lastCache;
            const metadataBinding = ctx.chatMetadata[BINDING_KEY] as { branch?: string } | undefined;
            if (
                reusable &&
                metadataBinding?.branch === reusable.view.branch.id &&
                !dailyState.tableError &&
                reusable.host === observedHost &&
                reusable.library === lib.db.name
            ) {
                const live = await lib.get<Branch>('branches', reusable.view.branch.id);
                if (!live || live.head !== reusable.view.branch.head || live.view !== reusable.view.branch.view ||
                    live.epoch !== reusable.view.branch.epoch) injectionCache = null;
                if (live && live.head === reusable.view.branch.head && live.view === reusable.view.branch.view) {
                    const refreshed = await refreshCachedProjection(lib, reusable, live);
                    check(
                        observedHost === hostVersion() && isActive() && selectedLibrary === activeLibrary() && observedGeneration === dailyState.generation,
                        '聊天已改变，请重试',
                    );
                    cache = refreshed.value;
                    if (refreshed.tablesChanged) dailyState.tableRevision++;
                    if (refreshed.changed) dailyState.revision++;
                    recordSummaryBaseline(cache);
                    lastCache = injectionCache = cache;
                    summaryCachePolicy = summaryPolicyEpoch;
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
            dailyReplyBlocker.value = null;
            dailyState.status = '正在归档';
            dailyState.error = '';
            const inherited = ctx.chatMetadata[BINDING_KEY] as
                | {
                      scope?: string;
                      branch?: string;
                      independent?: boolean;
                  }
                | undefined;
            const bindings = await lib.all<Binding>('host_bindings');
            let activeBinding = bindings.find(b => !b.detached && b.scope === scope);
            const parentName = ctx.chatMetadata.main_chat;
            const attempt = `${lib.db.name}:${scope}`;
            // The host's explicit parent marker distinguishes a branch from a rename.
            if (!activeBinding && !inherited?.independent && typeof parentName === 'string' && parentName && !autoForkAttempted.has(attempt)) {
                autoForkAttempted.add(attempt);
                const guard = () => observedHost === hostVersion() && isActive() && observedGeneration === dailyState.generation && getContext()?.chatMetadata === ctx.chatMetadata;
                try {
                    const owner = JSON.parse(scope)[0];
                    const candidates = bindings.filter(b => !b.detached && b.scope === JSON.stringify([owner, parentName]));
                    check(candidates.length === 1, '来源档案不存在或不唯一');
                    const source = candidates[0];
                    check(!inherited?.branch || inherited.branch === source.branch, '来源标记不一致');
                    const parent = await capture(lib, source.branch);
                    const prefix = Math.min(parent.cutoff, ctx.chat.length);
                    check(prefix > 0, '分叉范围为空');
                    const child = await forkCurrentChat(source.branch, prefix, ctx, scope, guard);
                    activeBinding = (await lib.all<Binding>('host_bindings', 'branch', child.id))[0];
                    check(guard(), '聊天已切换');
                    const safeName = parentName.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
                    toast(`已成功继承${safeName}档案`, 'success');
                } catch (error) {
                    if (guard()) {
                        dailyState.conflict = true;
                        toast('档案继承失败，请手动检查。', 'error');
                    }
                    throw error;
                }
            }
            const currentBinding = ctx.chatMetadata[BINDING_KEY] as typeof inherited;
            if (!activeBinding && !inherited?.independent && typeof parentName === 'string' && parentName) {
                dailyState.conflict = true;
                throw new Error('档案继承失败，请手动检查。');
            }
            if ((currentBinding?.scope && currentBinding.scope !== scope && activeBinding?.branch !== currentBinding.branch) ||
                (currentBinding?.branch && !activeBinding) ||
                (currentBinding?.branch && activeBinding?.branch !== currentBinding.branch && !bindings.some(b => b.detached && b.scope === scope && b.branch === currentBinding.branch))) {
                dailyState.conflict = true;
                throw new Error('聊天名称或绑定已改变：若只是改名，请接回原档案；若创建了新分支，请明确选择新故事或继承。不自动猜测分支。');
            }
            if (!(await replyFinality.assertArchivable())()) throw new ReplyFinalityError();
            check(isActive() && getContext()?.chat === ctx.chat && hostScope() === scope, '聊天已改变');
            dailyState.conflict = false;
            const beforeIds = hostVersion();
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
            // 新追加楼层补写稳定 ID 不改变既有记忆的来源；保存失败时仍可使用原基础注入。
            if (injectionCache?.host === beforeIds) injectionCache = { ...injectionCache, host };
            scheduledHost = host; // 归档自身补写消息 ID 不等于一次新的内容编辑。
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
                    ...(leaf.tags ? { tags: normalizeTags(leaf.tags) } : {}),
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
                await saveChatNow(ctx, () => scope === hostScope() && host === hostVersion());
                delete ctx.chatMetadata.mnemosyne_ids_pending;
            }
            check(
                scope === hostScope() && isActive() && generation === dailyState.generation && host === hostVersion(),
                '聊天在归档期间改变，待重试',
            );
            ctx.chatMetadata.mnemosyne_archive_v1 = { status: 'pending', scope };
            await ctx.saveMetadata();
            const deletionTables = dailyState.tableRevision;
            const deletionGuard = () => scope === hostScope() && isActive() && generation === dailyState.generation && host === hostVersion() &&
                getContext()?.chat === deletionChat && localStorage.getItem(ACTIVE_KEY) === deletionSelector && dailyState.tableRevision === deletionTables;
            const baseline = await sourceSyncBaseline(lib, observation);
            check(deletionGuard(), '聊天在归档校验期间改变，待重试');
            const synchronized: { view?: CapturedView } = {};
            const branch = await synchronize(lib, observation, { ...baseline, isCurrent: deletionGuard },
                view => { synchronized.view = view; });
            const synchronizedVersion = lib.changes.version;
            savedHost = host;
            check(
                scope === hostScope() && isActive() && generation === dailyState.generation && host === hostVersion(),
                '归档已保存；界面已变化，请重试当前聊天',
            );
            ctx.chatMetadata[BINDING_KEY] = { scope, branch: branch.id };
            ctx.chatMetadata.mnemosyne_archive_v1 = { status: 'saved', scope, branch: branch.id, head: branch.head };
            await ctx.saveMetadata();
            // The successful write already read and checked current body payloads.
            // Metadata persistence can yield to another writer; only reuse that
            // transaction's projection while its exact branch is still current.
            const savedView = synchronized.view;
            const refreshed = savedView && lib.changes.version === synchronizedVersion
                ? await lib.transaction(['branches', 'memory_views', 'memory_revisions'], 'readonly', async tx => {
                    const live = await tx.get<Branch>('branches', branch.id);
                    if (!sameSourceSnapshot(live, savedView.branch)) return;
                    const selection = await tx.get<MemoryView>('memory_views', live!.view);
                    if (!sameSourceSnapshot(selection, savedView.selection)) return;
                    // Recovery annotations may be repaired in place. Re-read those
                    // mutable rows after the host save, even for an unchanged view ID.
                    const memories = await Promise.all(Object.values(selection!.selections)
                        .map(id => tx.get<MemoryRevision>('memory_revisions', id)));
                    if (!memories.every((memory): memory is MemoryRevision => !!memory)) return;
                    return { ...savedView, branch: live!, selection: selection!, memories };
                }) : undefined;
            let view = refreshed && lib.changes.version === synchronizedVersion
                ? refreshed : await capture(lib, branch.id);
            const validityVersion = lib.changes.version;
            let validity = await statuses(lib, view);
            check(host === hostVersion() && isActive() && generation === dailyState.generation, '归档完成；当前视图已变化');
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
                    check(host === hostVersion() && isActive() && generation === dailyState.generation, '聊天已改变');
                    await commitSummaryTables(
                        lib,
                        view,
                        saved.plan,
                        [source.id],
                        () => host === hostVersion() && isActive() && generation === dailyState.generation,
                    );
                } catch (error) {
                    dailyState.tableError = `摘要已保存，#${floor} 楼填表待处理：${String((error as Error).message)}。可刷新重试；若表已改动，请重新生成该楼摘要以替代旧请求。`;
                }
            }
            // Table sidecars may have advanced epoch during this sync. Capture that commit before
            // publishing event context; never cache a newer event projection under an older view.
            const latestBranch = await lib.get<Branch>('branches', branch.id);
            check(latestBranch && latestBranch.head === view.branch.head && latestBranch.view === view.branch.view, '归档视图已改变，请重试');
            if (latestBranch.epoch !== view.branch.epoch) {
                const neutral = sourceNeutralChanges(lib.changes, validityVersion, view.branch, latestBranch);
                view = { ...view, branch: latestBranch };
                if (!neutral) validity = await statuses(lib, view);
            }
            const inputs = await readTables(lib, view.branch);
            check(host === hostVersion() && isActive() && generation === dailyState.generation, '归档完成；当前视图已变化');
            // Generated tags become memberships only after canonical source verification.
            // Reproject the new epoch before publishing; never cache a stale event view.
            const generatedVersion = lib.changes.version;
            if (await syncGeneratedEventMemberships(lib, view,
                () => host === hostVersion() && isActive() && generation === dailyState.generation, validity)) {
                const updated = await lib.get<Branch>('branches', view.branch.id);
                check(updated && updated.head === view.branch.head && updated.view === view.branch.view,
                    '事件标签同步后视图已改变');
                const neutral = sourceNeutralChanges(lib.changes, generatedVersion, view.branch, updated);
                check(neutral && !neutral.tables, '事件标签同步期间其他来源或表格已改变，请重试');
                view = { ...view, branch: updated };
            }
            const projectionVersion = lib.changes.version;
            const events = await projectEvents(lib, view, validity);
            check(projectionVersion === lib.changes.version, '档案在刷新期间改变，请重试');
            cache = {
                view,
                ...projectView(view, validity),
                ...events,
                host,
                library: lib.db.name,
                changeVersion: projectionVersion,
                activation: libraryActivationGeneration(),
                tableText: renderTableState(
                    inputs,
                    new Set(view.memories.filter((m) => validity.get(m.id) === 'valid').map((m) => m.id)),
                ),
            };
            check(host === hostVersion() && isActive() && selectedLibrary === activeLibrary() && generation === dailyState.generation, '聊天已改变');
            recordSummaryBaseline(cache);
            lastCache = injectionCache = cache;
            summaryCachePolicy = summaryPolicyEpoch;
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
        if (!isActive()) throw error; // A superseded automatic job cannot change the new view.
        dailyState.pending = true;
        dailyState.status = error instanceof ReplyFinalityError ? '回复未确认 · 暂不归档' : 'pending · 可重试';
        dailyState.error = String(error.message ?? error);
        dailyReplyBlocker.value = error instanceof ReplyFinalityError ? error.blocker ?? null : null;
        cache = null;
        if (error instanceof ReplyFinalityError) injectionCache = null;
        throw error;
    });
}
export function dailyTableText(): string {
    return readableProjection()?.tableText ?? '';
}
/** Event/table mutations refresh only changed projections, without archiving host text. */
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
    const refreshed = await refreshCachedProjection(lib, previous, branch);
    if (cache !== previous || host !== hostVersion()) return;
    cache = refreshed.value;
    recordSummaryBaseline(cache);
    lastCache = injectionCache = cache;
    summaryCachePolicy = summaryPolicyEpoch;
    if (refreshed.tablesChanged) dailyState.tableRevision++;
    if (refreshed.changed) dailyState.revision++;
    if (installed) refreshInjection();
}
export function scheduleDaily() {
    if (!installed) return;
    // 派生重算和宿主事件只是通知；同一内容重复通知不应撤销正在等待的召回。
    if (hostVersion() !== scheduledHost) invalidateDaily('当前聊天的正文或摘要已更新', true);
    // First notification sets the deadline. Repeated renders must not postpone
    // archiving indefinitely; syncDaily still captures/validates the latest body.
    if (automaticSync) { automaticAgain = true; return; }
    if (timer !== undefined) return;
    const chat = getContext()?.chat, scope = hostScope(), epoch = bindingEpoch;
    const current = () => installed && bindingEpoch === epoch && getContext()?.chat === chat && hostScope() === scope;
    timer = setTimeout(() => {
        timer = undefined;
        if (!current()) return;
        automaticAgain = false;
        // Backpressure: at most one automatic job, even behind a slow writer.
        // New notifications request just one latest-state pass after it settles.
        const job = syncDailyGuarded(current).catch(() => {});
        automaticSync = job;
        void job.finally(() => {
            if (automaticSync !== job) return;
            automaticSync = undefined;
            if (automaticAgain && installed) {
                automaticAgain = false;
                scheduleDaily();
            }
        });
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
    const scope = hostScope();
    await allowArchiveCreation(await activeLibrary(), scope);
    ctx.chatMetadata[BINDING_KEY] = { scope, independent: true };
    for (const m of ctx.chat) {
        if (m.extra) {
            delete m.extra[MESSAGE_KEY];
            delete m.extra[EVIDENCE_KEY];
            delete m.extra[MANUAL_KEY];
        }
    }
    await saveChatNow(ctx);
    await ctx.saveMetadata();
    invalidateDaily();
    return syncDaily();
}
/** Explicitly reuse a known binding after host rename; no content-based identity guess. */
/** Dropdown metadata only: never load source bodies or summaries here. */
export async function dailyBranchChoices(includeCurrent = false) {
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
            if (owner !== character || !name || (!includeCurrent && !binding.detached && binding.scope === scope) || seen.has(binding.branch)) continue;
            const branch = await tx.get<Branch>('branches', binding.branch);
            if (!branch) continue;
            const snapshot = await tx.get<import('./model').Snapshot>('history_snapshots', branch.head);
            if (!snapshot) continue;
            seen.add(branch.id);
            const source = inherited?.branch === branch.id;
            result.push({ value: branch.id, label: `${name} · ${snapshot.length} 条消息${binding.detached ? ' · 未连接，档案保留' : binding.scope === scope ? ' · 当前聊天已绑定，可修复关联' : ''}${source ? ' · 当前聊天的来源' : ''}`,
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
        await allowArchiveCreation(lib, plan.scope);
        cache = null;
        lastCache = null;
        injectionCache = null;
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
let disposeDaily: (() => void) | undefined;
export function bindDaily() {
    disposeDaily?.();
    bindingEpoch++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    replyFinality.reset();
    hostVersions.clear();
    invalidateReplyDiagnostics();
    installed = true;
    savedHost = '';
    scheduledHost = '';
    lastCache = null;
    injectionCache = null;
    promptHistory = null;
    parallelHost = null;
    const ctx = getContext();
    if (!ctx) return;
    let active = true, eventEpoch = 0;
    let bodyEdit: { id: number; floor: number; chat: STMessage[]; message: STMessage; text: string; swipe: number; scope: string; epoch: number } | undefined;
    const rendered = chatRenderBatch(scheduleDaily);
    const handlers: { event: string; callback: (...args: any[]) => void }[] = [];
    const on = (key: string, action?: (...args: any[]) => void | Promise<void>) => {
        const event = ctx.eventTypes[key];
        if (!event) return;
        const callback = (...args: any[]) => {
            if (!active) return;
            if (key !== 'CHARACTER_MESSAGE_RENDERED' && key !== 'STREAM_TOKEN_RECEIVED') invalidateReplyDiagnostics();
            if (key === 'CHAT_CHANGED') {
                eventEpoch++;
                bindingEpoch++;
                rendered.cancel();
                if (timer !== undefined) clearTimeout(timer);
                timer = undefined;
            }
            if (!action) return scheduleDaily();
            const epoch = eventEpoch, chat = getContext()?.chat, scope = hostScope();
            const current = () => active && epoch === eventEpoch && getContext()?.chat === chat && hostScope() === scope;
            // Finality observation remains immediate. Only render-triggered
            // whole-chat comparisons are batched; permissions and request-time
            // sync still validate exact live content, without a timed cache.
            const notify = key === 'CHARACTER_MESSAGE_RENDERED' ? () => rendered.schedule() : scheduleDaily;
            const revision = replyFinality.revision;
            const result = action(...args);
            // First fragment still revokes permissions. Further renders of the same
            // live candidate do not schedule full-chat comparisons or failed archives.
            // Completion, stop, edits, other floors and chat changes retain their events.
            if (key === 'CHARACTER_MESSAGE_RENDERED' && revision === replyFinality.revision &&
                replyFinality.isStreamingFloor(args[0])) return result;
            if (key === 'STREAM_TOKEN_RECEIVED' && !result) return;
            if (key === 'STREAM_TOKEN_RECEIVED') invalidateReplyDiagnostics();
            notify();
            if (result) return result.then(() => { if (current()) notify(); }, (error) => {
                if (!current()) return;
                invalidateDaily('回复状态无法确认');
                dailyState.error = String(error);
            });
        };
        ctx.eventSource.on(event, callback);
        handlers.push({ event, callback });
    };
    const cancelBody = () => { bodyEdit = undefined; replyFinality.cancelEdit(); cancelBodyEdit(); };
    for (const key of ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SENT']) on(key, cancelBody);
    on('CHAT_CHANGED', () => { cancelBody(); replyFinality.reset(); });
    on('GENERATION_STARTED', (...args) => {
        const revision = replyFinality.revision; replyFinality.start(...args);
        if (replyFinality.revision !== revision) cancelBody();
    });
    on('STREAM_TOKEN_RECEIVED', () => replyFinality.streaming());
    on('CHARACTER_MESSAGE_RENDERED', () => replyFinality.observe());
    on('MESSAGE_RECEIVED', (floor) => replyFinality.received(floor));
    on('GENERATION_STOPPED', () => replyFinality.stop());
    on('GENERATION_ENDED', () => replyFinality.end());
    on('MESSAGE_EDITED', (floor) => {
        replyFinality.editStarted(floor);
        const chat = getContext()?.chat, message = typeof floor === 'number' ? chat?.[floor] : undefined;
        bodyEdit = chat && message ? { id: beginBodyEdit(), floor, chat, message, text: message.mes,
            swipe: message.swipe_id ?? 0, scope: hostScope(), epoch: eventEpoch } : undefined;
    });
    // UPDATED must consume the trusted confirmation below; the event alone is not acceptance.
    on('MESSAGE_UPDATED', async (floor) => {
        const edit = bodyEdit;
        await replyFinality.edited(floor);
        if (!active || !edit || bodyEdit !== edit || edit.floor !== floor || edit.epoch !== eventEpoch ||
            getContext()?.chat !== edit.chat || hostScope() !== edit.scope || edit.chat[floor] !== edit.message ||
            edit.message.mes !== edit.text || (edit.message.swipe_id ?? 0) !== edit.swipe) return;
        bodyEdit = undefined;
        // Await the completion receipt before allowing the prompt to read review state.
        settleBodyEdit(edit.id);
    });
    // TT also emits EDITED/UPDATED for slash commands and automatic output revision.
    // Only a real click on its confirmation button authorizes a quarantined fragment.
    const confirmEdit = (event: Event) => {
        if (!event.isTrusted) return;
        const button = (event.target as Element | null)?.closest?.('.mes_edit_done');
        if (!button) { replyFinality.cancelEdit(); return; }
        const element = button.closest('.mes'), id = element?.getAttribute('mesid');
        const editor = element?.querySelector<HTMLTextAreaElement>('.edit_textarea');
        if (id !== null && id !== undefined && /^\d+$/.test(id) && editor) {
            const ctx = getContext();
            const text = ctx?.powerUserSettings?.trim_spaces ? editor.value.trim() : editor.value;
            replyFinality.confirmEdit(Number(id), text);
        } else replyFinality.cancelEdit();
    };
    if (typeof document !== 'undefined') document.addEventListener('click', confirmEdit, true);
    const unwatch = watch(() => derivedMeta.rev, scheduleDaily);
    scheduleDaily();
    const dispose = () => {
        if (!active) return;
        active = false;
        invalidateReplyDiagnostics();
        cancelBody();
        bindingEpoch++;
        automaticAgain = false;
        rendered.cancel();
        installed = false;
        hostVersions.clear();
        unwatch();
        if (typeof document !== 'undefined') document.removeEventListener('click', confirmEdit, true);
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (typeof window !== 'undefined') window.removeEventListener?.('pagehide', dispose);
        for (const h of handlers) ctx.eventSource.off?.(h.event, h.callback);
        cache = null;
        injectionCache = null;
        promptHistory = null;
        parallelHost = null;
    };
    disposeDaily = dispose;
    if (typeof window !== 'undefined') window.addEventListener?.('pagehide', dispose, { once: true });
    return dispose;
}
/** A checked archived prefix can supply summary evidence while a later reply is streaming.
 * This never archives the suffix or grants it injection/table permissions. */
async function archivedSummaryEvidence(indices: number[], dependencies: string[]) {
    const prior = lastCache, ctx = getContext();
    if (!prior || !ctx || summaryCachePolicy !== summaryPolicyEpoch) return null;
    const cutoff = indices.length ? Math.max(...indices) + 1 : prior.view.refs.length;
    if (cutoff > prior.view.refs.length || indices.some(i => !Number.isInteger(i) || i < 0)) return null;
    // Published archive metadata is snapshotted once. Body strings remain shared;
    // request/response checks never parse a full-chat JSON copy.
    const baseline = summaryBaselines.get(prior);
    if (!baseline) return null;
    const expected = baseline.messages.slice(0, cutoff), messages = ctx.chat.slice(0, cutoff);
    const prefixCurrent = () => messages.every((m, i) => ctx.chat[i] === m &&
        sameSourceSnapshot(hostMessageVersion(m), expected[i])) && sameSourceSnapshot(memory.summaries, baseline.summaries);
    const scope = hostScope(), epoch = bindingEpoch, policy = summaryPolicyEpoch, library = activeLibrary();
    const hostCurrent = () => installed && bindingEpoch === epoch && summaryPolicyEpoch === policy &&
        activeLibrary() === library && getContext()?.chat === ctx.chat && hostScope() === scope &&
        messages.length === cutoff && baseline.scope === scope && prefixCurrent() &&
        (getContext()?.chatMetadata[BINDING_KEY] as { branch?: string; scope?: string } | undefined)?.branch === prior.view.branch.id &&
        (getContext()?.chatMetadata[BINDING_KEY] as { scope?: string } | undefined)?.scope === scope;
    if (!hostCurrent()) return null;
    const lib = await library;
    if (lib.db.name !== prior.library || !await current(lib, prior.view) || !hostCurrent()) return null;
    const finalityCurrent = await replyFinality.assertSummaryPrefix(cutoff);
    // Canonical validity already proves exact sources, verified plugin sidecars,
    // and explicit role-repair pairs at this same checked Head/view/epoch. Do not
    // impose a second, stricter revision equality that rejects those valid proofs.
    // This check only bounds the dependency to the unchanged host prefix.
    const refs = prior.view.refs.slice(0, cutoff);
    const validity = dependencies.length ? await statuses(lib, { ...prior.view, refs, cutoff }) : prior.validity;
    const byHost = new Map(prior.view.memories.map(m => [m.hostId, m]));
    if (dependencies.some(id => {
        const m = byHost.get(id);
        return !m || !prior.allowed.has(id) || validity.get(m.id) !== 'valid';
    })) return null;
    if (!await current(lib, prior.view) || !hostCurrent() || !finalityCurrent()) return null;
    return { view: prior.view, host: prior.host, generation: dailyState.generation, dependencies,
        inputRefs: indices.map(i => prior.view.refs[i]), current: () => hostCurrent() && finalityCurrent(),
        allowedDependencies: dependencies };
}
export async function captureSummaryEvidence(indices: number[], dependencies: string[] = []) {
    if (!installed) return null;
    const archived = await serializeDailyActivation(() => archivedSummaryEvidence(indices, dependencies));
    if (archived) return archived;
    const view = await syncDaily();
    const host = hostVersion();
    const generation = dailyState.generation;
    return { view, host, generation, dependencies, inputRefs: indices.map((i) => view.refs[i]).filter(Boolean),
        current: undefined as (() => boolean) | undefined, allowedDependencies: dependencies.filter(summaryAllowed) };
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
    const original = evidence.view.sources.get(evidence.view.refs[floor]?.revision);
    if (original && getContext()?.chat === chat) replyFinality.reconcileDerived(floor, original.content);
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
            evidence.current ? evidence.current() : evidence.generation === dailyState.generation && evidence.host === hostVersion(),
            '摘要请求期间正文已改变，旧结果不能应用',
        );
}
async function forkCurrentChat(parentId: string, prefixLength: number, ctx: NonNullable<ReturnType<typeof getContext>>,
    scope: string, guard: () => boolean) {
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
    injectionCache = null;
    promptHistory = null;
    check(guard(), '分支已保存；聊天已切换，请返回后刷新');
    ctx.chatMetadata[BINDING_KEY] = { scope, branch: branch.id };
    await ctx.saveMetadata();
    return branch;

}
export async function confirmFork(parentId: string, prefixLength: number) {
    const ctx = getContext(), scope = hostScope(), host = hostVersion(), generation = dailyState.generation;
    check(ctx && scope, '无聊天');
    const job = serial.catch(() => {}).then(async () => {
        const guard = () => scope === hostScope() && host === hostVersion() && generation === dailyState.generation;
        check(guard(), '聊天已改变，请重新选择分支');
        await forkCurrentChat(parentId, prefixLength, ctx, scope, guard);
        await allowArchiveCreation(await activeLibrary(), scope);
        invalidateDaily();
    });
    serial = job;
    await job;
    return syncDaily();
}
export async function deleteDailyArchive(lib: Awaited<ReturnType<typeof activeLibrary>>, plan: ArchiveDeletionPlan, isCurrent: () => boolean) {
    const scope = hostScope(), generation = dailyState.generation;
    const job = serial.catch(() => {}).then(async () => {
        const guard = () => isCurrent() && scope === hostScope() && generation === dailyState.generation;
        check(lib === await activeLibrary() && guard(), '聊天或数据库已改变，请重新预览删除');
        await commitArchiveDeletion(lib, plan, guard);
        cache = lastCache = injectionCache = null;
        invalidateDaily('档案已删除');
        if (plan.scopes.includes(scope)) {
            dailyState.branch = '';
            dailyState.conflict = true;
            dailyState.status = '档案已删除';
            dailyState.error = '自动归档已暂停，需要时可明确重新建档。';
            if (installed) refreshInjection();
        }
    });
    serial = job;
    await job;
    if (!plan.scopes.includes(scope)) {
        try { await syncDaily(); } catch { /* Deletion succeeded; normal archive status reports any refresh blocker. */ }
    }
}
