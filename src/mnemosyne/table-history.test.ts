import 'fake-indexeddb/auto';
import { test, expect } from 'vitest';
import { fixture, observation } from './fixtures';
import { capture, synchronize, forkBranch } from './canonical';
import { newTable, saveTable, applyRows, readTables, parseSummaryTables, commitSummaryTables } from './tables';
import { exportLibrary, restoreLibrary } from './migration';
import { Library, freshLibraryName } from './db';
import { previewArchiveDeletion, commitArchiveDeletion } from './archive-deletion';
import { STORES, fingerprint, type TableDef, type TableRow, type Branch, type TableCommit } from './model';

async function setup() {
    const f = await fixture(1);
    const def = newTable(f.view, '逐楼状态');
    def.columns = [{ id: 'v', name: '状态', type: 'text', description: '', mode: 'replace' },
        { id: 'a', name: '追加', type: 'text', description: '', mode: 'append' }];
    await saveTable(f.lib, f.view, def);
    const write = async (value: string, scope = f.input.scope, branch = f.branch.id) => {
        const view = await capture(f.lib, branch);
        const table = (await f.lib.all<TableDef>('custom_table_defs', 'branch', branch)).find(d => !d.deleted)!;
        const existing = (await f.lib.all<TableRow>('custom_table_rows', 'owner', table.id)).find(r => !r.deleted);
        await applyRows(f.lib, view, table, [{ row_id: existing?.id ?? null, values: { v: value } }], false);
        return (await f.lib.all<TableRow>('custom_table_rows', 'owner', table.id)).find(r => !r.deleted)!;
    };
    const advance = async (count: number, scope = f.input.scope) => synchronize(f.lib, observation(count, scope));
    const values = async (branch = f.branch.id) => (await readTables(f.lib, (await capture(f.lib, branch)).branch))
        .flatMap(t => t.rows.map(r => r.values.v));
    return { ...f, def, write, advance, values };
}

test('tail deletion over 100 floors restores manual state; regrowth cannot resurrect abandoned writes', async () => {
    const f = await setup();
    try {
        await f.write('最初');
        await f.advance(2); await f.write('保留点');
        await f.advance(55); await f.write('未来人工值');
        const before = await capture(f.lib, f.branch.id);
        await f.advance(2);
        expect(await f.values()).toEqual(['保留点']);
        const after = await capture(f.lib, f.branch.id);
        expect(after.branch.epoch).toBeGreaterThan(before.branch.epoch);
        expect(after.branch.tableHead).not.toBe(before.branch.tableHead);
        await f.advance(55);
        expect(await f.values()).toEqual(['保留点']);
        expect((await f.lib.all<TableCommit>('table_history')).some(c => c.rows.some(r => r.values.v === '未来人工值'))).toBe(true);
    } finally { f.lib.close(); }
});

test('multiple writes at one floor, schema, hiding and deletion all follow the same history', async () => {
    const f = await setup();
    try {
        await f.write('第一版'); await f.write('同楼最终版');
        await f.advance(2); const r = await f.write('下一楼');
        let view = await capture(f.lib, f.branch.id);
        let def = (await f.lib.get<TableDef>('custom_table_defs', f.def.id))!;
        await applyRows(f.lib, view, def, [{ row_id: r.id, values: {}, hidden: true }], false);
        view = await capture(f.lib, f.branch.id);
        await saveTable(f.lib, view, { ...def, name: '后来的表名', columns: def.columns.slice(0, 1) });
        view = await capture(f.lib, f.branch.id); def = (await f.lib.get<TableDef>('custom_table_defs', f.def.id))!;
        await saveTable(f.lib, view, { ...def, deleted: true });
        const oldVersion = (await f.lib.get<TableDef>('custom_table_defs', def.id))!.version;
        await f.advance(1);
        expect(await f.values()).toEqual(['同楼最终版']);
        const restored = (await f.lib.get<TableDef>('custom_table_defs', def.id))!;
        expect(restored.name).toBe('逐楼状态'); expect(restored.columns).toHaveLength(2);
        expect(restored.version).toBeGreaterThan(oldVersion);
        expect((await f.lib.get<TableRow>('custom_table_rows', r.id))!.hidden).toBe(false);
    } finally { f.lib.close(); }
});

