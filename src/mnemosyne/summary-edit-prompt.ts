import { reactive, watch } from 'vue';
import { ReplyFinalityError, type ReplyBlocker } from './reply-finality';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { engineState, draftFloorCorrection, draftHigherCorrection } from '@/memory/engine';
import { memory } from '@/memory/store';
import type { MemSummary } from '@/memory/types';
import { higherHostMemory } from './higher-summary-confirmation';
import { higherRevisionSteps, type SummaryRevisionStep } from './summary-edit-plan';
import { getLeaf, saveLeafCorrection, editSummary } from '@/memory/apply';
import { normalizeTags, type EventHint } from '@/memory/contextTags';
import { getContext } from '@/st/context';
import { activeLibrary } from './db';
import { keepSummaries } from './canonical';
import { dailyState, dailyCurrent, hostScope, hostVersion, scheduleDaily, syncDaily, syncedEditReview,
    priorEditReview, confirmUnarchivedSummary, unarchivedSummaries } from './bridge';
import { check, type CapturedView } from './model';
import { saveMemberships } from './event-memberships';
import { retainRecoveredSummaries } from './summary-recovery-confirmation';
import { bodyEditSignal, editedSummaryFloor, editedSummary, summaryEditSignal, type EditedSummary } from './summary-edit-signal';

interface SummaryDraft extends SummaryRevisionStep { text: string; participants: string; eventIds: string[] }
export { SUMMARY_EDIT_NOTICE } from './summary-edit-plan';
export const summaryEditPrompt = reactive({
    open: false, busy: false, count: 0, error: '', progress: '', blocker: null as ReplyBlocker | null,
    draft: null as SummaryDraft | null, events: [] as EventHint[], affected: [] as string[],
    step: 0, total: 0, hasNext: false, followup: false, remainingEvents: [] as string[],
});
let ticket = 0, timer: ReturnType<typeof setTimeout> | undefined;
type Session = Awaited<ReturnType<typeof syncedEditReview>>;
let pending: Session | null = null;
let manualReview = false;
let steps: SummaryRevisionStep[] = [], cursor = 0;
let summaries = new Map<string, MemSummary>();
let originalLinks: string[] = [];
let originalParticipants = '';
let generatedDraft: { text: string; recordSources?: () => void } | undefined;
let approvedStep: string | undefined;
let unfinished: { host: string; generation: number } | undefined;
let originalUnarchived: ReturnType<typeof unarchivedSummaries.value.get>;
const rewrittenEvents = new Set<string>();

export function deferSummaryEdit() {
    ticket++; if (timer) clearTimeout(timer);
    pending = null; manualReview = false; unfinished = undefined; steps = []; cursor = 0; summaries.clear();
    originalLinks = []; originalUnarchived = undefined; generatedDraft = undefined; approvedStep = undefined; rewrittenEvents.clear();
    Object.assign(summaryEditPrompt, { open: false, error: '', blocker: null, draft: null, followup: false,
        events: [], affected: [], remainingEvents: [], count: 0, step: 0, total: 0, hasNext: false });
}
const needsConfirmation = (state?: string) => state === 'needs_review' || state === 'needs_rebuild';

/** Load one item from the fixed edit queue, never from the global pending list. */
function loadStep() {
    const step = steps[cursor];
    check(step && pending, '待修订条目已改变，请重新打开');
    const leaf = step.level === 0 && step.floor !== undefined ? getLeaf(getContext()?.chat[step.floor]) : undefined;
    const summary = step.level > 0 ? summaries.get(step.hostId) : undefined;
    check(step.level === 0 ? leaf?.id === step.hostId : summary?.level === step.level, '待修订条目已改变，请重新打开');
    originalLinks = step.level === 0 ? (pending.memberships.get(step.hostId) ?? []).map(event => event.id) : [];
    originalParticipants = leaf?.tags?.participants?.join('、') ?? '';
    generatedDraft = undefined; approvedStep = undefined;
    Object.assign(summaryEditPrompt, { open: true, draft: { ...step, text: leaf?.text ?? summary!.text,
        participants: originalParticipants, eventIds: [...originalLinks] },
        count: steps.length - cursor, step: cursor + 1, total: steps.length, hasNext: cursor + 1 < steps.length,
        affected: steps.slice(cursor + 1).map(item => item.label), events: pending.events, progress: '', error: '' });
}

