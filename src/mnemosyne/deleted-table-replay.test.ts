import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Library, Transaction, activateLibrary, freshLibraryName } from './db';
import * as bridge from './bridge';
import * as canonical from './canonical';
import { newTable, saveTable, readTables, parseSummaryTables, applyRows } from './tables';
import { TABLE_STORES, recordTableWrite } from './table-history';
import { attachTableResult, TABLE_OUTPUT_KEY } from './summary-tables';
import type { Branch, CapturedView, TableDef } from './model';
import { memory } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import type { STContext, STMessage } from '@/st/context';

let lib: Library, ctx: STContext, dispose: (() => void) | undefined;
const message = (user: boolean, text: string): STMessage => ({ name: user ? 'User' : 'Character',
    is_user: user, is_system: false, mes: text, extra: {} });
beforeEach(async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    Object.assign(memory, createEmptyMemory());
    ctx = { chat: [message(true, '合成问题'), message(false, '合成回答')], chatMetadata: {},
        characters: [{ avatar: 'deleted-table-fixture.png' }], characterId: 0, getCurrentChatId: () => 'deleted-table',
        saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined),
        eventTypes: {}, eventSource: { on: vi.fn(), off: vi.fn() }, setExtensionPrompt: vi.fn() } as unknown as STContext;
    ctx.chat[1].extra!.bbs_leaf = { id: 'leaf-1', text: '合成摘要', delta: {}, createdAt: 1, v: 1, swipe: 0 };
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
    lib = await Library.open(freshLibraryName()); await activateLibrary(lib); dispose = bridge.bindDaily();
});
afterEach(() => { dispose?.(); lib.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function table(view: CapturedView, name: string) {
    const def = newTable(view, name);
    def.columns = [{ id: 'key', name: 'key', type: 'text', mode: 'replace', description: '' }];
    await saveTable(lib, view, def);
    return { def: (await lib.get<TableDef>('custom_table_defs', def.id))!, view: await canonical.capture(lib, view.branch.id) };
}
async function pending(view: CapturedView, floor = 1) {
    const inputs = await readTables(lib, view.branch);
    const plan = parseSummaryTables(inputs.map(({ def }) => ({ table_id: def.id,
        add: [{ key: `计划-${floor}` }], update: [] })), inputs, view.branch.id)!;
    plan.tableHead = view.branch.tableHead;
    attachTableResult(ctx.chat, floor, plan);
    return plan;
}
async function contents() {
    return Promise.all(['custom_table_defs', 'custom_table_rows', 'table_receipts', 'table_history'].map(store => lib.all(store as any)));
}
async function reopen() {
    const name = lib.db.name; dispose?.(); lib.close();
    lib = await Library.open(name); await activateLibrary(lib); dispose = bridge.bindDaily();
    vi.mocked(ctx.saveChat).mockClear(); vi.mocked(ctx.saveMetadata).mockClear();
}

test('deleted table sidecars stay retired on cold reopen without host writes or per-floor definition reads', async () => {
    for (let floor = 3; floor < 12; floor += 2) {
        ctx.chat.push(message(true, `合成问题-${floor}`), message(false, `合成回答-${floor}`));
        ctx.chat[floor].extra!.bbs_leaf = { id: `leaf-${floor}`, text: `合成摘要-${floor}`, delta: {}, createdAt: 1, v: 1, swipe: 0 };
    }
    let view = await bridge.syncDaily();
    const saved = await table(view, '已删除表'); view = saved.view;
    for (let floor = 1; floor < ctx.chat.length; floor += 2) {
        await pending(view, floor); view = await bridge.syncDaily();
    }
    expect(await lib.all('table_receipts')).toHaveLength(6);
    const latest = (await lib.get<TableDef>('custom_table_defs', saved.def.id))!;
    await saveTable(lib, view, { ...latest, deleted: true });
    const before = await contents(), host = JSON.stringify(ctx.chat);
    expect(before.slice(0, 3)).toEqual([[], [], []]);
    await reopen();
    const writer = vi.spyOn(canonical, 'synchronize'), transactions = vi.spyOn(lib, 'transaction');
    const reads = vi.spyOn(Transaction.prototype, 'rawGet'), scans = vi.spyOn(Transaction.prototype, 'rawAll');
    await bridge.syncDaily();
    expect(bridge.dailyState.tableError).toBe(''); expect(bridge.tableConflicts.value).toEqual([]);
    expect(reads.mock.calls.filter(([store, id]) => store === 'custom_table_defs' && id === saved.def.id)).toHaveLength(1);
    expect(scans.mock.calls.filter(([store]) => store === 'table_history')).toEqual([]);
    expect(transactions.mock.calls.every(([, mode]) => mode === 'readonly')).toBe(true);
    expect(writer).not.toHaveBeenCalled(); expect(ctx.saveChat).not.toHaveBeenCalled(); expect(ctx.saveMetadata).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.chat)).toBe(host); expect(await contents()).toEqual(before);
});

