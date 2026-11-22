import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from '@/api/settings';
import * as client from '@/api/client';
import * as canonical from './canonical';
import * as bridge from './bridge';
import { Library, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, invalidateDaily } from './bridge';
import { createEmptyMemory } from '@/memory/types';
import { memory } from '@/memory/store';
import { editLeafAt, editSummary } from '@/memory/apply';
import { type STContext, type STMessage } from '@/st/context';
import { summaryEditPrompt, prepareSummaryEditPrompt, prepareHigherSummaryReview, resolveSummaryEdit, deferSummaryEdit } from './summary-edit-prompt';
import { editedSummary } from './summary-edit-signal';
import { coreBackupState } from './core-backup-runtime';

let lib: Library, ctx: STContext, dispose: (() => void) | undefined;
const message = (user: boolean, text: string): STMessage =>
    ({ name: user ? 'User' : 'Character', is_user: user, is_system: false, mes: text, extra: {} });
beforeEach(async () => {
    coreBackupState.enabled = false; coreBackupState.available = false;
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    Object.assign(memory, createEmptyMemory());
    ctx = { chat: [message(true, '输入甲'), message(false, '回复甲'), message(true, '输入乙'), message(false, '回复乙')],
        chatMetadata: {}, characters: [{ name: '合成角色', avatar: 'synthetic.png' }], characterId: 0,
        getCurrentChatId: () => 'revision-wizard', saveChat: vi.fn().mockResolvedValue(undefined),
        saveMetadata: vi.fn().mockResolvedValue(undefined), eventTypes: {},
        eventSource: { on: vi.fn(), off: vi.fn() }, setExtensionPrompt: vi.fn() } as unknown as STContext;
    ctx.chat[1].extra!.bbs_leaf = { id: 'leaf', text: '本条摘要', delta: {}, createdAt: 1, v: 1, swipe: 0 };
    ctx.chat[3].extra!.bbs_leaf = { id: 'other', text: '无关摘要', delta: {}, createdAt: 2, v: 1, swipe: 0 };
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
    vi.spyOn(api, 'engineActiveHere').mockReturnValue(true);
    api.apiSettings.summaryEditPromptEnabled = true;
    memory.summaries.push(
        { id: 'l1', level: 1, childIds: ['leaf'], text: '原 L1', createdAt: 3, auto: true },
        { id: 'l2', level: 2, childIds: ['l1'], text: '原 L2', createdAt: 4, auto: true });
    lib = await Library.open(freshLibraryName()); await activateLibrary(lib); dispose = bindDaily();
    await syncDaily();
});
afterEach(() => {
    deferSummaryEdit(); api.apiSettings.summaryEditPromptEnabled = false;
    dispose?.(); lib.close(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function openParents() {
    expect(editLeafAt(1, '已修改摘要', '', '')).toBe(true);
    await prepareSummaryEditPrompt(1, false, undefined, false, { hostId: 'leaf', level: 0 });
    expect(summaryEditPrompt.draft).toMatchObject({ hostId: 'l1', level: 1 });
}

test('editing L2 without L3 never selects an unrelated pending L0', async () => {
    ctx.chat[3].mes += '正文变化'; invalidateDaily();
    const sync = canonical.synchronize;
    const seed = vi.spyOn(canonical, 'synchronize').mockImplementationOnce((library, input, baseline, before) =>
        sync(library, input, baseline && { ...baseline, retireHistory: false }, before));
    await syncDaily(); seed.mockRestore();
    expect(editSummary('l2', '已保存的 L2')).toBe(true);
    expect(editedSummary).toEqual({ hostId: 'l2', level: 2 });
    const writes = vi.spyOn(canonical, 'keepSummaries');
    await prepareSummaryEditPrompt(undefined, false, undefined, false, editedSummary);
    expect(summaryEditPrompt.open).toBe(false); expect(summaryEditPrompt.draft).toBeNull();
    const current = await syncDaily(), other = current.memories.find(item => item.hostId === 'other')!;
    expect((await canonical.statuses(lib, current)).get(other.id)).toBe('needs_review');
    await prepareSummaryEditPrompt();
    expect(summaryEditPrompt.open).toBe(false); expect(writes).not.toHaveBeenCalled();
});

test('saving one ancestor leaves the next pending and later closes without approving it', async () => {
    await openParents();
    expect(summaryEditPrompt).toMatchObject({ step: 1, total: 2, hasNext: true });
    const writes = vi.spyOn(canonical, 'keepSummaries');
    await resolveSummaryEdit('keep');
    expect(summaryEditPrompt.error).toBe('');
    expect(summaryEditPrompt.draft?.hostId).toBe('l2');
    expect(summaryEditPrompt).toMatchObject({ step: 2, total: 2, hasNext: false });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][2]).toHaveLength(1);
    const next = await syncDaily(), states = await canonical.statuses(lib, next);
    expect(states.get(next.memories.find(item => item.hostId === 'l1')!.id)).toBe('valid');
    expect(states.get(next.memories.find(item => item.hostId === 'l2')!.id)).toBe('needs_rebuild');
    await resolveSummaryEdit('later');
    expect(summaryEditPrompt.open).toBe(false); expect(writes).toHaveBeenCalledTimes(1);
    const resumed = await syncDaily();
    expect((await canonical.statuses(lib, resumed)).get(resumed.memories.find(item => item.hostId === 'l2')!.id)).toBe('needs_rebuild');
});

test('higher AI output stays editable and writes only after confirmation, then advances once', async () => {
    vi.spyOn(api, 'getChannelForTask').mockReturnValue(null);
    vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
    const request = vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ summary: 'AI L1 草稿' }));
    await openParents();
    const before = await syncDaily();
    await resolveSummaryEdit('update');
    expect(summaryEditPrompt.error).toBe('');
    expect(summaryEditPrompt.draft).toMatchObject({ hostId: 'l1', text: 'AI L1 草稿' });
    expect(memory.summaries.find(item => item.id === 'l1')!.text).toBe('原 L1');
    expect((await syncDaily()).selection.id).toBe(before.selection.id);
    expect(request).toHaveBeenCalledTimes(1);
    summaryEditPrompt.draft!.text = '人工核对后的 L1';
    await resolveSummaryEdit('keep');
    expect(summaryEditPrompt.error).toBe('');
    expect(summaryEditPrompt.draft?.hostId).toBe('l2');
    expect(memory.summaries.find(item => item.id === 'l1')!.text).toBe('人工核对后的 L1');
    summaryEditPrompt.draft!.text = '人工核对后的 L2';
    await resolveSummaryEdit('keep');
    expect(summaryEditPrompt.error).toBe(''); expect(summaryEditPrompt.open).toBe(false);
    const after = await syncDaily();
    expect(new Set((await canonical.statuses(lib, after)).values())).toEqual(new Set(['valid']));
});