test('fork inherits cutoff state and earlier history with independent table and row identities', async () => {
    const f = await setup();
    try {
        await f.write('第1轮'); await f.advance(2); await f.write('第2轮'); await f.advance(3); await f.write('父未来');
        const child = await forkBranch(f.lib, await capture(f.lib, f.branch.id, 4), 'child');
        expect(await f.values(child.id)).toEqual(['第2轮']);
        const childDef = (await f.lib.all<TableDef>('custom_table_defs', 'branch', child.id))[0];
        expect(childDef.id).not.toBe(f.def.id);
        await f.advance(3, 'child'); await f.write('子未来', 'child', child.id);
        expect(await f.values()).toEqual(['父未来']);
        const grandchild = await forkBranch(f.lib, await capture(f.lib, child.id, 2), 'grandchild');
        expect(await f.values(grandchild.id)).toEqual(['第1轮']);
        const restored = await restoreLibrary(await exportLibrary(f.lib), false);
        expect((await readTables(restored, (await capture(restored, grandchild.id)).branch))[0].rows[0].values.v).toBe('第1轮');
        restored.close();
    } finally { f.lib.close(); }
});

test('AI append after-images replay exactly once and source IDs are remapped on fork', async () => {
    const f = await setup();
    try {
        const r = await f.write('起点');
        await f.advance(2);
        let view = await capture(f.lib, f.branch.id);
        let def = (await f.lib.get<TableDef>('custom_table_defs', f.def.id))!;
        await applyRows(f.lib, view, def, [{ row_id: r.id, values: { a: '一次' } }], true, [view.memories[0].id], 'append-once');
        await applyRows(f.lib, view, def, [{ row_id: r.id, values: { a: '一次' } }], true, [view.memories[0].id], 'append-once');
        await f.advance(3); view = await capture(f.lib, f.branch.id);
        await applyRows(f.lib, view, def, [{ row_id: r.id, values: { a: '后来' } }], true, [view.memories[1].id]);
        await f.advance(2);
        expect((await f.lib.get<TableRow>('custom_table_rows', r.id))!.values.a).toBe('一次');
        const child = await forkBranch(f.lib, await capture(f.lib, f.branch.id), 'child');
        const rows = await f.lib.all<TableRow>('custom_table_rows', 'branch', child.id);
        for (const id of rows.flatMap(r => r.sources)) expect((await f.lib.get('memory_revisions', id))?.branch).toBe(child.id);
        const restored = await restoreLibrary(await exportLibrary(f.lib), false); restored.close();
    } finally { f.lib.close(); }
});

test('middle edit and identical-text swipe reject future table state without inventing message identity', async () => {
    const f = await setup();
    try {
        await f.write('早期'); await f.advance(2); await f.write('旧变体');
        const changed = observation(2); changed.messages[3].swipe = 1;
        await synchronize(f.lib, changed);
        expect(await f.values()).toEqual(['早期']);
        expect((await capture(f.lib, f.branch.id)).snapshot.variants).toEqual([0, 0, 0, 1]);
        changed.messages[0].content = '改写开头';
        await synchronize(f.lib, changed);
        expect(await f.values()).toEqual([]);
        expect((await capture(f.lib, f.branch.id)).branch.tableHistoryGap).toBe(false);
    } finally { f.lib.close(); }
});

test('pending plans and stale manual editors cannot overwrite restored projection', async () => {
    const f = await setup();
    try {
        await f.write('早期'); await f.advance(2); await f.write('未来');
        const old = await capture(f.lib, f.branch.id), inputs = await readTables(f.lib, old.branch);
        const plan = parseSummaryTables([{ table_id: f.def.id, add: [{ v: '迟到' }], update: [] }], inputs, f.branch.id)!;
        plan.tableHead = old.branch.tableHead;
        const legacyPlan = { ...plan }; delete legacyPlan.tableHead;
        await f.advance(1);
        const current = await capture(f.lib, f.branch.id);
        await expect(commitSummaryTables(f.lib, current, plan, [current.memories[0].id])).rejects.toThrow('历史已改变');
        await expect(commitSummaryTables(f.lib, current, legacyPlan, [current.memories[0].id])).rejects.toThrow('表格已改变');
        await expect(applyRows(f.lib, old, inputs[0].def, [{ row_id: null, values: { v: '旧编辑器' } }], false)).rejects.toThrow('迟到');
        expect(await f.values()).toEqual(['早期']);
    } finally { f.lib.close(); }
});

