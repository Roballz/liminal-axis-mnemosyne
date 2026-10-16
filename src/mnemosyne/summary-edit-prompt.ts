import { reactive, watch } from 'vue';
import { ReplyFinalityError, type ReplyBlocker } from './reply-finality';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { engineState } from '@/memory/engine';
import { getContext } from '@/st/context';
import { activeLibrary } from './db';
import { keepSummaries } from './canonical';
import { dailyState, dailyCurrent, hostScope, hostVersion, invalidateDaily, syncDaily, readDailyReview } from './bridge';
import { check, type CapturedView } from './model';
import { rebuildSummaryOwners } from './summary-review-actions';
import { summaryEditSignal, bodyEditSignal } from './summary-edit-signal';

export const summaryEditPrompt = reactive({ open: false, busy: false, count: 0, error: '', progress: '', blocker: null as ReplyBlocker | null });
let ticket = 0, timer: ReturnType<typeof setTimeout> | undefined;
let pending: { view: CapturedView; ids: string[]; host: string; generation: number; lib: Awaited<ReturnType<typeof activeLibrary>> } | null = null;
export function deferSummaryEdit() {
    ticket++; if (timer) clearTimeout(timer);
    pending = null; summaryEditPrompt.open = false; summaryEditPrompt.error = ''; summaryEditPrompt.blocker = null;
}
export async function prepareSummaryEditPrompt() {
    if (!apiSettings.summaryEditPromptEnabled || !engineActiveHere()) return;
    const run = ++ticket, scope = hostScope();
    summaryEditPrompt.open = false; summaryEditPrompt.blocker = null; pending = null;
    try {
        await syncDaily();
        const result = await readDailyReview();
        if (!result) return;
        const { view, validity, host, generation, lib } = result;
        if (!await dailyCurrent(view, host, generation) || run !== ticket || scope !== hostScope() ||
            !apiSettings.summaryEditPromptEnabled || !engineActiveHere()) return;
        const ids = view.memories.filter(m => ['needs_review', 'needs_rebuild'].includes(validity.get(m.id) ?? '')).map(m => m.id);
        if (!ids.length) return;
        pending = { view, ids, host, generation, lib };
        Object.assign(summaryEditPrompt, { open: true, count: ids.length, error: '', progress: '' });
    } catch (e) {
        if (run === ticket && scope === hostScope()) {
            pending = null;
            Object.assign(summaryEditPrompt, { open: true, count: 0, error: (e as Error).message, blocker: e instanceof ReplyFinalityError ? e.blocker ?? null : null });
        }
    }
}
export async function resolveSummaryEdit(action: 'keep' | 'update' | 'later') {
    if (action === 'later') { deferSummaryEdit(); return; }
    if (summaryEditPrompt.busy || engineState.running) return;
    const selected = pending, run = ticket;
    if (!selected) return;
    let host = selected.host, generation = selected.generation;
    const guard = () => run === ticket && apiSettings.summaryEditPromptEnabled && host === hostVersion() && generation === dailyState.generation;
    summaryEditPrompt.busy = true; summaryEditPrompt.error = '';
    try {
        check(guard() && selected.lib === await activeLibrary() && await dailyCurrent(selected.view, host, generation), '聊天或摘要已改变，请在待审核摘要中处理最新版本');
        if (action === 'keep') {
            await keepSummaries(selected.lib, selected.view, selected.ids, guard);
            invalidateDaily(); await syncDaily();
        } else {
            const owners = selected.view.memories.filter(m => selected.ids.includes(m.id)).map(m => m.owner);
            await rebuildSummaryOwners(owners, selected.view.branch.id, guard, done => {
                host = hostVersion(); generation = dailyState.generation;
                summaryEditPrompt.progress = `已更新 ${done} 条摘要`;
            }, () => run !== ticket || !apiSettings.summaryEditPromptEnabled);
        }
        if (run === ticket) deferSummaryEdit();
    } catch (e) { if (run === ticket) summaryEditPrompt.error = (e as Error).message; }
    finally { summaryEditPrompt.busy = false; }
}
export function bindSummaryEditPrompt() {
    if (!getContext()) return;
    const schedule = (scope: string, run: number) => {
        if (!apiSettings.summaryEditPromptEnabled || !engineActiveHere()) return;
        // Coalesce only after the bridge has consumed UPDATED. This delay is not
        // evidence that the host finished saving; the paired signal is.
        timer = setTimeout(() => { if (scope === hostScope() && run === ticket) void prepareSummaryEditPrompt(); }, 200);
    };
    let body: { id: number; ticket: number; scope: string } | undefined;
    const unwatchBody = watch(bodyEditSignal, signal => {
        if (!signal) return;
        if (signal.phase === 'cancelled') {
            body = undefined; deferSummaryEdit();
        } else if (signal.phase === 'started') {
            deferSummaryEdit();
            body = { id: signal.id, ticket, scope: hostScope() };
        } else if (body?.id === signal.id) {
            const saved = body; body = undefined;
            if (saved.ticket === ticket && saved.scope === hostScope()) schedule(saved.scope, saved.ticket);
        }
    }, { flush: 'sync' });
    const unwatchEdit = watch(summaryEditSignal, () => {
        body = undefined; deferSummaryEdit(); schedule(hostScope(), ticket);
    });
    const unwatch = watch(() => [dailyState.scope, apiSettings.summaryEditPromptEnabled], () => {
        body = undefined; deferSummaryEdit();
    }, { flush: 'sync' });
    return () => { unwatchBody(); unwatchEdit(); unwatch(); deferSummaryEdit(); };
}
