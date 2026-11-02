import { expect, test } from 'vitest';
import { fixture } from './fixtures';
import { capture } from './canonical';
import { newTable, saveTable, applyRows, readTables, parseSummaryTables, commitSummaryTables, summaryTablesPrompt } from './tables';
import type { TableDef, TableRow } from './model';

async function setup() {
    const f = await fixture(2);
    const def = newTable(f.view, '测试主键表');
    def.columns = [
        { id: 'key', name: '序号标题', type: 'text', mode: 'lock', description: '' },
        { id: 'detail', name: '客观层', type: 'text', mode: 'replace', description: '' },
    ];
    await saveTable(f.lib, f.view, def);
    return { ...f, def: (await f.lib.get<TableDef>('custom_table_defs', def.id))!, view: await capture(f.lib, f.branch.id) };
}
function ai(def: TableDef, add: object[] = [], update: object[] = []) {
    return [{ table_id: def.id, add, update }];
}
test('AI prompt emits human-readable column names; parser still stores stable IDs', async () => {
    const f = await setup();
    try {
        const inputs = await readTables(f.lib, f.branch);
        const prompt = summaryTablesPrompt(inputs);
        expect(prompt.user).toContain('"name":"序号标题"');
        expect(prompt.user).not.toContain('"column_id"');
        const plan = parseSummaryTables(ai(f.def, [{ '序号标题': 'S-038', '客观层': '首次内容' }]), inputs, f.branch.id)!;
        expect(plan.tables[0].operations[0].values).toEqual({ key: 'S-038', detail: '首次内容' });
        expect(() => parseSummaryTables(ai(f.def, [{ '不存在的列': '错误' }]), inputs, f.branch.id)).toThrow('未知字段');
    } finally { f.lib.close(); }
});
test('AI add with an exact existing primary key updates the original row instead of inserting', async () => {
    const f = await setup();
    try {
        await applyRows(f.lib, f.view, f.def,
            [{ row_id: null, values: { key: 'S-038', detail: '旧内容' } }], false);
        const rows = await f.lib.all<TableRow>('custom_table_rows', 'owner', f.def.id);
        const view = await capture(f.lib, f.branch.id);
        const inputs = await readTables(f.lib, f.branch);
        const plan = parseSummaryTables(ai(f.def, [{ '序号标题': 'S-038', '客观层': '更新内容' }]), inputs, f.branch.id)!;
        await commitSummaryTables(f.lib, view, plan, [view.memories[0].id]);
        const after = await f.lib.all<TableRow>('custom_table_rows', 'owner', f.def.id);
        expect(after).toHaveLength(1);
        expect(after[0].id).toBe(rows[0].id);
        expect(after[0].values).toEqual({ key: 'S-038', detail: '更新内容' });
    } finally { f.lib.close(); }
});
test('duplicate primary keys in one AI batch are rejected; manual duplicates cannot be added', async () => {
    const f = await setup();
    try {
        const inputs = await readTables(f.lib, f.branch);
        expect(() => parseSummaryTables(ai(f.def, [
            { '序号标题': 'S-038', '客观层': 'A' },
            { '序号标题': 'S-038', '客观层': 'B' },
        ]), inputs, f.branch.id)).toThrow('主键');
        await applyRows(f.lib, f.view, f.def, [{ row_id: null, values: { key: 'S-038' } }], false);
        const later = await capture(f.lib, f.branch.id);
        await expect(applyRows(f.lib, later, f.def,
            [{ row_id: null, values: { key: 'S-038' } }], false)).rejects.toThrow('主键已存在');
        expect(await f.lib.all<TableRow>('custom_table_rows', 'owner', f.def.id)).toHaveLength(1);
    } finally { f.lib.close(); }
});
test('primary key matching is exact and case-sensitive; missing keys are rejected', async () => {
    const f = await setup();
    try {
        const inputs = await readTables(f.lib, f.branch);
        expect(() => parseSummaryTables(ai(f.def, [{ '客观层': '缺少主键' }]), inputs, f.branch.id)).toThrow('必填主键');
        const plan = parseSummaryTables(ai(f.def, [{ '序号标题': 'S-038' }, { '序号标题': 's-038' }]), inputs, f.branch.id);
        expect(plan?.tables[0].operations).toHaveLength(2);
    } finally { f.lib.close(); }
});

test('no-change summary plans record completion without changing table history or data versions', async () => {
    const f = await setup();
    try {
        const inputs = await readTables(f.lib, f.view.branch);
        const plan = parseSummaryTables(ai(f.def), inputs, f.branch.id)!;
        plan.tableHead = f.view.branch.tableHead;
        await commitSummaryTables(f.lib, f.view, plan, [f.view.memories[0].id]);
        const branch = await f.lib.get<any>('branches', f.branch.id);
        expect(branch.tableHead).toBe(plan.tableHead);
        expect(branch.epoch).toBe(f.view.branch.epoch);
        expect((await f.lib.get<TableDef>('custom_table_defs', f.def.id))!.dataVersion).toBe(inputs[0].def.dataVersion);
        expect(await f.lib.all('table_receipts')).toHaveLength(1);
    } finally { f.lib.close(); }
});
test('AI add must not update an existing hidden primary-key row in the commit transaction', async () => {
    const f = await setup();
    try {
        await applyRows(f.lib, f.view, f.def, [{ row_id: null, values: { key: 'hidden-key', detail: '保留' }, hidden: true }], false);
        const view = await capture(f.lib, f.branch.id);
        const plan = parseSummaryTables(ai(f.def, [{ key: 'hidden-key', detail: '不能覆盖' }]), await readTables(f.lib, view.branch), f.branch.id)!;
        await expect(commitSummaryTables(f.lib, view, plan, [view.memories[0].id])).rejects.toThrow('隐藏行');
        expect((await f.lib.all<TableRow>('custom_table_rows'))[0].values.detail).toBe('保留');
    } finally { f.lib.close(); }
});

test('no-change response skips building a primary-key index over all existing rows', async () => {
    const f = await setup();
    try {
        const inputs = await readTables(f.lib, f.view.branch);
        Object.defineProperty(inputs[0], 'rows', { get() { throw new Error('Unexpected full row scan'); } });
        expect(parseSummaryTables(ai(f.def), inputs, f.branch.id)!.tables[0].operations).toEqual([]);
    } finally { f.lib.close(); }
});