test('unknown pre-upgrade history is a gap, never a fabricated old table', async () => {
    const f = await setup();
    try {
        await f.write('仅剩最新值');
        await f.lib.transaction(['branches', 'table_history'], 'readwrite', async tx => {
            for (const h of await tx.all('table_history')) await tx.delete('table_history', h.id);
            const branch = (await tx.get<Branch>('branches', f.branch.id))!;
            delete branch.tableHead; delete branch.tableHistoryGap; await tx.put('branches', branch);
        });
        await f.advance(2); await f.write('升级后值'); await f.advance(1);
        expect(await f.values()).toEqual(['仅剩最新值']);
        await synchronize(f.lib, { scope: f.input.scope, messages: [], memories: [] });
        expect(await f.values()).toEqual([]);
        expect((await capture(f.lib, f.branch.id)).branch.tableHistoryGap).toBe(true);
        expect((await f.lib.all<TableCommit>('table_history')).some(c => c.rows.some(r => r.values.v === '仅剩最新值'))).toBe(true);
    } finally { f.lib.close(); }
});

test('transaction failure never leaves partial projection, version or history', async () => {
    const f = await setup();
    try {
        await f.write('原值');
        const before = await exportLibrary(f.lib), view = await capture(f.lib, f.branch.id);
        const plan = parseSummaryTables([{ table_id: f.def.id, add: [{ v: '撤销' }], update: [] }], await readTables(f.lib, view.branch), f.branch.id)!;
        let checks = 0;
        await expect(commitSummaryTables(f.lib, view, plan, [view.memories[0].id], () => ++checks < 2)).rejects.toThrow('聊天已改变');
        expect((await exportLibrary(f.lib)).data).toEqual(before.data);
    } finally { f.lib.close(); }
});

test('checkpoint bounds replay while preserving older cutoff inheritance', async () => {
    const f = await setup();
    try {
        await f.write('旧值'); await f.advance(2);
        for (let i = 0; i < 65; i++) await f.write(`修改${i}`);
        expect((await f.lib.all<TableCommit>('table_history')).filter(c => c.checkpoint).length).toBeGreaterThan(1);
        const child = await forkBranch(f.lib, await capture(f.lib, f.branch.id, 2), 'checkpoint-child');
        expect(await f.values(child.id)).toEqual(['旧值']);
        const restored = await restoreLibrary(await exportLibrary(f.lib), false); restored.close();
    } finally { f.lib.close(); }
});

test('new core backup rejects missing history, cross-branch heads and cyclic predecessors', async () => {
    const f = await setup();
    try {
        await f.write('资料');
        const pack = await exportLibrary(f.lib);
        for (const alter of [
            (p: typeof pack) => { p.data.table_history.pop(); p.counts.table_history--; },
            (p: typeof pack) => { const h = p.data.table_history[0] as TableCommit; h.parent = h.id; },
            (p: typeof pack) => { (p.data.branches[0] as Branch).tableHead = 'missing'; },
        ]) {
            const broken = structuredClone(pack); alter(broken);
            const { checksum, ...base } = broken; broken.checksum = await fingerprint(base);
            await expect(restoreLibrary(broken, false)).rejects.toThrow();
        }
    } finally { f.lib.close(); }
});

test('physical v1 upgrade adds history store without replacing existing object stores', async () => {
    const name = freshLibraryName();
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => {
            for (const store of STORES.filter(s => s !== 'table_history')) {
                const native = request.result.createObjectStore(store, { keyPath: 'id' });
                for (const key of ['story', 'branch', 'owner']) native.createIndex(key, key);
            }
            request.transaction!.objectStore('stories').add({ id: 'preserved', schema: 1, created: 1 });
        };
        request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error);
    });
    const lib = await Library.open(name);
    expect(lib.db.version).toBe(2); expect((await lib.get('stories', 'preserved'))?.id).toBe('preserved');
    expect(await lib.all('table_history')).toEqual([]); lib.close();
});

test('child archive deletion removes only its table history and preserves parent restore path', async () => {
    const f = await setup();
    try {
        await f.write('父表'); await f.advance(2); await f.write('父未来');
        const child = await forkBranch(f.lib, await capture(f.lib, f.branch.id, 2), 'delete-child');
        await expect(previewArchiveDeletion(f.lib, f.branch.id)).rejects.toThrow('子分支依赖');
        const plan = await previewArchiveDeletion(f.lib, child.id);
        await commitArchiveDeletion(f.lib, plan, () => true);
        expect(await f.lib.all('table_history', 'branch', child.id)).toEqual([]);
        await f.advance(1); expect(await f.values()).toEqual(['父表']);
        const restored = await restoreLibrary(await exportLibrary(f.lib), false); restored.close();
    } finally { f.lib.close(); }
});