test('an explicit legacy soft deletion suppresses an old pending result without erasing archived tables', async () => {
    const saved = await table(await bridge.syncDaily(), '旧版软删除');
    await pending(saved.view);
    await lib.transaction(TABLE_STORES, 'readwrite', async tx => {
        const branch = (await tx.get<Branch>('branches', saved.view.branch.id))!;
        const deleted = { ...saved.def, deleted: true, version: saved.def.version + 1 };
        await tx.put('custom_table_defs', deleted);
        await recordTableWrite(tx, branch, [deleted], [], 'legacy-delete');
        branch.epoch++; await tx.put('branches', branch);
    });
    const before = await contents(), sidecar = ctx.chat[1].extra![TABLE_OUTPUT_KEY];
    await reopen(); await bridge.syncDaily();
    expect(bridge.dailyState.tableError).toBe(''); expect(bridge.tableConflicts.value).toEqual([]);
    expect(await readTables(lib, saved.view.branch)).toEqual([]);
    expect(await contents()).toEqual(before); expect(ctx.chat[1].extra![TABLE_OUTPUT_KEY]).toEqual(sidecar);
    expect(ctx.saveChat).not.toHaveBeenCalled(); expect(ctx.saveMetadata).not.toHaveBeenCalled();
});

test('deleting one table from an already committed multi-table plan preserves the surviving receipt and values', async () => {
    const first = await table(await bridge.syncDaily(), '删除目标');
    const second = await table(first.view, '保留目标');
    const plan = await pending(second.view);
    const view = await bridge.syncDaily();
    expect(await lib.all('table_receipts')).toHaveLength(2);
    const latest = (await lib.get<TableDef>('custom_table_defs', first.def.id))!;
    await saveTable(lib, view, { ...latest, deleted: true });
    const before = await contents();
    expect(before[2].map(record => record.id)).toEqual([`${plan.operation}:${second.def.id}`]);
    await reopen(); await bridge.syncDaily();
    expect(bridge.dailyState.tableError).toBe(''); expect(bridge.tableConflicts.value).toEqual([]);
    expect(await contents()).toEqual(before); expect(ctx.saveChat).not.toHaveBeenCalled();
});

test.each(['edit', 'rollback'] as const)('a pending live-table %s remains a real conflict, not a deleted-table no-op', async mode => {
    let view = await bridge.syncDaily();
    if (mode === 'rollback') {
        ctx.chat.push(message(true, '表格创建时的后续问题'));
        view = await bridge.syncDaily();
    }
    const saved = await table(view, '仍需核对');
    await pending(saved.view);
    const sidecar = ctx.chat[1].extra![TABLE_OUTPUT_KEY];
    if (mode === 'edit') await applyRows(lib, saved.view, saved.def, [{ row_id: null, values: { key: '人工当前值' } }], false);
    else {
        ctx.chat[2].mes = '修改后续问题，使表格回退到创建前';
        // Reproduce a legacy rollback tombstone before physical history cleanup.
        const original = canonical.synchronize;
        vi.spyOn(canonical, 'synchronize').mockImplementationOnce((library, observation, baseline, captured) =>
            original(library, observation, baseline && { ...baseline, retireHistory: false }, captured));
    }
    const receipts = await lib.all('table_receipts');
    await bridge.syncDaily();
    expect(bridge.dailyState.tableError).toContain('历史已改变');
    expect(bridge.tableConflicts.value).toHaveLength(1);
    expect(ctx.chat[1].extra![TABLE_OUTPUT_KEY]).toEqual(sidecar);
    expect(await lib.all('table_receipts')).toEqual(receipts);
    const visible = await readTables(lib, saved.view.branch);
    expect(visible.flatMap(input => input.rows.map(record => record.values.key))).toEqual(mode === 'edit' ? ['人工当前值'] : []);
    if (mode === 'rollback') expect(await lib.get<TableDef>('custom_table_defs', saved.def.id)).toMatchObject({ deleted: true });
});

test('an uncommitted mixed plan remains reviewable when only one target was deleted', async () => {
    const first = await table(await bridge.syncDaily(), '后来删除');
    const second = await table(first.view, '仍待写入');
    await pending(second.view);
    const sidecar = ctx.chat[1].extra![TABLE_OUTPUT_KEY];
    await saveTable(lib, second.view, { ...first.def, deleted: true });
    const before = await contents();
    await reopen(); await bridge.syncDaily();
    expect(bridge.dailyState.tableError).not.toBe(''); expect(bridge.tableConflicts.value).toHaveLength(1);
    expect(ctx.chat[1].extra![TABLE_OUTPUT_KEY]).toEqual(sidecar);
    expect(await contents()).toEqual(before);
    expect((await readTables(lib, second.view.branch)).map(input => [input.def.id, input.rows.length]))
        .toEqual([[second.def.id, 0]]);
});
