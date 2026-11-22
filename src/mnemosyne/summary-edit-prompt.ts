import { reactive, watch } from 'vue';
import { ReplyFinalityError, type ReplyBlocker } from './reply-finality';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { engineState, draftFloorCorrection } from '@/memory/engine';
import { memory } from '@/memory/store';
import type { MemSummary } from '@/memory/types';
import { relatedHigherSummaries, higherHostMemory } from './higher-summary-confirmation';
import { getLeaf, saveLeafCorrection } from '@/memory/apply';
import { normalizeTags, type EventHint } from '@/memory/contextTags';
import { getContext } from '@/st/context';
import { activeLibrary } from './db';
import { keepSummaries } from './canonical';
import { dailyState, dailyCurrent, hostScope, hostVersion, scheduleDaily, syncDaily, syncedEditReview,
    priorEditReview, confirmUnarchivedSummary, unarchivedSummaries } from './bridge';
import { check, type CapturedView } from './model';
import { saveMemberships } from './event-memberships';
import { retainRecoveredSummaries } from './summary-recovery-confirmation';
import { bodyEditSignal, editedSummaryFloor, summaryEditSignal } from './summary-edit-signal';

interface FloorDraft { floor: number; hostId: string; text: string; participants: string; eventIds: string[] }
export const summaryEditPrompt = reactive({
    open: false, busy: false, count: 0, error: '', progress: '', blocker: null as ReplyBlocker | null,
    draft: null as FloorDraft | null, events: [] as EventHint[], affected: [] as string[],
    followup: false, remainingEvents: [] as string[],
});
let ticket = 0, timer: ReturnType<typeof setTimeout> | undefined;
type Session = Awaited<ReturnType<typeof syncedEditReview>>;
let pending: Session | null = null;
let selectedOwners = new Set<string>();
let higher = new Map<string, MemSummary>();
let higherInputs = new Set<string>();
let originalLinks: string[] = [];
let savedAiText: string | undefined;
let unfinished: { host: string; generation: number } | undefined;
let originalParticipants = '';
let originalUnarchived: ReturnType<typeof unarchivedSummaries.value.get>;
export function deferSummaryEdit() {
    ticket++; if (timer) clearTimeout(timer);
    pending = null; unfinished = undefined; selectedOwners.clear(); higher.clear(); higherInputs.clear(); originalLinks = []; originalUnarchived = undefined; savedAiText = undefined;
    Object.assign(summaryEditPrompt, { open: false, error: '', blocker: null, draft: null, followup: false, events: [], affected: [], remainingEvents: [] });
}
const needsConfirmation = (state?: string) => state === 'needs_review' || state === 'needs_rebuild';
export async function prepareSummaryEditPrompt(editedFloor?: number, allowUnarchived = false, before?: ReturnType<typeof priorEditReview>, body = true) {
    if (!apiSettings.summaryEditPromptEnabled || !engineActiveHere()) return;
    deferSummaryEdit();
    const run = ticket, scope = hostScope();
    Object.assign(summaryEditPrompt, { count: 0, progress: '' });
    try {
        const result = await syncedEditReview(await syncDaily());
        const { view, validity, host, generation } = result;
        if (!await dailyCurrent(view, host, generation) || run !== ticket || scope !== hostScope() ||
            !apiSettings.summaryEditPromptEnabled || !engineActiveHere()) return;
        const positions = new Map(view.refs.map((r, floor) => [r.message, floor]));
        const chat = getContext()?.chat;
        let floor = editedFloor;
        if (floor !== undefined && chat?.[floor]?.is_user) floor++;
        const editedAnchor = floor === undefined ? undefined : view.refs[floor]?.message;
        const rows = view.memories.filter(m => needsConfirmation(validity.get(m.id)) &&
            (!before || before.branch !== view.branch.id || m.anchor === editedAnchor ||
                !needsConfirmation(before.validity.get(before.selections[m.owner]))));
        if (floor === undefined) {
            const first = rows.find(m => m.level === 0 && m.anchor);
            if (first?.anchor) floor = positions.get(first.anchor);
        }
        const anchor = floor === undefined ? undefined : view.refs[floor]?.message;
        const source = anchor && view.memories.find(m => m.level === 0 && m.anchor === anchor && m.recall && m.visibility === 'public');
        originalUnarchived = allowUnarchived && floor !== undefined ? unarchivedSummaries.value.get(floor) : undefined;
        const hostId = source ? source.hostId : originalUnarchived?.hostId;
        const leaf = floor !== undefined && chat ? getLeaf(chat[floor]) : undefined;
        const inputs = rows.map(m => m.hostId);
        if (hostId) inputs.push(hostId);
        const linked = inputs.length ? relatedHigherSummaries(memory.summaries, inputs) : new Map<string, MemSummary>();
        const selected = new Map(view.memories.map(m => [m.hostId, m]));
        const affected = new Map(rows.map(m => [m.hostId, m.anchor ? '#' + positions.get(m.anchor) : 'L' + m.level + ' 总结']));
        for (const summary of linked.values()) {
            const archived = selected.get(summary.id);
            if (!archived || needsConfirmation(validity.get(archived.id)) || body && source && editedFloor !== undefined)
                affected.set(summary.id, 'L' + summary.level + ' 总结');
        }
        if (!affected.size && !originalUnarchived && !(body && source && editedFloor !== undefined)) return;
        higher = linked; higherInputs = new Set(inputs);
        selectedOwners = new Set(rows.map(m => m.owner));
        pending = result;
        originalLinks = hostId ? (result.memberships.get(hostId) ?? []).map(e => e.id) : [];
        originalParticipants = leaf?.tags?.participants?.join('、') ?? '';
        const draft = floor !== undefined && leaf && leaf.id === hostId
            ? { floor, hostId, text: leaf.text, participants: originalParticipants, eventIds: [...originalLinks] } : null;
        Object.assign(summaryEditPrompt, { open: true, count: affected.size + Number(!!originalUnarchived), draft,
            events: draft ? result.events : [],
            affected: [...affected.values()] });
    } catch (e) {
        if (run === ticket && scope === hostScope()) Object.assign(summaryEditPrompt, { open: true,
            error: (e as Error).message, blocker: e instanceof ReplyFinalityError ? e.blocker ?? null : null });
    }
}
export async function resolveSummaryEdit(action: 'keep' | 'update' | 'later') {
    if (action === 'later') { deferSummaryEdit(); return; }
    if (summaryEditPrompt.busy || engineState.running || !pending) return;
    const session = pending, run = ticket, scope = hostScope();
    const draft = summaryEditPrompt.draft;
    let host = session.host, generation = session.generation, view = session.view, validity = session.validity;
    const live = () => run === ticket && apiSettings.summaryEditPromptEnabled && scope === hostScope() && engineActiveHere();
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
        if (draft) {
            const ctx = getContext(), leaf = getLeaf(ctx?.chat[draft.floor]);
            check(ctx && leaf?.id === draft.hostId, '当前楼层的摘要已改变');
            const ai = action === 'update';
            const generated = ai && !savedAiText ? await draftFloorCorrection(draft.floor, guard) : null;
            const text = ai ? generated?.text ?? savedAiText : draft.text.trim();
            check(text, '摘要不能为空');
            if (generated) await checkCurrent();
            if (originalUnarchived) {
                const archived = await confirmUnarchivedSummary(originalUnarchived, guard);
                originalUnarchived = undefined;
                await refresh(archived);
            }
            const tagsChanged = !ai && draft.participants !== originalParticipants;
            if (generated || text !== leaf.text || tagsChanged) {
                const tags = tagsChanged ? normalizeTags({ ...leaf.tags, participants: draft.participants.split(/[、，,\n]+/) }) : leaf.tags;
                check(saveLeafCorrection(draft.floor, draft.hostId, text, tags), '摘要已改变');
                generated?.recordSources();
                if (ai) savedAiText = text;
                draft.text = text;
                scheduleDaily();
                host = hostVersion(); generation = dailyState.generation;
                summaryEditPrompt.progress = '本楼修改已应用，正在核对关联摘要';
                await refresh();
                if (tagsChanged) originalParticipants = draft.participants;
            }
        }
        const affectedRows = () => view.memories.filter(m => needsConfirmation(validity.get(m.id)) &&
            (higher.has(m.hostId) || selectedOwners.has(m.owner) || session.validity.get(session.view.selection.selections[m.owner]) === 'valid'));
        // Revising the draft may also invalidate later L0 context dependents.
        // Include their ancestors, even if a previous edit already left those parents pending.
        const newlyAffected = affectedRows().filter(m => !higherInputs.has(m.hostId) && !higher.has(m.hostId));
        if (newlyAffected.length) {
            const ids = newlyAffected.map(m => m.hostId);
            for (const m of newlyAffected) { selectedOwners.add(m.owner); higherInputs.add(m.hostId); }
            for (const [id, summary] of relatedHigherSummaries(memory.summaries, ids)) higher.set(id, summary);
        }
        const recovered = affectedRows().filter(m => m.sourceRecovery);
        if (recovered.length) {
            const recoveredView = await retainRecoveredSummaries(view, recovered.map(m => m.id), guard, true);
            generation = dailyState.generation;
            await refresh(recoveredView);
        }
        const rows = affectedRows();
        const selectedHosts = new Set(view.memories.map(m => m.hostId));
        const retired = [...higher.values()].filter(s => !selectedHosts.has(s.id)).map(higherHostMemory);
        if (rows.length || retired.length) {
            await keepSummaries(session.lib, view, rows.map(m => m.id), guard, validity, { scope, hosts: retired });
            await refresh();
            const confirmed = new Set(view.memories.filter(m => validity.get(m.id) === 'valid').map(m => m.hostId));
            check(rows.every(m => confirmed.has(m.hostId)) && retired.every(m => confirmed.has(m.hostId)),
                '部分摘要来源仍需核对，请查看本次关联摘要');
        }
        if (draft && action === 'keep' && (originalLinks.length !== draft.eventIds.length ||
            originalLinks.some(id => !draft.eventIds.includes(id)))) {
            const memory = view.memories.find(m => m.hostId === draft.hostId && m.anchor === view.refs[draft.floor]?.message);
            check(memory, '本楼尚未归档');
            const links = pending?.memberships.get(draft.hostId) ?? [];
            check(links.length === originalLinks.length && links.every(link => originalLinks.includes(link.id)),
                '本楼的事件关联在编辑期间改变，请重新核对');
            await saveMemberships(session.lib, view, { mode: 'replace', memories: [memory.id], eventIds: [...draft.eventIds], retainOverview: true }, guard);
            originalLinks = [...draft.eventIds];
            await refresh();
        }
        if (guard() && action === 'update' && originalLinks.length) {
            Object.assign(summaryEditPrompt, { followup: true, progress: '本楼摘要已保存。需要重新生成哪条事件链的概要？',
                remainingEvents: [...originalLinks] });
        } else if (run === ticket) deferSummaryEdit();
    } catch (e) { if (run === ticket) summaryEditPrompt.error = (e as Error).message; }
    finally { summaryEditPrompt.busy = false; }
}
export function editEventGuard() {
    const selected = pending, run = ticket, scope = hostScope();
    const fresh = !!selected && selected.host === hostVersion();
    return () => fresh && run === ticket && scope === hostScope() && selected.generation === dailyState.generation &&
        apiSettings.summaryEditPromptEnabled && engineActiveHere();
}
export function bindSummaryEditPrompt() {
    if (!getContext()) return;
    const schedule = (scope: string, run: number, floor?: number, allowUnarchived = false, before = priorEditReview(), fromBody = true) => {
        if (!apiSettings.summaryEditPromptEnabled || !engineActiveHere()) return;
        // Coalesce only after the bridge has consumed UPDATED. This delay is not
        // evidence that the host finished saving; the paired signal is.
        timer = setTimeout(() => { if (scope === hostScope() && run === ticket) void prepareSummaryEditPrompt(floor, allowUnarchived, before, fromBody); }, 200);
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
        body = undefined; deferSummaryEdit(); schedule(hostScope(), ticket, editedSummaryFloor, false, priorEditReview(), false);
    });
    const unwatch = watch(() => [dailyState.scope, apiSettings.summaryEditPromptEnabled], () => {
        body = undefined; deferSummaryEdit();
    }, { flush: 'sync' });
    return () => { unwatchBody(); unwatchEdit(); unwatch(); deferSummaryEdit(); };
}
