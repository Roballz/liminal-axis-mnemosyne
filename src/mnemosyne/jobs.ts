import { reactive, watch } from 'vue';
import { requestCompletion, requestViaMainApi } from '@/api/client';
import { getChannelForTask, engineActiveHere } from '@/api/settings';
import { engineState } from '@/memory/engine';
import { getContext } from '@/st/context';
import { activeLibrary } from './db';
import { capture, current } from './canonical';
import { syncDaily, dailyState, hostVersion, dailyCurrent } from './bridge';
import { eventView } from './events';
import { manualEventState, eventPending, updateEventOverview } from './manual-events';
import { check } from './model';
export const settings = reactive({ eventsEnabled: false, interval: 40, delay: 0, batchSize: 20, backfillBatchSize: 20, maxChars: 48000,
    chains: 2, excerptChars: 500, totalChars: 1600, extra: 1 });
export const jobState = reactive({ busy: false, status: '未运行', chars: 0, completed: 0, stopped: false });
let stop = false;
export async function loadDailySettings() {
    const stored = await (await activeLibrary()).get<any>('library_meta', 'daily-settings');
    if (stored)
        Object.assign(settings, stored.value);
}
export async function saveDailySettings() {
    for (const key of ['interval', 'batchSize', 'backfillBatchSize', 'maxChars'] as const)
        check(Number.isSafeInteger(settings[key]) && settings[key] > 0, '间隔/批量/预算必须为正整数');
    for (const key of ['delay', 'chains', 'excerptChars', 'totalChars'] as const)
        check(Number.isInteger(settings[key]) && settings[key] >= 0, '延迟/额度不能为负');
    check(settings.batchSize <= 200 && [0,1].includes(settings.extra), '批量最多200；每链额外进展最多1');
    await (await activeLibrary()).transaction(['library_meta'], 'readwrite', tx => tx.put('library_meta', { id: 'daily-settings', schema: 1, value: JSON.parse(JSON.stringify(settings)) } as any));
}
export type Sender = (prompt: string) => Promise<string>;
export const sendDaily: Sender = async (prompt) => {
    const messages = [{ role: 'user' as const, content: prompt }];
    const channel = getChannelForTask('summary');
    return channel ? requestCompletion(channel, messages) : requestViaMainApi(messages);
};
export function stopDailyJob() { stop = true; jobState.stopped = true; jobState.status = '正在停止：等待当前请求返回，不再提交或发起下一批'; }
export async function runEvents(manual = true, sender: Sender = sendDaily) {
    if (jobState.busy || manualEventState.busy)
        return;
    jobState.busy = true;
    stop = false;
    jobState.stopped = false;
    jobState.completed = 0;
    try {
        const initial = await syncDaily();
        const lib = await activeLibrary();
        const branchId = initial.branch.id;
        const target = initial.cutoff;
        const host = hostVersion(), generation = dailyState.generation;
        const guard = () => !stop && host === hostVersion() && generation === dailyState.generation;
        const cards = (await eventView(lib, initial)).cards;
        const last = Math.max(0, ...cards.flatMap(c => c.progress.map(p => p.cutoff)));
        if (!manual && target - last < settings.interval) return;
        const pending = cards.filter(c => !c.blocked && (manual || !c.needsReview) && eventPending(c)).map(c => c.chain.id);
        for (const id of pending) {
            if (stop) break;
            check(guard(), '聊天改变，事件任务停止');
            const view = await capture(lib, branchId, target);
            jobState.status = `更新概要 ${jobState.completed + 1} / ${pending.length}`;
            const updated = await updateEventOverview(lib, view, id, settings.maxChars,
                messages => { jobState.chars = JSON.stringify(messages).length; return sender(messages.map(m => m.content).join('\n')); }, guard);
            if (updated) jobState.completed++;
        }
        if (!stop) jobState.status = `批量整理完成：更新 ${jobState.completed} 条事件链`;
        if (stop)
            jobState.status = '已停止；已保存概要保留，其余仍待更新';
    }
    catch (error) {
        jobState.status = String((error as Error).message);
    }
    finally {
        jobState.busy = false;
    }
}
export function bindDailyJobs() {
    void loadDailySettings().catch(error => { jobState.status = String(error); });
    watch(() => dailyState.revision, () => {
        if (settings.eventsEnabled && engineActiveHere() && !jobState.busy && !engineState.running)
            void runEvents(false);
    });
    const ctx = getContext();
    if (!ctx)
        return;
    const event = ctx.eventTypes.GENERATION_ENDED;
    if (event)
        ctx.eventSource.on(event, () => {
            // Disabled by default: enabling explicitly authorizes subsequent live model requests.
            if (settings.eventsEnabled && engineActiveHere() && !jobState.busy && !engineState.running)
                void runEvents(false);
        });
}