export async function prepareSummaryEditPrompt(editedFloor?: number, allowUnarchived = false,
    _before?: ReturnType<typeof priorEditReview>, body = true, target?: EditedSummary, includeTarget = false) {
    if ((!apiSettings.summaryEditPromptEnabled && !includeTarget) || !engineActiveHere()) return;
    deferSummaryEdit();
    manualReview = includeTarget;
    // Unknown edit identity must not turn the first unrelated pending L0 into a target.
    if (body ? editedFloor === undefined : !target && editedFloor === undefined) return;
    const run = ticket, scope = hostScope();
    summaryEditPrompt.progress = '';
    try {
        const result = await syncedEditReview(await syncDaily());
        const { view, host, generation } = result;
        if (!await dailyCurrent(view, host, generation) || run !== ticket || scope !== hostScope() ||
            !apiSettings.summaryEditPromptEnabled && !manualReview || !engineActiveHere()) return;
        const chat = getContext()?.chat;
        let floor = editedFloor;
        if (floor !== undefined && chat?.[floor]?.is_user) floor++;
        const leaf = floor !== undefined && chat ? getLeaf(chat[floor]) : undefined;
        const anchor = floor === undefined ? undefined : view.refs[floor]?.message;
        const source = anchor && view.memories.find(item => item.level === 0 && item.anchor === anchor &&
            item.recall && item.visibility === 'public');
        originalUnarchived = body && allowUnarchived && floor !== undefined ? unarchivedSummaries.value.get(floor) : undefined;
        const identity = body ? source ? { hostId: source.hostId, level: 0 }
            : originalUnarchived ? { hostId: originalUnarchived.hostId, level: 0 } : undefined
            : target ?? (leaf ? { hostId: leaf.id, level: 0 } : undefined);
        if (!identity || identity.level === 0 && (!leaf || leaf.id !== identity.hostId)) return;
        summaries = new Map(memory.summaries.map(summary => [summary.id, summary]));
        if (identity.level > 0) check(summaries.get(identity.hostId)?.level === identity.level, '当前总结已改变，请刷新后重新打开');
        const positions = new Map(view.refs.map((ref, index) => [ref.message, index]));
        const floors = new Map(view.memories.filter(item => item.level === 0 && item.anchor && positions.has(item.anchor))
            .map(item => [item.hostId, positions.get(item.anchor!)!]));
        if (floor !== undefined) floors.set(identity.hostId, floor);
        steps = higherRevisionSteps(memory.summaries, identity.hostId, floors, includeTarget);
        if (body && floor !== undefined) steps.unshift({ hostId: identity.hostId, level: 0, floor, label: '#' + floor + ' 楼 · 摘要' });
        if (!steps.length) return;
        pending = result; cursor = 0; loadStep();
    } catch (e) {
        if (run === ticket && scope === hostScope()) Object.assign(summaryEditPrompt, { open: true,
            error: (e as Error).message, blocker: e instanceof ReplyFinalityError ? e.blocker ?? null : null });
    }
}

/** A pending-list entry has not been confirmed yet, so its own summary is the first step. */
export async function prepareHigherSummaryReview(hostId: string) {
    const summary = memory.summaries.find(item => item.id === hostId);
    check(summary && summary.level > 0 && !summary.imported, '当前总结已改变，请刷新后重新打开');
    await prepareSummaryEditPrompt(undefined, false, undefined, false, { hostId, level: summary.level }, true);
}

