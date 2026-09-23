import { expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { capture, statuses, synchronize } from './canonical';
import { Transaction } from './db';
import {
    newTable,
    saveTable,
    applyRows,
    readTables,
    summaryTablesPrompt,
    parseSummaryTables,
    commitSummaryTables,
    renderTableState,
    mergeCells,
} from './tables';
import { exportLibrary, restoreLibrary } from './migration';
import { fingerprint, type TableDef, type TableRow } from './model';
async function setup() {
    const f = await fixture(2),
        def = newTable(f.view, '合成事项表');
    def.columns = [
        {
            id: 'title',
            name: '名称',
            description: '事项名称',
            prompt: '只填写正文已发生的约定',
            type: 'text',
            mode: 'lock',
        },
        { id: 'notes', name: '进展', description: '事项进度', prompt: '只添加新的行动', type: 'text', mode: 'append' },
        { id: 'count', name: '次数', description: '次数', prompt: '使用数字', type: 'number', mode: 'replace' },
    ];
    await saveTable(f.lib, f.view, def);
    const stored = (await f.lib.get<TableDef>('custom_table_defs', def.id))!;
    return { ...f, def: stored, view: await capture(f.lib, f.branch.id) };
}
function output(id: string, add: unknown[] = [], update: unknown[] = []) {
    return [{ table_id: id, add, update }];
}
test('summary input contains definitions, writing instructions and visible rows, with add/update JSON protocol', async () => {
    const f = await setup();
    try {
        await applyRows(
            f.lib,
            f.view,
            f.def,
            [
                { row_id: null, values: { title: '可见约定', notes: '开始', count: 1 } },
                { row_id: null, values: { title: '隐藏敏感记录' }, hidden: true },
            ],
            false,
        );
        const inputs = await readTables(f.lib, f.branch),
            prompt = summaryTablesPrompt(inputs);
        expect(prompt.system).toContain('customTables');
        expect(prompt.system).toContain('"add"');
        expect(prompt.system).toContain('"update"');
        expect(prompt.user).toContain('只填写正文已发生的约定');
        expect(prompt.user).toContain('可见约定');
        expect(prompt.user).not.toContain('隐藏敏感记录');
        expect(renderTableState(inputs)).toContain('可见约定');
        expect(renderTableState(inputs)).not.toContain('隐藏敏感记录');
    } finally {
        f.lib.close();
    }
});
test('one batch writes all tables atomically, preserves no-op receipts, and cannot replay append', async () => {
    const f = await setup();
    try {
        const other = newTable(f.view, '合成第二表');
        other.columns = f.def.columns;
        await saveTable(f.lib, f.view, other);
        let view = await capture(f.lib, f.branch.id),
            inputs = await readTables(f.lib, f.branch);
        const plan = parseSummaryTables(
            [...output(f.def.id, [{ title: '玉佩', notes: '借出', count: 1 }]), ...output(other.id)],
            inputs,
            f.branch.id,
        )!;
        await commitSummaryTables(f.lib, view, plan, [view.memories[0].id]);
        await commitSummaryTables(f.lib, view, plan, [view.memories[0].id]);
        expect(await f.lib.all('table_receipts')).toHaveLength(2);
        expect(await f.lib.all('custom_table_rows')).toHaveLength(1);
        inputs = await readTables(f.lib, f.branch);
        const record = inputs.find((i) => i.def.id === f.def.id)!.rows[0];
        const update = parseSummaryTables(
            [
                ...output(f.def.id, [], [{ row_id: record.id, values: { notes: '归还', count: 2 } }]),
                ...output(other.id),
            ],
            inputs,
            f.branch.id,
        )!;
        view = await capture(f.lib, f.branch.id);
        await commitSummaryTables(f.lib, view, update, [view.memories[1].id]);
        await commitSummaryTables(f.lib, view, update, [view.memories[1].id]);
        expect((await f.lib.get<TableRow>('custom_table_rows', record.id))?.values).toEqual({
            title: '玉佩',
            notes: '借出\n归还',
            count: 2,
        });
    } finally {
        f.lib.close();
    }
});
test('locked fields permit a first value including 0/false and reject later edits', async () => {
    const f = await setup();
    try {
        expect(mergeCells(f.def, {}, { title: '第一次' }, true).title).toBe('第一次');
        expect(() => mergeCells(f.def, { title: '第一次' }, { title: '改动' }, true)).toThrow('锁定');
        expect(() => mergeCells(f.def, { title: '第一次' }, { title: '改动' }, false)).toThrow('锁定');
        const def = {
            ...f.def,
            columns: [
                { id: 'n', name: '数', type: 'number' as const, mode: 'lock' as const, description: '' },
                { id: 'b', name: '是否', type: 'boolean' as const, mode: 'lock' as const, description: '' },
            ],
        };
        expect(mergeCells(def, {}, { n: 0, b: false }, true)).toEqual({ n: 0, b: false });
        expect(() => mergeCells(def, { n: 0, b: false }, { n: 1 }, true)).toThrow('锁定');
        expect(() => mergeCells(def, { n: 0, b: false }, { b: true }, false)).toThrow('锁定');
    } finally {
        f.lib.close();
    }
});
test('missing output, wrong types, invented tables/rows and duplicate updates are rejected', async () => {
    const f = await setup();
    try {
        const inputs = await readTables(f.lib, f.branch);
        expect(() => parseSummaryTables(undefined, inputs, f.branch.id)).toThrow('缺少');
        expect(() => parseSummaryTables(output('fake'), inputs, f.branch.id)).toThrow('未知表');
        expect(() => parseSummaryTables(output(f.def.id, [{ count: '1' }]), inputs, f.branch.id)).toThrow('类型错误');
        expect(() =>
            parseSummaryTables(output(f.def.id, [], [{ row_id: 'fake', values: { notes: 'x' } }]), inputs, f.branch.id),
        ).toThrow('未知');
        expect(() => parseSummaryTables([{ ...output(f.def.id)[0], hidden: true }], inputs, f.branch.id)).toThrow(
            '无效',
        );
    } finally {
        f.lib.close();
    }
});
test('table/row edits during the summary reject the whole result without partial writes', async () => {
    const f = await setup();
    try {
        const inputs = await readTables(f.lib, f.branch),
            plan = parseSummaryTables(output(f.def.id, [{ title: '迟到' }]), inputs, f.branch.id)!;
        await applyRows(f.lib, f.view, f.def, [{ row_id: null, values: { title: '人工' } }], false);
        const view = await capture(f.lib, f.branch.id);
        await expect(commitSummaryTables(f.lib, view, plan, [view.memories[0].id])).rejects.toThrow('已改变');
        expect(await f.lib.all('table_receipts')).toHaveLength(1);
        expect((await f.lib.all<TableRow>('custom_table_rows'))[0].values.title).toBe('人工');
    } finally {
        f.lib.close();
    }
});
test('failure midway through a two-table transaction rolls back every row and receipt', async () => {
    const f = await setup();
    try {
        const second = newTable(f.view, '第二表');
        second.columns = f.def.columns;
        await saveTable(f.lib, f.view, second);
        const view = await capture(f.lib, f.branch.id),
            inputs = await readTables(f.lib, f.branch);
        const plan = parseSummaryTables(
            [...output(f.def.id, [{ title: 'A' }]), ...output(second.id, [{ title: 'B' }])],
            inputs,
            f.branch.id,
        )!;
        const native = Transaction.prototype.add;
        let receipts = 0;
        const spy = vi.spyOn(Transaction.prototype, 'add').mockImplementation(function (
            this: Transaction,
            store,
            value,
        ) {
            if (store === 'table_receipts' && ++receipts === 2) throw Error('合成写入故障');
            return native.call(this, store, value);
        });
        try {
            await expect(commitSummaryTables(f.lib, view, plan, [view.memories[0].id])).rejects.toThrow('写入故障');
        } finally {
            spy.mockRestore();
        }
        expect(await f.lib.all('custom_table_rows')).toHaveLength(0);
        expect(await f.lib.all('table_receipts')).toHaveLength(0);
    } finally {
        f.lib.close();
    }
});
test('hidden rows cannot be guessed by AI and manual stale row edits are rejected', async () => {
    const f = await setup();
    try {
        await applyRows(f.lib, f.view, f.def, [{ row_id: null, values: { title: '隐藏' }, hidden: true }], false);
        const r = (await f.lib.all<TableRow>('custom_table_rows'))[0],
            view = await capture(f.lib, f.branch.id);
        expect(() =>
            parseSummaryTables(
                output(f.def.id, [], [{ row_id: r.id, values: { notes: '越权' } }]),
                [{ def: f.def, rows: [] }],
                f.branch.id,
            ),
        ).toThrow();
        await expect(
            applyRows(f.lib, view, f.def, [{ row_id: r.id, values: { notes: '旧弹窗' }, expectedVersion: 0 }], false),
        ).rejects.toThrow('已被更新');
        await expect(
            applyRows(f.lib, view, f.def, [{ row_id: r.id, values: { notes: '越权' } }], true),
        ).rejects.toThrow('隐藏行');
    } finally {
        f.lib.close();
    }
});
test('new schema instructions, lock policy and hidden rows survive core export/restore', async () => {
    const f = await setup();
    try {
        await applyRows(f.lib, f.view, f.def, [{ row_id: null, values: { title: '归档隐藏' }, hidden: true }], false);
        const pack = await exportLibrary(f.lib),
            restored = await restoreLibrary(pack, false);
        try {
            expect((await exportLibrary(restored)).data).toEqual(pack.data);
            expect(restored.db.version).toBe(1);
        } finally {
            restored.close();
        }
    } finally {
        f.lib.close();
    }
});
test('source-invalid table rows are not injected and removed columns remain outside prompt', async () => {
    const f = await setup();
    try {
        await applyRows(f.lib, f.view, f.def, [{ row_id: null, values: { title: '应过滤的旧记录' } }], false, [
            f.view.memories[0].id,
        ]);
        f.input.messages[0].content = '改写正文';
        await synchronize(f.lib, f.input);
        const view = await capture(f.lib, f.branch.id),
            states = await statuses(f.lib, view);
        const allowed = new Set(view.memories.filter((m) => states.get(m.id) === 'valid').map((m) => m.id));
        expect(renderTableState(await readTables(f.lib, f.branch), allowed)).not.toContain('应过滤的旧记录');
    } finally {
        f.lib.close();
    }
});
test('summary validity loads each shared basis once instead of once per summary', async () => {
    const f = await fixture(80);
    const get = vi.spyOn(Transaction.prototype, 'get'),
        all = vi.spyOn(Transaction.prototype, 'all');
    try {
        expect([...(await statuses(f.lib, f.view)).values()].every((v) => v === 'valid')).toBe(true);
        expect(get.mock.calls.filter((c) => c[0] === 'history_snapshots')).toHaveLength(1);
        expect(get.mock.calls.filter((c) => c[0] === 'manifest_blocks')).toHaveLength(2);
        expect(all.mock.calls.filter((c) => c[0] === 'reviews')).toHaveLength(1);
    } finally {
        get.mockRestore();
        all.mockRestore();
        f.lib.close();
    }
});

test('legacy v1 packages restore without changing IDs or legacy manual policy', async () => {
    const f = await setup();
    try {
        const pack = await exportLibrary(f.lib);
        pack.version = 1;
        for (const def of pack.data.custom_table_defs as TableDef[]) {
            delete def.tableSchema;
            delete def.dataVersion;
            for (const column of def.columns) {
                delete column.prompt;
                if (column.mode === 'lock') column.mode = 'manual';
            }
        }
        const { checksum, ...base } = pack;
        pack.checksum = await fingerprint(base);
        const restored = await restoreLibrary(pack, false);
        try {
            expect((await exportLibrary(restored)).data).toEqual(pack.data);
        } finally {
            restored.close();
        }
    } finally {
        f.lib.close();
    }
});