test('a changed chat cannot receive an outstanding higher AI draft or confirm the old step', async () => {
    vi.spyOn(api, 'getChannelForTask').mockReturnValue(null);
    vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
    vi.spyOn(client, 'requestViaMainApi').mockImplementationOnce(async () => {
        ctx.getCurrentChatId = () => 'different-chat'; invalidateDaily();
        return JSON.stringify({ summary: '迟到的返回' });
    });
    await openParents();
    await resolveSummaryEdit('update');
    expect(summaryEditPrompt.error).toContain('改变');
    expect(memory.summaries.find(item => item.id === 'l1')!.text).toBe('原 L1');
    expect(summaryEditPrompt.draft?.text).toBe('原 L1');
    const writes = vi.spyOn(canonical, 'keepSummaries');
    await resolveSummaryEdit('keep');
    expect(writes).not.toHaveBeenCalled();
});

test('deferring an AI draft preserves the saved text and its pending state', async () => {
    vi.spyOn(api, 'getChannelForTask').mockReturnValue(null);
    vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({ summary: '尚未确认的草稿' }));
    await openParents();
    const before = await syncDaily();
    await resolveSummaryEdit('update'); await resolveSummaryEdit('later');
    expect(summaryEditPrompt.open).toBe(false);
    expect(memory.summaries.find(item => item.id === 'l1')!.text).toBe('原 L1');
    const after = await syncDaily();
    expect(after.selection.id).toBe(before.selection.id);
    expect((await canonical.statuses(lib, after)).get(after.memories.find(item => item.hostId === 'l1')!.id)).toBe('needs_rebuild');
});

test('retrying a projection-read failure does not confirm the same step twice', async () => {
    await openParents();
    const writes = vi.spyOn(canonical, 'keepSummaries');
    vi.spyOn(bridge, 'syncedEditReview').mockImplementationOnce(async () => { throw new Error('模拟读取失败'); });
    await resolveSummaryEdit('keep');
    expect(summaryEditPrompt.error).toBe('模拟读取失败');
    expect(summaryEditPrompt.draft?.hostId).toBe('l1');
    expect(writes).toHaveBeenCalledTimes(1);
    await resolveSummaryEdit('keep');
    expect(summaryEditPrompt.error).toBe('');
    expect(summaryEditPrompt.draft?.hostId).toBe('l2');
    expect(writes).toHaveBeenCalledTimes(1);
});

test('explicit pending review works with automatic popups disabled and starts at the named item', async () => {
    await openParents(); await resolveSummaryEdit('later');
    api.apiSettings.summaryEditPromptEnabled = false;
    await prepareHigherSummaryReview('l1');
    expect(summaryEditPrompt.draft).toMatchObject({ hostId: 'l1', level: 1 });
    expect(api.apiSettings.summaryEditPromptEnabled).toBe(false);
    await resolveSummaryEdit('keep');
    expect(summaryEditPrompt.error).toBe('');
    expect(summaryEditPrompt.draft?.hostId).toBe('l2');
    await resolveSummaryEdit('keep');
    expect(summaryEditPrompt.open).toBe(false);
    expect(api.apiSettings.summaryEditPromptEnabled).toBe(false);
});