test('v10 backup enters baseline-only history and roundtrip never claims old values exist', async () => {
    const f = await setup();
    try {
        await f.write('旧包最新值');
        const { withoutTableHistory } = await import('./fixtures');
        const legacy = withoutTableHistory(await exportLibrary(f.lib)); legacy.version = 10;
        const { checksum, ...base } = legacy; legacy.checksum = await fingerprint(base);
        const restored = await restoreLibrary(legacy, false);
        try {
            expect(await restored.all('table_history')).toEqual([]);
            await synchronize(restored, { scope: f.input.scope, messages: [], memories: [] });
            const view = await capture(restored, f.branch.id);
            expect(view.branch.tableHistoryGap).toBe(true);
            expect(await readTables(restored, view.branch)).toEqual([]);
            const backup = await exportLibrary(restored);
            expect(backup.version).toBe(11);
            expect((backup.data.table_history as TableCommit[]).some(h => h.rows.some(r => r.values.v === '旧包最新值'))).toBe(true);
        } finally { restored.close(); }
    } finally { f.lib.close(); }
});

test('body backfill is committed now, not backdated to the selected old source range', async () => {
    const f = await setup();
    try {
        await f.write('旧状态'); await f.advance(3);
        const view = await capture(f.lib, f.branch.id);
        const inputs = await readTables(f.lib, view.branch), existing = inputs[0].rows[0];
        const plan = parseSummaryTables([{ table_id: f.def.id, add: [], update: [{ row_id: existing.id, values: { v: '今天补填' } }] }], inputs, f.branch.id)!;
        await commitSummaryTables(f.lib, view, plan, [], () => true, { start: 0, end: 1, refs: view.refs.slice(0, 2) });
        expect(await f.values()).toEqual(['今天补填']);
        const child = await forkBranch(f.lib, await capture(f.lib, f.branch.id, 2), 'backfill-child');
        expect(await f.values(child.id)).toEqual(['旧状态']);
    } finally { f.lib.close(); }
});

test('checkpoint after rollback does not copy abandoned future tombstones into a child', async () => {
    const f = await setup();
    try {
        await f.write('保留'); await f.advance(2);
        let view = await capture(f.lib, f.branch.id);
        const future = newTable(view, '只属于弃用未来');
        await saveTable(f.lib, view, future);
        await f.advance(1);
        for (let i = 0; i < 65; i++) await f.write(`留存${i}`);
        const child = await forkBranch(f.lib, await capture(f.lib, f.branch.id), 'no-future');
        expect((await f.lib.all<TableDef>('custom_table_defs', 'branch', child.id)).map(d => d.name)).not.toContain('只属于弃用未来');
        expect((await f.lib.all<TableCommit>('table_history', 'branch', child.id)).flatMap(c => c.defs).some(d => d.name === '只属于弃用未来')).toBe(false);
        const restored = await restoreLibrary(await exportLibrary(f.lib), false); restored.close();
    } finally { f.lib.close(); }
});

test('recomputed checksum does not excuse a projection/history mismatch', async () => {
    const f = await setup();
    try {
        await f.write('原值');
        const broken = await exportLibrary(f.lib);
        (broken.data.custom_table_rows[0] as TableRow).values.v = '仅改当前值';
        const { checksum, ...base } = broken; broken.checksum = await fingerprint(base);
        await expect(restoreLibrary(broken, false)).rejects.toThrow('当前值与采用历史不一致');
    } finally { f.lib.close(); }
});

test('identities cannot be used to write another branch table', async () => {
    const f = await setup();
    try {
        await f.write('父原值');
        const child = await forkBranch(f.lib, await capture(f.lib, f.branch.id), 'isolation');
        const view = await capture(f.lib, child.id), def = (await f.lib.get<TableDef>('custom_table_defs', f.def.id))!;
        await expect(saveTable(f.lib, view, { ...def, branch: child.id })).rejects.toThrow('跨分支');
        await expect(applyRows(f.lib, view, def, [{ row_id: null, values: { v: '越界' } }], false)).rejects.toThrow('跨分支');
        expect(await f.values()).toEqual(['父原值']);
    } finally { f.lib.close(); }
});

