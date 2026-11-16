import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { effectScope, nextTick, type EffectScope } from 'vue';

const io = vi.hoisted(() => ({
    scope: 'chat-a', host: 'host-a', activation: 1,
    branch: { id: 'branch-a', story: 'story', head: 'head', view: 'selection', epoch: 1 },
    cards: [] as any[], sender: vi.fn(), sync: vi.fn(), refresh: vi.fn(),
    handlers: new Map<string, (...args: unknown[]) => void>(),
    get: vi.fn(),
}));
vi.mock('@/api/settings', () => ({ getChannelForTask: () => null, engineActiveHere: () => true }));
vi.mock('@/api/client', () => ({ requestViaMainApi: io.sender, requestCompletion: io.sender }));
vi.mock('@/memory/engine', async () => {
    const { reactive } = await import('vue');
    return { engineState: reactive({ running: false }) };
});
vi.mock('@/st/context', () => ({ getContext: () => ({ eventTypes: { GENERATION_ENDED: 'ended' }, eventSource: {
    on: (event: string, fn: (...args: unknown[]) => void) => io.handlers.set(event, fn),
    off: (event: string, fn: (...args: unknown[]) => void) => { if (io.handlers.get(event) === fn) io.handlers.delete(event); },
} }) }));
vi.mock('./db', () => {
    const lib = { get: io.get };
    return { activeLibrary: async () => lib, libraryActivationGeneration: () => io.activation };
});
vi.mock('./bridge', async () => {
    const { reactive } = await import('vue');
    return { dailyState: reactive({ revision: 0, generation: 1, pending: false }),
        syncDaily: io.sync, refreshDailyTables: io.refresh, hostScope: () => io.scope, hostVersion: () => io.host };
});
vi.mock('./events', () => ({ eventView: async () => ({ cards: io.cards }) }));
vi.mock('./manual-events', async () => {
    const { reactive } = await import('vue');
    return { manualEventState: reactive({ busy: false }), eventPending: (card: any) => card.pending,
        eventCoverageUpgradeNeeded: () => false,
        updateEventOverview: async (_lib: unknown, _view: unknown, _id: string, _budget: number,
            send: (messages: any[]) => Promise<string>, guard: () => boolean) => {
            await send([{ role: 'user', content: 'synthetic pending event material' }]);
            if (!guard()) throw new Error('stale event result');
            return true;
        } };
});

import { bindDailyJobs, stopDailyJob, jobState, settings } from './jobs';
import { dailyState } from './bridge';
import { engineState } from '@/memory/engine';
import { manualEventState } from './manual-events';

let scope: EffectScope, dispose: (() => void) | undefined;
const flush = async () => { for (let i = 0; i < 30; i++) await nextTick(); };
beforeEach(async () => {
    vi.clearAllMocks(); io.handlers.clear();
    io.scope = 'chat-a'; io.host = 'host-a'; io.activation = 1;
    Object.assign(dailyState, { revision: 0, generation: 1, pending: false });
    Object.assign(jobState, { busy: false, stopped: false, completed: 0, status: '未运行' });
    engineState.running = false; manualEventState.busy = false;
    settings.eventsEnabled = true; settings.interval = 1;
    io.cards = [{ chain: { id: 'event-a' }, meta: { title: '合成事件' }, pending: true, progress: [] }];
    io.get.mockImplementation(async (store: string) => store === 'library_meta' ? { value: { eventsEnabled: true, interval: 1 } } : io.branch);
    io.sync.mockImplementation(async () => ({ branch: io.branch, cutoff: 100 }));
    io.sender.mockResolvedValue('synthetic response');
    io.refresh.mockImplementation(async (beforePublish?: (revision: number) => void) => {
        beforePublish?.(dailyState.revision + 1);
        dailyState.revision++;
    });
    scope = effectScope();
    dispose = scope.run(bindDailyJobs) as (() => void) | undefined;
    await flush();
});
afterEach(async () => {
    dispose?.(); scope.stop();
    await flush(); vi.restoreAllMocks();
});

test('summary completion queued while its engine is running resumes once idle without mounting a page', async () => {
    engineState.running = true;
    dailyState.revision++;
    io.handlers.get('ended')!();
    await flush();
    expect(io.sender).not.toHaveBeenCalled();
    engineState.running = false;
    await flush();
    expect(io.sender).toHaveBeenCalledTimes(1);
    expect(io.refresh).toHaveBeenCalledTimes(1);
    expect(jobState.busy).toBe(false);
    await flush();
    expect(io.sync).toHaveBeenCalledTimes(1);
});