export async function resolveSummaryEdit(action: 'keep' | 'update' | 'later') {
    if (action === 'later') { deferSummaryEdit(); return; }
    if (summaryEditPrompt.busy || engineState.running || !pending || !summaryEditPrompt.draft) return;
    const session = pending, run = ticket, scope = hostScope(), draft = summaryEditPrompt.draft;
    let host = session.host, generation = session.generation, view = session.view, validity = session.validity;
    const live = () => run === ticket && (apiSettings.summaryEditPromptEnabled || manualReview) && scope === hostScope() && engineActiveHere();
    const guard = () => live() && host === hostVersion() && generation === dailyState.generation;
    const checkCurrent = async () => check(session.lib === await activeLibrary() && await dailyCurrent(view, host, generation) && guard(),
        '聊天、事件或摘要已改变，请重新核对');
    const refresh = async (synced?: CapturedView) => {
        unfinished = { host, generation };
        const next = await syncedEditReview(synced ?? await syncDaily());
        check(next && guard() && next.lib === session.lib && next.view.branch.id === session.view.branch.id, '聊天或摘要已改变，请重新核对');
        view = next.view; validity = next.validity; pending = next; unfinished = undefined;
    };
    summaryEditPrompt.busy = true; summaryEditPrompt.error = '';
    try {
        if (unfinished) {
            host = unfinished.host; generation = unfinished.generation;
            check(guard(), '聊天或摘要已改变，请重新核对');
            await refresh();
        }
        await checkCurrent();
        if (action === 'update') {
            const generated = draft.level === 0
                ? await draftFloorCorrection(draft.floor!, guard) : await draftHigherCorrection(draft.hostId, guard);
            await checkCurrent();
            generatedDraft = generated; draft.text = generated.text;
            summaryEditPrompt.progress = 'AI 草稿已生成，请核对或修改后确认保存。';
            return;
        }
        const text = draft.text.trim();
        check(text, draft.level === 0 ? '摘要不能为空' : '总结不能为空');
        if (draft.level === 0) {
            const leaf = getLeaf(getContext()?.chat[draft.floor!]);
            check(leaf?.id === draft.hostId, '当前楼层的摘要已改变');
            if (originalUnarchived) {
                const archived = await confirmUnarchivedSummary(originalUnarchived, guard);
                originalUnarchived = undefined;
                await refresh(archived);
            }
            const tagsChanged = draft.participants !== originalParticipants;
            if (generatedDraft || text !== leaf.text || tagsChanged) {
                approvedStep = undefined;
                const tags = tagsChanged ? normalizeTags({ ...leaf.tags, participants: draft.participants.split(/[、，,\n]+/) }) : leaf.tags;
                check(saveLeafCorrection(draft.floor!, draft.hostId, text, tags), '摘要已改变');
                generatedDraft?.recordSources?.();
                if (generatedDraft) originalLinks.forEach(id => rewrittenEvents.add(id));
                generatedDraft = undefined; draft.text = text;
                scheduleDaily(); host = hostVersion(); generation = dailyState.generation;
                summaryEditPrompt.progress = '正在保存当前摘要';
                await refresh(); originalParticipants = draft.participants;
            }
        } else {
            const summary = summaries.get(draft.hostId);
            check(summary?.level === draft.level, '当前总结已改变');
            if (text !== summary.text) {
                approvedStep = undefined;
                check(editSummary(draft.hostId, text, false), '当前总结已改变');
                scheduleDaily(); host = hostVersion(); generation = dailyState.generation;
                summaryEditPrompt.progress = '正在保存当前总结';
                await refresh();
            }
            generatedDraft = undefined;
        }
        let current = view.memories.find(item => item.hostId === draft.hostId);
        if (current?.sourceRecovery) {
            const recoveredView = await retainRecoveredSummaries(view, [current.id], guard, true);
            generation = dailyState.generation;
            await refresh(recoveredView);
            current = view.memories.find(item => item.hostId === draft.hostId);
        }
        // Approving this item must never approve any ancestor. Each later step is explicit.
        if (approvedStep !== draft.hostId && current && (draft.level > 0 || needsConfirmation(validity.get(current.id)))) {
            await keepSummaries(session.lib, view, [current.id], guard, validity, undefined, true);
            approvedStep = draft.hostId;
            await refresh();
        } else if (approvedStep !== draft.hostId && !current && draft.level > 0) {
            const summary = summaries.get(draft.hostId)!;
            await keepSummaries(session.lib, view, [], guard, validity, { scope, hosts: [higherHostMemory(summary)] }, true);
            approvedStep = draft.hostId;
            await refresh();
        }
        current = view.memories.find(item => item.hostId === draft.hostId);
        check(current && validity.get(current.id) === 'valid', '当前条目的来源仍需核对，请先处理其下级摘要');
        if (draft.level === 0 && (originalLinks.length !== draft.eventIds.length ||
            originalLinks.some(id => !draft.eventIds.includes(id)))) {
            const links = pending?.memberships.get(draft.hostId) ?? [];
            check(links.length === originalLinks.length && links.every(link => originalLinks.includes(link.id)),
                '本楼的事件关联在编辑期间改变，请重新核对');
            await saveMemberships(session.lib, view, { mode: 'replace', memories: [current.id], eventIds: [...draft.eventIds], retainOverview: true }, guard);
            originalLinks = [...draft.eventIds];
            await refresh();
        }
        if (!guard()) return;
        if (++cursor < steps.length) loadStep();
        else if (rewrittenEvents.size) {
            Object.assign(summaryEditPrompt, { followup: true, draft: null, count: 0, affected: [], hasNext: false,
                progress: '摘要与相关总结已保存。可按需重新生成事件链概要，也可保留现有概要。', remainingEvents: [...rewrittenEvents] });
        } else deferSummaryEdit();
    } catch (e) { if (run === ticket) summaryEditPrompt.error = (e as Error).message; }
    finally { summaryEditPrompt.busy = false; }
}

