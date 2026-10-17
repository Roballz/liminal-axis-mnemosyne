import { reactive } from 'vue';
import { check } from './model';
import type { Library } from './db';

export type EventMaterialMode = 'summary' | 'body' | 'both';
export const EVENT_MATERIAL_MODES: EventMaterialMode[] = ['summary', 'body', 'both'];
export const DEFAULT_EVENT_OVERVIEW_MAX_CHARS = 1000;
export const DEFAULT_EVENT_BATCH_TOKENS = 80000;
export const dailySettingsDefaults = { eventsEnabled: false, interval: 40, delay: 0, batchSize: 20, backfillBatchSize: 20, maxChars: 48000,
    overviewMaterialMode: 'both' as EventMaterialMode,
    overviewMaxChars: DEFAULT_EVENT_OVERVIEW_MAX_CHARS, overviewBatchTokens: DEFAULT_EVENT_BATCH_TOKENS,
    chains: 2, excerptChars: 500, totalChars: 1600, extra: 1 };
export const settings = reactive({ ...dailySettingsDefaults });

/** Read before activation: a failed settings read must not publish a half-restored library. */
export async function readDailySettings(lib: Library): Promise<typeof dailySettingsDefaults> {
    const stored = await lib.get<any>('library_meta', 'daily-settings');
    const next = { ...dailySettingsDefaults, ...stored?.value };
    if (!EVENT_MATERIAL_MODES.includes(next.overviewMaterialMode)) next.overviewMaterialMode = 'both';
    // Old libraries gain only the new options; no overview text or coverage is rewritten.
    for (const key of ['overviewMaxChars', 'overviewBatchTokens'] as const) {
        const max = key === 'overviewMaxChars' ? 20000 : 1000000;
        const min = key === 'overviewMaxChars' ? 1 : 1000;
        if (!Number.isSafeInteger(next[key]) || next[key] < min || next[key] > max) next[key] = dailySettingsDefaults[key];
    }
    return next;
}
export function eventOverviewMaxChars() {
    check(Number.isSafeInteger(settings.overviewMaxChars) && settings.overviewMaxChars >= 1 && settings.overviewMaxChars <= 20000,
        '事件概要上限必须为1至20000的整数字数');
    return settings.overviewMaxChars;
}
export function eventBatchTokens() {
    check(Number.isSafeInteger(settings.overviewBatchTokens) && settings.overviewBatchTokens >= 1000 && settings.overviewBatchTokens <= 1000000,
        '事件每批估算输入预算必须为1000至1000000的整数 token');
    return settings.overviewBatchTokens;
}

export function eventMaterialMode(): EventMaterialMode {
    check(EVENT_MATERIAL_MODES.includes(settings.overviewMaterialMode), '事件概要材料必须选择摘要、正文或摘要+正文');
    return settings.overviewMaterialMode;
}
