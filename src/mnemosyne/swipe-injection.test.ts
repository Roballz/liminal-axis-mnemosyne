import 'fake-indexeddb/auto';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import { prepareGeneration } from '@/memory/generation';
import { currentVectorDb, recallScopes } from '@/memory/vector/scope';
import { recallDebug } from '@/memory/vector/debug';
import * as bridge from './bridge';
import { buildHistoryInjectionText } from '@/memory/inject';
import { memory } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import type { STContext, STMessage } from '@/st/context';
import { Library, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, dailyState, canonicalLeaves, preparePromptHistory, summaryAllowed, invalidateDaily } from './bridge';
import { capture, statuses, confirmRecoveredSummaries } from './canonical';
import * as canonical from './canonical';
import { exportLibrary } from './migration';
import { row, type MemoryRevision, type Review, type Branch } from './model';
import { REPLY_FINALITY_KEY } from './reply-finality';

let lib: Library, ctx: STContext, dispose: (() => void) | undefined;
let emit: (key: string, ...args: any[]) => Promise<void>;
const settings = JSON.parse(JSON.stringify(apiSettings));
const message = (user: boolean, text: string): STMessage => ({ name: user ? 'User' : 'Character', is_user: user, is_system: false, mes: text, extra: {} });
const leaf = (id: string, text: string) => ({ id, text, delta: {}, createdAt: 1, v: 1 as const, swipe: 0 });
const injected = () => vi.mocked(ctx.setExtensionPrompt!).mock.calls.filter(c => c[0] === 'mnemosyne_memory_history').at(-1)?.[1] ?? '';
beforeEach(async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
    // Any accidental network operation is a test failure; no paid model/server is used.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(memory, createEmptyMemory());
    apiSettings.enabled = true; apiSettings.autoSummaryEnabled = false; apiSettings.vector.enabled = false;
    apiSettings.vector.knowledge.enabled = false; apiSettings.vector.recall.minAiFloors = 100;
    ctx = { chat: [message(true, '合成问题'), message(false, '合成答复'), message(true, '下一问'), message(false, '上一版末楼正文')],
        chatMetadata: {}, characters: [{ name: '合成角色', avatar: 'synthetic.png' }], characterId: 0,
        getCurrentChatId: () => 'synthetic', saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined),
        setExtensionPrompt: vi.fn() } as unknown as STContext;
    ctx.chat[1].extra!.bbs_leaf = leaf('history', '未受影响的历史摘要');
    ctx.chat[1].is_system = true; ctx.chat[1].extra!.bbs_hidden = true;
    ctx.chat[3].swipe_id = 0; ctx.chat[3].swipes = [ctx.chat[3].mes];
    const handlers = new Map<string, ((...args: any[]) => unknown)[]>();
    const keys = ['GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHARACTER_MESSAGE_RENDERED', 'STREAM_TOKEN_RECEIVED',
        'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_SENT', 'CHAT_CHANGED'];
    ctx.eventTypes = Object.fromEntries(keys.map(key => [key, key])) as any;
    ctx.eventSource = { on: (key, fn) => handlers.set(key, [...(handlers.get(key) ?? []), fn]), off: () => {} };
    emit = async (key, ...args) => { for (const callback of handlers.get(key) ?? []) await callback(...args); };
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
    lib = await Library.open(freshLibraryName()); await activateLibrary(lib); dispose = bindDaily();
});
afterEach(() => { dispose?.(); lib.close(); Object.assign(apiSettings, JSON.parse(JSON.stringify(settings))); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function start(type = 'swipe') {
    // TT 007abf7: swipe slot advances before MESSAGE_SWIPED, then GENERATION_STARTED.
    if (type === 'swipe') { ctx.chat[3].swipe_id = 1; await emit('MESSAGE_SWIPED', 3); }
    if (type === 'regenerate') ctx.chat.pop();
    await emit('GENERATION_STARTED', type);
}

test.each([false, true])('real generation/bridge/recall: vector=%s normal, swipe and regenerate retain history', async enabled => {
    apiSettings.vector.enabled = enabled;
    await syncDaily(); expect(buildHistoryInjectionText()).toContain('未受影响的历史摘要');
    expect(currentVectorDb()).toMatch(/^mnemosyne_vec_/); expect(recallScopes()).toEqual(['chat:synthetic']);
    const sync = vi.spyOn(bridge, 'syncDaily');
    for (const type of ['normal', 'swipe', 'regenerate']) {
        await start(type); const abort = vi.fn(); sync.mockClear();
        await prepareGeneration(abort, type);
        expect(injected()).toContain('未受影响的历史摘要'); expect(abort).not.toHaveBeenCalled();
        expect(sync).toHaveBeenCalledTimes(enabled ? 2 : 1); // Real active recall performs its second full sync.
        if (enabled) expect(recallDebug.status).toContain('未召回:没有可召回的旧摘要或启用的知识库');
    }
    expect(fetch).not.toHaveBeenCalled();
});

test('swipe prefix is read-only, leaves full archive pending, and never grants full canonical access', async () => {
    const view = await syncDaily(), before = (await exportLibrary(lib)).data;
    await start(); vi.mocked(ctx.saveChat).mockClear(); vi.mocked(ctx.saveMetadata).mockClear();
    const tx = vi.spyOn(lib, 'transaction');
    await prepareGeneration(vi.fn(), 'swipe');
    expect(injected()).toContain('未受影响的历史摘要');
    expect(tx.mock.calls.every(([, mode]) => mode === 'readonly')).toBe(true);
    expect(ctx.saveChat).not.toHaveBeenCalled(); expect(ctx.saveMetadata).not.toHaveBeenCalled();
    expect(dailyState.pending).toBe(true); expect(canonicalLeaves()).toEqual([]);
    await expect(syncDaily()).rejects.toThrow('暂不归档');
    expect((await capture(lib, view.branch.id)).refs).toEqual(view.refs);
    expect((await exportLibrary(lib)).data).toEqual(before);
});

test('tail summary and its compressed ancestor are excluded; independent historical child survives', async () => {
    ctx.chat[3].extra!.bbs_leaf = leaf('tail', '末楼旧页摘要');
    memory.summaries.push({ id: 'parent', text: '包含旧末楼的压缩摘要', level: 1, auto: true, childIds: ['history', 'tail'], createdAt: 1 });
    await syncDaily(); await start(); await prepareGeneration(vi.fn(), 'swipe');
    expect(injected()).toContain('未受影响的历史摘要');
    expect(injected()).not.toContain('包含旧末楼'); expect(injected()).not.toContain('末楼旧页摘要');
    expect(summaryAllowed('tail')).toBe(false); expect(summaryAllowed('parent')).toBe(false);
});

test.each([false, true])('manually confirmed L0 (recovered=%s) remains usable with its complete basis before the swipe', async recovered => {
    await syncDaily(); ctx.chat[0].mes = '人工确认过的新问题'; invalidateDaily();
    let changed = await syncDaily(); const id = changed.memories[0].id;
    if (recovered) {
        await lib.transaction(['memory_revisions'], 'readwrite', tx => tx.put('memory_revisions', { ...changed.memories[0], sourceRecovery: { version: 1, reason: 'missing_basis', snapshot: 'missing' } } as MemoryRevision));
        changed = await capture(lib, changed.branch.id);
    }
    expect((await statuses(lib, changed)).get(id)).toBe('needs_review');
    await confirmRecoveredSummaries(lib, changed, [id]); await syncDaily();
    await start(); await prepareGeneration(vi.fn(), 'swipe');
    expect(injected()).toContain('未受影响的历史摘要');
});

test('legacy full-snapshot review cannot authorize a prefix summary depending on the excluded tail', async () => {
    const view = await syncDaily(), original = view.memories[0];
    const changed: MemoryRevision = { ...original, inputRefs: [view.refs[3]], coverage: [] };
    await lib.transaction(['memory_revisions', 'reviews'], 'readwrite', async tx => {
        await tx.put('memory_revisions', changed);
        await tx.add('reviews', { ...row('review'), branch: view.branch.id, story: view.branch.story,
            owner: changed.id, snapshot: view.snapshot.id, decision: 'compatible', origin: 'manual', created: Date.now() } as Review);
    });
    expect((await statuses(lib, await capture(lib, view.branch.id))).get(changed.id)).toBe('valid');
    expect((await statuses(lib, await capture(lib, view.branch.id, 3))).get(changed.id)).toBe('needs_review');
    await start(); await prepareGeneration(vi.fn(), 'swipe');
    expect(injected()).toBe(''); expect(summaryAllowed('history')).toBe(false);
});

test.each(['edit-prefix', 'summary-payload', 'pending-prefix', 'stream-tail', 'stopped', 'ended'] as const)('%s cannot borrow the old history projection', async change => {
    await syncDaily(); await start();
    if (change === 'edit-prefix') ctx.chat[0].mes += ' changed';
    if (change === 'summary-payload') ctx.chat[1].extra!.bbs_leaf!.text += ' changed';
    if (change === 'pending-prefix') ctx.chat[1].extra![REPLY_FINALITY_KEY] = { state: 'pending' };
    if (change === 'stream-tail') { ctx.chat[3].mes = '新流式片段'; ctx.streamingProcessor = { messageId: 3, isFinished: false }; }
    if (change === 'stopped') await emit('GENERATION_STOPPED');
    if (change === 'ended') await emit('GENERATION_ENDED');
    await prepareGeneration(vi.fn(), 'swipe'); expect(injected()).toBe(''); expect(summaryAllowed('history')).toBe(false);
});

test.each(['scope', 'chat-array', 'branch-epoch', 'database'] as const)('a %s change during the readonly prefix read never publishes old history', async change => {
    await syncDaily(); await start();
    const originalCapture = canonical.capture;
    vi.spyOn(canonical, 'capture').mockImplementationOnce(async (...args) => {
        const view = await originalCapture(...args);
        if (change === 'scope') ctx.getCurrentChatId = () => 'other-chat';
        if (change === 'chat-array') ctx.chat = [...ctx.chat];
        if (change === 'branch-epoch') await lib.transaction(['branches'], 'readwrite', tx => tx.put('branches', { ...view.branch, epoch: view.branch.epoch + 1 } as Branch));
        if (change === 'database') { const next = await Library.open(freshLibraryName()); await activateLibrary(next); lib = next; }
        return view;
    });
    const abort = vi.fn(); await prepareGeneration(abort, 'swipe');
    expect(injected()).toBe(''); expect(summaryAllowed('history')).toBe(false);
    if (change === 'scope' || change === 'chat-array') expect(abort).toHaveBeenCalledWith(true);
});

test.each(['token', 'chat', 'database'] as const)('history permission expires immediately after %s changes', async change => {
    await syncDaily(); await start(); await prepareGeneration(vi.fn(), 'swipe');
    expect(summaryAllowed('history')).toBe(true);
    if (change === 'token') { ctx.streamingProcessor = { messageId: 3, isFinished: false }; await emit('STREAM_TOKEN_RECEIVED'); }
    if (change === 'chat') { ctx.getCurrentChatId = () => 'other-chat'; await emit('CHAT_CHANGED'); }
    if (change === 'database') { const next = await Library.open(freshLibraryName()); await activateLibrary(next); lib = next; }
    expect(summaryAllowed('history')).toBe(false);
    expect(await preparePromptHistory('swipe')).toBe(false);
});

test('canceling a new swipe and returning to the saved page restores normal archival behavior', async () => {
    await syncDaily(); const oldExtra = structuredClone(ctx.chat[3].extra);
    await start(); await prepareGeneration(vi.fn(), 'swipe');
    expect(injected()).toContain('未受影响的历史摘要');
    await emit('GENERATION_STOPPED');
    ctx.chat[3].swipe_id = 0; ctx.chat[3].extra = oldExtra;
    await emit('MESSAGE_SWIPED', 3); await syncDaily();
    expect(dailyState.pending).toBe(false); expect(canonicalLeaves()).toHaveLength(1);
    expect(buildHistoryInjectionText()).toContain('未受影响的历史摘要');
});

test.each(['run', 'head', 'view', 'binding-scope', 'prefix-leaf'] as const)('a %s change during validity checks prevents publishing the prefix', async change => {
    await syncDaily(); await start();
    const originalStatuses = canonical.statuses;
    vi.spyOn(canonical, 'statuses').mockImplementationOnce(async (...args) => {
        const result = await originalStatuses(...args), view = args[1];
        if (change === 'run') await emit('GENERATION_STARTED', 'swipe');
        if (change === 'head' || change === 'view') await lib.transaction(['branches'], 'readwrite', tx =>
            tx.put('branches', { ...view.branch, [change]: 'different-version' } as Branch));
        if (change === 'binding-scope') (ctx.chatMetadata.mnemosyne_binding_v1 as any).scope = 'other-scope';
        if (change === 'prefix-leaf') ctx.chat[1].extra!.bbs_leaf!.text = 'changed while checking';
        return result;
    });
    await prepareGeneration(vi.fn(), 'swipe');
    expect(injected()).toBe(''); expect(summaryAllowed('history')).toBe(false);
});