export function editEventGuard() {
    const selected = pending, run = ticket, scope = hostScope();
    const fresh = !!selected && selected.host === hostVersion();
    return () => fresh && run === ticket && scope === hostScope() && selected.generation === dailyState.generation &&
        (apiSettings.summaryEditPromptEnabled || manualReview) && engineActiveHere();
}
export function bindSummaryEditPrompt() {
    if (!getContext()) return;
    const schedule = (scope: string, run: number, floor?: number, allowUnarchived = false,
        before = priorEditReview(), fromBody = true, target?: EditedSummary) => {
        if (!apiSettings.summaryEditPromptEnabled || !engineActiveHere()) return;
        // Coalesce only after the bridge has consumed UPDATED. The paired signal is the save evidence.
        timer = setTimeout(() => { if (scope === hostScope() && run === ticket)
            void prepareSummaryEditPrompt(floor, allowUnarchived, before, fromBody, target); }, 200);
    };
    let body: { id: number; ticket: number; scope: string; floor?: number; before?: ReturnType<typeof priorEditReview> } | undefined;
    const unwatchBody = watch(bodyEditSignal, signal => {
        if (!signal) return;
        if (signal.phase === 'cancelled') {
            body = undefined; deferSummaryEdit();
        } else if (signal.phase === 'started') {
            deferSummaryEdit();
            body = { id: signal.id, ticket, scope: hostScope(), floor: signal.floor, before: priorEditReview() };
        } else if (body?.id === signal.id) {
            const saved = body; body = undefined;
            if (saved.ticket === ticket && saved.scope === hostScope()) schedule(saved.scope, saved.ticket, saved.floor, signal.allowUnarchived, saved.before);
        }
    }, { flush: 'sync' });
    const unwatchEdit = watch(summaryEditSignal, () => {
        body = undefined; deferSummaryEdit();
        schedule(hostScope(), ticket, editedSummaryFloor, false, priorEditReview(), false, editedSummary);
    });
    const unwatch = watch(() => [dailyState.scope, apiSettings.summaryEditPromptEnabled], () => {
        body = undefined; deferSummaryEdit();
    }, { flush: 'sync' });
    return () => { unwatchBody(); unwatchEdit(); unwatch(); deferSummaryEdit(); };
}
