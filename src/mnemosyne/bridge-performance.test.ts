import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Library, Transaction, activateLibrary, freshLibraryName } from './db';
import * as bridge from './bridge';
import * as canonical from './canonical';
import { saveMemberships } from './event-memberships';
import { editEvent, eventView, setEventArchived } from './events';
import { newTable, saveTable } from './tables';
import { fingerprint, type Branch, type MemoryRevision } from './model';
import { REPLY_FINALITY_KEY } from './reply-finality';
import { memory } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import type { STContext } from '@/st/context';

let lib: Library, ctx: STContext, dispose: (() => void) | undefined;
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    Object.assign(memory, createEmptyMemory());
    ctx = { chat: [], chatMetadata: {}, characters: [{ avatar: 'performance-fixture.png' }], characterId: 0,
        getCurrentChatId: () => 'performance-fixture', saveChat: vi.fn().mockResolvedValue(undefined),
        saveMetadata: vi.fn().mockResolvedValue(undefined), eventTypes: {},
        eventSource: { on: vi.fn(), off: vi.fn() }, setExtensionPrompt: vi.fn() } as unknown as STContext;
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
    lib = await Library.open(freshLibraryName()); await activateLibrary(lib);
});
afterEach(async () => {
    dispose?.(); await bridge.serializeDailyActivation(async () => {}); lib.close();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function setup(floors = 2) {
    for (let floor = 0; floor < floors; floor++) {
        const user = floor % 2 === 0, mes = `合成楼层${floor}:` + '甲'.repeat(2000);
        const extra: Record<string, any> = {};
        if (!user) {
            extra.bbs_leaf = { id: `leaf-${floor}`, text: `合成摘要${floor}`, delta: {}, createdAt: 1, v: 1, swipe: 0 };
            extra[REPLY_FINALITY_KEY] = { version: 1, epoch: 1, scope: bridge.hostScope(), floor, swipe: 0,
                hash: await fingerprint(mes), state: 'complete' };
        }
        ctx.chat.push({ name: user ? '用户' : '角色', is_user: user, is_system: false, mes, extra });
    }
    dispose = bridge.bindDaily();
    return bridge.syncDaily();
}

test('300-floor warm sync and unlink avoid body serialization/hashing, unrelated tables and event history', async () => {
    let view = await setup(300);
    const created = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '合成事件' });
    view = await bridge.syncDaily();
    const card = (await eventView(lib, view)).cards.find(card => card.chain.id === created.created)!;
    const stringify = vi.spyOn(JSON, 'stringify'), hashes = vi.spyOn(crypto.subtle, 'digest');
    const validity = vi.spyOn(canonical, 'statuses'), reads = vi.spyOn(Transaction.prototype, 'all');
    const tableRevision = bridge.dailyState.tableRevision;
    const wholeHosts = () => stringify.mock.calls.filter(([value]) => Array.isArray(value) && value.length === 4 &&
        typeof value[0] === 'string' && Array.isArray(value[1]) && Array.isArray(value[2]) && typeof value[3] === 'number');
    await bridge.syncDaily();
    expect(wholeHosts()).toHaveLength(0); expect(hashes).not.toHaveBeenCalled(); expect(validity).not.toHaveBeenCalled();
    reads.mockClear(); vi.mocked(ctx.saveChat).mockClear(); vi.mocked(ctx.saveMetadata).mockClear();
    await editEvent(lib, view, card.chain.id, card.meta, { memory: view.memories[0].id, active: false, kind: 'progress' });
    const refreshed = await bridge.syncDaily(), projected = bridge.syncedEventProjection(lib, refreshed)!;
    expect(projected.cards[0].members).toHaveLength(0);
    expect(await bridge.dailyCurrent(refreshed, bridge.hostVersion(), bridge.dailyState.generation)).toBe(true);
    bridge.summaryPermission(); bridge.persistentEventText(); bridge.dailyTableText();
    bridge.canonicalLeaves(); bridge.currentMembershipHints(); bridge.currentEventHints();
    expect(wholeHosts()).toHaveLength(0); expect(hashes).not.toHaveBeenCalled();
    expect(validity).toHaveBeenCalledTimes(1); // The edit's source check is reused by the refresh.
    expect(reads.mock.calls.filter(([store]) => ['event_revisions', 'event_memberships', 'event_progress', 'custom_table_defs'].includes(store))).toEqual([]);
    expect(bridge.dailyState.tableRevision).toBe(tableRevision);
    expect(ctx.saveChat).not.toHaveBeenCalled(); expect(ctx.saveMetadata).not.toHaveBeenCalled();
});

test('externally published projection and epoch-free archive flags survive cache reuse', async () => {
    let view = await setup();
    const created = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '归档测试' });
    await bridge.refreshDailyTables();
    const published = bridge.dailyState.revision;
    view = await bridge.syncDaily();
    expect(bridge.dailyState.revision).toBe(published);
    expect(bridge.syncedEventProjection(lib, view)?.cards[0].chain.id).toBe(created.created);
    const other = await Library.open(lib.db.name);
    try { await setEventArchived(other, view, created.created!, true); }
    finally { other.close(); }
    const refreshed = await bridge.syncDaily();
    expect(refreshed.branch.epoch).toBe(view.branch.epoch);
    expect(bridge.syncedEventProjection(lib, refreshed)?.cards[0].chain.archived).toBe(true);
    expect(bridge.dailyState.revision).toBe(published + 1);
    await bridge.syncDaily(); expect(bridge.dailyState.revision).toBe(published + 1);
});

