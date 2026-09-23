import { reactive, watch } from 'vue';
import { requestCompletion, requestViaMainApi } from '@/api/client';
import { getChannelForTask, engineActiveHere } from '@/api/settings';
import { engineState } from '@/memory/engine';
import { getContext } from '@/st/context';
import { activeLibrary } from './db';
import { capture, current } from './canonical';
import { syncDaily, dailyState, hostVersion, dailyCurrent } from './bridge';
import { prepareEventBatch, parseEventOutput, commitEventBatch } from './events';
import { tablePrompt, parseTableOutput, applyRows } from './tables';
import { check, type TableDef } from './model';
export const settings = reactive({ eventsEnabled: false, interval: 40, delay: 0, batchSize: 20, maxChars: 48000,
    chains: 2, excerptChars: 500, totalChars: 1600, extra: 1 });
export const jobState = reactive({ busy: false, status: '未运行', chars: 0, completed: 0, stopped: false });
let stop = false;
export async function loadDailySettings() {
    const stored = await (await activeLibrary()).get<any>('library_meta', 'daily-settings');
    if (stored)
        Object.assign(settings, stored.value);
}
export async function saveDailySettings() {
    for (const key of ['interval', 'batchSize', 'maxChars'] as const)
        check(Number.isInteger(settings[key]) && settings[key] > 0, '间隔/批量/预算必须为正整数');
    for (const key of ['delay', 'chains', 'excerptChars', 'totalChars'] as const)
        check(Number.isInteger(settings[key]) && settings[key] >= 0, '延迟/额度不能为负');
    check(settings.batchSize <= 200 && settings.extra >= 0 && settings.extra <= 1, '批量最多200；每链额外进展最多1');
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
    if (jobState.busy)
        return;
    jobState.busy = true;
    stop = false;
    jobState.stopped = false;
    jobState.completed = 0;
    try {
        const initial = await syncDaily();
        const lib = await activeLibrary();
        const branchId = initial.branch.id;
        const target = Math.max(0, initial.cutoff - (manual ? 0 : settings.delay));
        const host = hostVersion();
        const generation = dailyState.generation;
        const receipts = await lib.all<any>('event_processing_receipts', 'branch', branchId);
        const last = Math.max(0, ...receipts.filter(r => r.result === 'success').map(r => r.cutoff));
        if (!manual && target - last < settings.interval)
            return;
        while (!stop) {
            check(host === hostVersion() && generation === dailyState.generation, '聊天改变，事件任务停止');
            const view = await capture(lib, branchId, target);
            // Fixed target for this action; subsequent batches see preceding committed directory.
            const batch = await prepareEventBatch(lib, view, settings.batchSize, settings.maxChars);
            if (!batch) {
                jobState.status = '该固定范围已整理完成';
                break;
            }
            jobState.chars = batch.chars;
            jobState.status = `整理 ${batch.memories.length} 条摘要 · 输入 ${batch.chars} 字符`;
            check(await dailyCurrent(batch.view,host,generation),'事件材料在发送前已改变');
            const raw = await sender(batch.prompt);
            if (stop)
                break;
            check(await dailyCurrent(batch.view, host, generation), '迟到事件结果已拒绝');
            const output = parseEventOutput(raw, batch);
            const receipt = await commitEventBatch(lib, batch, output, () => !stop && host === hostVersion() && generation === dailyState.generation);
            jobState.completed += batch.memories.length;
            if (receipt.result === 'needs_review') {
                jobState.status = '有待确认材料，已保留回执；请人工整理后再补齐';
                break;
            }
            if (!manual) {
                jobState.status = '本次自动批次已保存';
                break;
            }
        }
        if (stop)
            jobState.status = '已停止；已提交批次保留，重开可继续补齐';
    }
    catch (error) {
        jobState.status = String((error as Error).message);
    }
    finally {
        jobState.busy = false;
    }
}
export async function fillTable(def: TableDef, selected: string[], sender: Sender = sendDaily) {
    check(!jobState.busy, '另一个任务正在运行');
    jobState.busy = true;
    stop = false;
    try {
        const view = await syncDaily();
        const lib = await activeLibrary();
        const host = hostVersion(), generation = dailyState.generation;
        const prompt = await tablePrompt(lib, view, def, selected, settings.maxChars);
        jobState.chars = prompt.length;
        jobState.status = `填写 ${def.name} · ${prompt.length} 字符`;
        const result = await sender(prompt);
        check(!stop && await dailyCurrent(view, host, generation), '填表已停止或结果过期');
        await applyRows(lib, view, def, parseTableOutput(result), true, selected);
        jobState.status = '填表已保存（允许无变化）';
    }
    catch (error) {
        jobState.status = String((error as Error).message);
        throw error;
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