test('abandoned receipts never revive backfill completion after identical chat regrowth', async () => {
    const f = await setup();
    try {
        await f.write('基础'); await f.advance(2);
        const view = await capture(f.lib, f.branch.id), inputs = await readTables(f.lib, view.branch);
        const plan = parseSummaryTables([{ table_id: f.def.id, add: [], update: [{ row_id: inputs[0].rows[0].id, values: { v: '补表结果' } }] }], inputs, f.branch.id)!;
        await commitSummaryTables(f.lib, view, plan, [], () => true, { start: 0, end: 1, refs: view.refs.slice(0, 2) });
        const { tableLastFloors } = await import('./table-backfill');
        expect((await tableLastFloors(f.lib, (await capture(f.lib, f.branch.id)).branch)).floors[f.def.id]).toBe(1);
        await f.advance(1); await f.advance(2);
        expect((await tableLastFloors(f.lib, (await capture(f.lib, f.branch.id)).branch)).floors[f.def.id]).toBeUndefined();
        expect(await f.values()).toEqual(['基础']);
    } finally { f.lib.close(); }
});

test('inherited older summary evidence remains unselected and portable instead of losing provenance', async () => {
    const f = await setup();
    try {
        const view = await capture(f.lib, f.branch.id), def = (await f.lib.get<TableDef>('custom_table_defs', f.def.id))!;
        await applyRows(f.lib, view, def, [{ row_id: null, values: { v: '旧摘要生成' } }], true, [view.memories[0].id]);
        const changed = observation(1); changed.memories[0].content = '新摘要，不再选择旧版本';
        await synchronize(f.lib, changed);
        const child = await forkBranch(f.lib, await capture(f.lib, f.branch.id), 'old-evidence');
        const inherited = (await f.lib.all<TableRow>('custom_table_rows', 'branch', child.id))[0];
        expect(inherited.values.v).toBe('旧摘要生成');
        expect(inherited.sources).toHaveLength(1);
        const old = await f.lib.get<any>('memory_revisions', inherited.sources[0]);
        expect(old.branch).toBe(child.id);
        expect(old.content).toBe(view.memories[0].content);
        expect((await capture(f.lib, child.id)).memories.some(m => m.id === old.id)).toBe(false);
        const restored = await restoreLibrary(await exportLibrary(f.lib), false); restored.close();
    } finally { f.lib.close(); }
});

test('A to B to A swipe keeps abandoned batch cursor rolled back to last retained batch, not one floor', async () => {
    const f = await setup();
    try {
        await f.write('基础');
        const { tableLastFloors } = await import('./table-backfill');
        async function fill(start: number, end: number, value: string) {
            const view = await capture(f.lib, f.branch.id), inputs = await readTables(f.lib, view.branch);
            const plan = parseSummaryTables([{ table_id: f.def.id, add: [], update: [{ row_id: inputs[0].rows[0].id, values: { v: value } }] }], inputs, f.branch.id)!;
            await commitSummaryTables(f.lib, view, plan, [], () => true, { start, end, refs: view.refs.slice(start, end + 1) });
        }
        await fill(0, 1, '保留批次');
        await f.advance(3); await fill(2, 5, 'A整批');
        expect((await tableLastFloors(f.lib, (await capture(f.lib, f.branch.id)).branch)).floors[f.def.id]).toBe(5);
        const input = observation(3); input.messages[5].swipe = 1;
        await synchronize(f.lib, input);
        expect(await f.values()).toEqual(['保留批次']);
        expect((await tableLastFloors(f.lib, (await capture(f.lib, f.branch.id)).branch)).floors[f.def.id]).toBe(1);
        input.messages[5].swipe = 0; await synchronize(f.lib, input);
        const view = await capture(f.lib, f.branch.id);
        expect(await f.values()).toEqual(['保留批次']);
        const progress = await tableLastFloors(f.lib, view.branch);
        expect(progress.floors[f.def.id]).toBe(1); // Next batch starts at #2 and includes changed #5.
        await fill(progress.floors[f.def.id] + 1, 5, 'A重新确认');
        expect(await f.values()).toEqual(['A重新确认']);
        expect((await tableLastFloors(f.lib, (await capture(f.lib, f.branch.id)).branch)).floors[f.def.id]).toBe(5);
    } finally { f.lib.close(); }
});