test('manual event review defers automatic work until released and keeps review-blocked chains excluded', async () => {
    manualEventState.busy = true;
    io.cards.push({ chain: { id: 'needs-review' }, meta: { title: '待审核' }, pending: true, needsReview: true, progress: [] });
    dailyState.revision++;
    await flush();
    expect(io.sender).not.toHaveBeenCalled();
    manualEventState.busy = false;
    await flush();
    expect(io.sender).toHaveBeenCalledTimes(1);
    expect(io.sync).toHaveBeenCalledTimes(1);
});

test('notifications during an in-flight request coalesce into one follow-up and own publication does not loop', async () => {
    let finish!: () => void;
    io.sender.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return 'first response'; });
    dailyState.revision++;
    await flush();
    expect(io.sender).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) dailyState.revision++;
    await flush();
    expect(io.sender).toHaveBeenCalledTimes(1);
    finish(); await flush();
    expect(io.sender).toHaveBeenCalledTimes(2);
    expect(io.refresh).toHaveBeenCalledTimes(2);
    expect(io.sync).toHaveBeenCalledTimes(2);
});

test.each(['during-read', 'after-publication'] as const)('independent notifications %s are not lost inside an asynchronous projection refresh', async moment => {
    let finish!: () => void;
    io.refresh.mockImplementationOnce(async (beforePublish?: (revision: number) => void) => {
        await new Promise<void>(resolve => { finish = resolve; });
        beforePublish?.(dailyState.revision + 1);
        dailyState.revision++;
        if (moment === 'after-publication') for (let i = 0; i < 20; i++) dailyState.revision++;
    });
    dailyState.revision++;
    await flush();
    expect(io.sender).toHaveBeenCalledTimes(1);
    expect(io.refresh).toHaveBeenCalledTimes(1);
    if (moment === 'during-read') for (let i = 0; i < 20; i++) dailyState.revision++;
    await flush();
    expect(io.sender).toHaveBeenCalledTimes(1);
    finish(); await flush();
    expect(io.sender).toHaveBeenCalledTimes(2);
    expect(io.refresh).toHaveBeenCalledTimes(2);
    expect(io.sync).toHaveBeenCalledTimes(2);
    await flush();
    expect(io.sender).toHaveBeenCalledTimes(2);
});

test('committing multiple chains republishes once and does not require a page refresh', async () => {
    io.cards.push({ chain: { id: 'event-b' }, meta: { title: '另一事件' }, pending: true, progress: [] });
    dailyState.revision++;
    await flush();
    expect(io.sender).toHaveBeenCalledTimes(2);
    expect(io.refresh).toHaveBeenCalledTimes(1);
    expect(io.sync).toHaveBeenCalledTimes(1);
});

test('the initial archive publication is acknowledged by the same job instead of scheduling a duplicate', async () => {
    io.sync.mockImplementationOnce(async () => {
        dailyState.revision++;
        return { branch: io.branch, cutoff: 100 };
    });
    io.handlers.get('ended')!();
    await flush();
    expect(io.sender).toHaveBeenCalledTimes(1);
    expect(io.sync).toHaveBeenCalledTimes(1);
    expect(io.refresh).toHaveBeenCalledTimes(1);
});

test('a queued job cannot turn into a request for another chat while waiting for archive capture', async () => {
    let finish!: () => void;
    io.sync.mockImplementationOnce(async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        return { branch: io.branch, cutoff: 100 };
    });
    dailyState.revision++;
    await flush();
    io.scope = 'chat-b'; io.host = 'host-b'; dailyState.generation++;
    finish(); await flush();
    expect(io.sender).not.toHaveBeenCalled();
    expect(io.refresh).not.toHaveBeenCalled();
    expect(jobState.busy).toBe(false);
});

test('explicit stop cancels queued follow-up work and disposal removes its host listener', async () => {
    let finish!: () => void;
    io.sender.mockImplementationOnce(async () => {
        await new Promise<void>(resolve => { finish = resolve; }); return 'stopped response';
    });
    dailyState.revision++;
    await flush();
    dailyState.revision++;
    stopDailyJob(); finish(); await flush();
    expect(io.sender).toHaveBeenCalledTimes(1);
    expect(io.refresh).not.toHaveBeenCalled();
    expect(jobState.busy).toBe(false);
    dispose!();
    expect(io.handlers.has('ended')).toBe(false);
    dailyState.revision++;
    await flush();
    expect(io.sync).toHaveBeenCalledTimes(1);
});

test('disabling automation or switching chats drops queued old work instead of sending it on idle', async () => {
    engineState.running = true; dailyState.revision++;
    await flush();
    settings.eventsEnabled = false; engineState.running = false;
    await flush();
    expect(io.sender).not.toHaveBeenCalled();
    settings.eventsEnabled = true; engineState.running = true; dailyState.revision++;
    await flush();
    io.scope = 'chat-b'; io.host = 'host-b'; dailyState.generation++;
    engineState.running = false;
    await flush();
    expect(io.sender).not.toHaveBeenCalled();
    expect(io.sync).not.toHaveBeenCalled();
});
