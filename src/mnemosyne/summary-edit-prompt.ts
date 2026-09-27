import { reactive, watch } from 'vue';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { engineState } from '@/memory/engine';
import { getContext } from '@/st/context';
import { activeLibrary } from './db';
import { keepSummaries, statuses } from './canonical';
import { dailyState, dailyCurrent, hostScope, hostVersion, invalidateDaily, syncDaily } from './bridge';
import { check, type CapturedView } from './model';
import { rebuildSummaryOwners } from './summary-review-actions';
import { summaryEditSignal } from './summary-edit-signal';

export const summaryEditPrompt = reactive({ open: false, busy: false, count: 0, error: '', progress: '' });
let ticket = 0, timer: ReturnType<typeof setTimeout> | undefined;
let pending: { view: CapturedView; ids: string[]; host: string; generation: number; lib: Awaited<ReturnType<typeof activeLibrary>> } | null = null;
export function deferSummaryEdit() {
    ticket++; if (timer) clearTimeout(timer);
    pending = null; summaryEditPrompt.open = false; summaryEditPrompt.error = '';
}
export async function prepareSummaryEditPrompt() {
    if (!apiSettings.summaryEditPromptEnabled || !engineActiveHere()) return;
    const run = ++ticket, scope = hostScope();
    summaryEditPrompt.open = false; pending = null;
    try {
        const view = await syncDaily(), host = hostVersion(), generation = dailyState.generation, lib = await activeLibrary();
        const validity = await statuses(lib, view);
        if (run !== ticket || scope !== hostScope() || !apiSettings.summaryEditPromptEnabled || !await dailyCurrent(view, host, generation)) return;
        const ids = view.memories.filter(m => ['needs_review', 'needs_rebuild'].includes(validity.get(m.id) ?? '')).map(m => m.id);
        if (!ids.length) return;
        pending = { view, ids, host, generation, lib };
        Object.assign(summaryEditPrompt, { open: true, count: ids.length, error: '', progress: '' });
    } catch (e) {
        if (run === ticket && scope === hostScope()) {
            pending = null;
            Object.assign(summaryEditPrompt, { open: true, count: 0, error: (e as Error).message });
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
    const ctx = getContext(); if (!ctx) return;
    const edited = () => {
        deferSummaryEdit();
        if (!apiSettings.summaryEditPromptEnabled || !engineActiveHere()) return;
        const scope = hostScope(), run = ticket;
        // Let the host edit and the existing 200ms derived/archive debounce settle first.
        timer = setTimeout(() => { if (scope === hostScope() && run === ticket) void prepareSummaryEditPrompt(); }, 350);
    };
    const event = ctx.eventTypes.MESSAGE_EDITED;
    if (event) ctx.eventSource.on(event, edited);
    const unwatchEdit = watch(summaryEditSignal, edited);
    const unwatch = watch(() => [dailyState.scope, apiSettings.summaryEditPromptEnabled], deferSummaryEdit, { flush: 'sync' });
    return () => { if (event) ctx.eventSource.off?.(event, edited); unwatchEdit(); unwatch(); deferSummaryEdit(); };
}
