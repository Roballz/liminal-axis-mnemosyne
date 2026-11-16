import { reactive, watch } from 'vue';
import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import { getChannelForTask, engineActiveHere } from '@/api/settings';
import { engineState } from '@/memory/engine';
import { getContext } from '@/st/context';
import { activeLibrary, libraryActivationGeneration, type Library } from './db';
import { syncDaily, refreshDailyTables, dailyState, hostScope, hostVersion } from './bridge';
import { eventView } from './events';
import { manualEventState, eventPending, eventCoverageUpgradeNeeded, updateEventOverview } from './manual-events';
import { check, type Branch } from './model';
import { settings, readDailySettings, eventOverviewMaxChars, eventBatchTokens, eventMaterialMode } from './event-settings';
export { settings } from './event-settings';
export const jobState = reactive({ busy: false, status: '未运行', chars: 0, completed: 0, stopped: false });
let stop = false;
interface EventTrigger { scope: string; generation: number; activation: number; revision: number }
let ownedPublication: EventTrigger | undefined;
const eventTrigger = (): EventTrigger => ({ scope: hostScope(), generation: dailyState.generation,
    activation: libraryActivationGeneration(), revision: dailyState.revision });
const sameTriggerScope = (a: EventTrigger, b: EventTrigger) => a.scope === b.scope &&
    a.generation === b.generation && a.activation === b.activation;