test('source-neutral table writes reuse validity while reviews and foreign epochs force revalidation', async () => {
    let view = await setup();
    const status = vi.spyOn(canonical, 'statuses');
    const table = newTable(view, '合成表');
    table.columns = [{ id: 'name', name: '名称', type: 'text', mode: 'lock', description: '' }];
    await saveTable(lib, view, table); await bridge.refreshDailyTables();
    expect(status).not.toHaveBeenCalled();
    view = await bridge.syncDaily();
    await canonical.keepSummary(lib, view, view.memories[0].id); status.mockClear();
    view = await bridge.syncDaily(); expect(status).toHaveBeenCalledTimes(1);
    const other = await Library.open(lib.db.name);
    try { await saveMemberships(other, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '另一连接' }); }
    finally { other.close(); }
    status.mockClear();
    const refreshed = await bridge.syncDaily();
    expect(status).toHaveBeenCalledTimes(1);
    expect(bridge.syncedEventProjection(lib, refreshed)?.cards[0].meta.title).toBe('另一连接');
});

test('same-length host edits immediately revoke cached projections without an event notification', async () => {
    await setup();
    expect(bridge.canonicalLeaves()).toHaveLength(1);
    const before = bridge.hostVersion();
    ctx.chat[1].mes = ctx.chat[1].mes.replace('甲', '乙');
    expect(bridge.hostVersion()).not.toBe(before);
    expect(bridge.canonicalLeaves()).toEqual([]);
    await expect(bridge.syncDaily()).rejects.toThrow(); // Its completed-reply receipt is now stale.
});

test('library activation immediately revokes cached getters even before the next host notification', async () => {
    const view = await setup(), other = await Library.open(freshLibraryName());
    expect(bridge.canonicalLeaves()).toHaveLength(1);
    try {
        await activateLibrary(other);
        expect(bridge.canonicalLeaves()).toEqual([]);
        expect(bridge.syncedEventProjection(other, view)).toBeNull();
        await expect(bridge.readDailyMembershipContext()).rejects.toThrow('档案尚未同步');
    } finally { other.close(); }
});

test('one appended user floor hashes only that body through the complete warm bridge', async () => {
    const before = await setup(100);
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const capture = vi.spyOn(canonical, 'capture');
    ctx.chat.push({ name: '用户', is_user: true, is_system: false, mes: '本轮新问题', extra: {} });
    const after = await bridge.syncDaily();
    expect(digest).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled(); // The committed transaction already checked the body payloads.
    expect(after.refs.slice(0, before.refs.length)).toEqual(before.refs);
    expect(after.sources.get(after.refs.at(-1)!.revision)?.content).toBe('本轮新问题');
    expect(after.memories.map(memory => memory.id)).toEqual(before.memories.map(memory => memory.id));
});

test('a foreign branch advance during metadata save forces a fresh captured view', async () => {
    const before = await setup();
    const other = await Library.open(lib.db.name);
    let epoch = 0;
    try {
        vi.mocked(ctx.saveMetadata).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
            await other.transaction(['branches'], 'readwrite', async tx => {
                const branch = (await tx.get<Branch>('branches', before.branch.id))!;
                epoch = branch.epoch + 1;
                await tx.put('branches', { ...branch, epoch } as Branch);
            });
        });
        const capture = vi.spyOn(canonical, 'capture');
        ctx.chat.push({ name: '用户', is_user: true, is_system: false, mes: '合成追加', extra: {} });
        const after = await bridge.syncDaily();
        expect(capture).toHaveBeenCalledTimes(1);
        expect(after.branch.epoch).toBe(epoch);
    } finally { other.close(); }
});

test('selected recovery metadata written during host save is reread even without a foreign epoch change', async () => {
    const before = await setup(), memoryId = before.memories[0].id;
    const other = await Library.open(lib.db.name);
    try {
        vi.mocked(ctx.saveMetadata).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
            await other.transaction(['memory_revisions'], 'readwrite', async tx => {
                const memory = (await tx.get<MemoryRevision>('memory_revisions', memoryId))!;
                await tx.put('memory_revisions', { ...memory,
                    sourceRecovery: { version: 1, reason: 'missing_basis', snapshot: before.snapshot.id },
                } as MemoryRevision);
            });
        });
        ctx.chat.push({ name: '用户', is_user: true, is_system: false, mes: '合成追加', extra: {} });
        const after = await bridge.syncDaily();
        expect(after.memories[0].sourceRecovery?.reason).toBe('missing_basis');
        expect(bridge.canonicalLeaves()).toHaveLength(0);
        expect(bridge.dailyState.review).toBe(1);
    } finally { other.close(); }
});