export async function loadDailySettings() {
    const generation = libraryActivationGeneration();
    const lib = await activeLibrary(), next = await readDailySettings(lib);
    // A startup/backfill read from the previous library may finish after a restore.
    if (generation === libraryActivationGeneration()) Object.assign(settings, next);
}
export async function saveDailySettings() {
    eventOverviewMaxChars(); eventBatchTokens(); eventMaterialMode();
    for (const key of ['interval', 'batchSize', 'backfillBatchSize', 'maxChars'] as const)
        check(Number.isSafeInteger(settings[key]) && settings[key] > 0, '间隔/批量/预算必须为正整数');
    for (const key of ['delay', 'chains', 'excerptChars', 'totalChars'] as const)
        check(Number.isInteger(settings[key]) && settings[key] >= 0, '延迟/额度不能为负');
    check(settings.batchSize <= 200 && [0,1].includes(settings.extra), '批量最多200；每链额外进展最多1');
    await (await activeLibrary()).transaction(['library_meta'], 'readwrite', tx => tx.put('library_meta', { id: 'daily-settings', schema: 1, value: JSON.parse(JSON.stringify(settings)) } as any));
}
export type Sender = (messages: ChatMsg[]) => Promise<string>;
export const sendDaily: Sender = async (messages) => {
    const channel = getChannelForTask('summary');
    return channel ? requestCompletion(channel, messages) : requestViaMainApi(messages);
};
export function stopDailyJob() { stop = true; jobState.stopped = true; jobState.status = '正在停止：等待当前请求返回，不再提交或发起下一批'; }
export async function runEvents(manual = true, sender: Sender = sendDaily) {
    await runEventJob(manual, sender);
}
async function runEventJob(manual: boolean, sender: Sender, isActive: () => boolean = () => true) {
    if (jobState.busy || manualEventState.busy)
        return;
    jobState.busy = true;
    stop = false;
    jobState.stopped = false;
    jobState.completed = 0;
    let captured: EventTrigger | undefined, publishedLibrary: Library | undefined, capturedHost = '';
    try {
        const initial = await syncDaily();
        const lib = await activeLibrary();
        check(isActive(), '事件任务已取消');
        const branchId = initial.branch.id;
        const target = initial.cutoff;
        const host = hostVersion(), scope = hostScope(), generation = dailyState.generation;
        captured = eventTrigger(); publishedLibrary = lib; capturedHost = host;
        const guard = () => isActive() && !stop && host === hostVersion() && generation === dailyState.generation &&
            captured!.activation === libraryActivationGeneration();
        const cards = (await eventView(lib, initial)).cards;
        const last = Math.max(0, ...cards.flatMap(c => c.progress.map(p => p.cutoff)));
        if (!manual && target - last < settings.interval) return captured;
        const pending = cards.filter(c => !c.blocked && (manual || !c.needsReview) && (eventPending(c) || manual && eventCoverageUpgradeNeeded(c))).map(c => c.chain.id);
        const blocked = cards.filter(c => c.blocked && eventPending(c));
        for (const id of pending) {
            if (stop) break;
            check(guard(), '聊天改变，事件任务停止');
            // Event commits only advance epoch. Reuse immutable source/memory rows
            // while their head and selection are identical; never recapture old data silently.
            const branch = await lib.get<Branch>('branches', branchId);
            check(branch && branch.story === initial.branch.story && branch.head === initial.branch.head && branch.view === initial.branch.view,
                '事件任务的正文或摘要视图已改变，请重新开始');
            const view = { ...initial, branch };
            jobState.status = `更新概要 ${jobState.completed + 1} / ${pending.length}`;
            let batch = 0;
            const updated = await updateEventOverview(lib, view, id, settings.overviewBatchTokens,
                messages => {
                    jobState.chars = messages.reduce((n, m) => n + m.content.length, 0);
                    jobState.status = `更新概要 ${jobState.completed + 1} / ${pending.length} · 第 ${++batch} 批`;
                    return sender(messages);
                }, guard, manual, () => isActive() && !stop && scope === hostScope() && generation === dailyState.generation &&
                    captured!.activation === libraryActivationGeneration());
            if (updated) jobState.completed++;
        }
        if (!stop) jobState.status = `批量整理完成：更新 ${jobState.completed} 条事件链` +
            (blocked.length ? `；${blocked.length} 条来源异常已跳过：${blocked.slice(0, 3).map(c => c.meta.title).join('、')}。展开事件查看问题摘要` : '');
        if (stop)
            jobState.status = '已停止；已保存概要保留，其余仍待更新';
    }
    catch (error) {
        jobState.status = String((error as Error).message);
    }
    finally {
        // Event commits only change derived rows. Publish them once after the job,
        // including saved chains before a stop/error, without a host rearchive.
        try {
            if (jobState.completed && captured && isActive() && capturedHost === hostVersion() &&
                sameTriggerScope(captured, eventTrigger()) && publishedLibrary === await activeLibrary() && isActive()) {
                // The bridge invokes this only at its synchronous publication
                // boundary. Do not suppress independent revisions during its reads.
                await refreshDailyTables(revision => { ownedPublication = { ...eventTrigger(), revision }; });
            }
        } catch (error) {
            jobState.status += `；概要已保存，刷新未完成：${String((error as Error).message)}`;
        } finally {
            ownedPublication = undefined;
            jobState.busy = false;
        }
    }
    return captured;
}
let disposeDailyJobs: (() => void) | undefined;
export function bindDailyJobs() {
    disposeDailyJobs?.();
    let active = true, loaded = false, pending: EventTrigger | undefined;
    let automatic: Promise<EventTrigger | undefined> | undefined;
    const drain = () => {
        if (!active || !loaded || !pending || automatic) return;
        if (!settings.eventsEnabled || !engineActiveHere() || !sameTriggerScope(pending, eventTrigger())) {
            pending = undefined; return;
        }
        if (jobState.busy || manualEventState.busy || engineState.running || dailyState.pending) return;
        const requested = pending; pending = undefined;
        const task = runEventJob(false, sendDaily, () => active && sameTriggerScope(requested, eventTrigger()));
        automatic = task;
        void task.then(captured => {
            // A revision emitted by the job's own initial sync is already part
            // of its captured input; do not archive/check the same input twice.
            if (jobState.stopped || pending && captured && sameTriggerScope(pending, captured) && pending.revision <= captured.revision)
                pending = undefined;
        }, error => {
            if (active) jobState.status = String(error);
        }).finally(() => {
            if (automatic === task) automatic = undefined;
            drain();
        });
    };
    const request = () => {
        if (!active) return;
        const next = eventTrigger();
        if (ownedPublication && sameTriggerScope(next, ownedPublication) && next.revision === ownedPublication.revision) {
            ownedPublication = undefined;
            return;
        }
        if (loaded && (!settings.eventsEnabled || !engineActiveHere())) { pending = undefined; return; }
        if (!next.scope) return;
        pending = next; drain();
    };
    // Remember one latest notification while summary generation or manual review
    // is busy. Idle transitions resume it without opening any plugin page.
    const watches = [watch(() => dailyState.revision, request, { flush: 'sync' }),
        watch(() => [engineState.running, manualEventState.busy, jobState.busy, dailyState.pending,
            settings.eventsEnabled, engineActiveHere()], drain)];
    const ctx = getContext();
    const event = ctx?.eventTypes.GENERATION_ENDED;
    if (event) ctx!.eventSource.on(event, request);
    const dispose = () => {
        if (!active) return;
        active = false; pending = undefined;
        for (const unwatch of watches) unwatch();
        if (event) ctx!.eventSource.off?.(event, request);
        if (typeof window !== 'undefined') window.removeEventListener?.('pagehide', dispose);
    };
    disposeDailyJobs = dispose;
    if (typeof window !== 'undefined') window.addEventListener?.('pagehide', dispose, { once: true });
    void loadDailySettings().then(() => { loaded = true; drain(); }).catch(error => {
        if (active) jobState.status = String(error);
    });
    return dispose;
}
