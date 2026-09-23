import { parseStrictJson } from './json';
import { Library } from './db';
import { current, statuses } from './canonical';
import { row, check, fingerprint, type TableDef, type TableRow, type Column, type CapturedView, type Branch } from './model';
export function validateColumns(columns: Column[]) {
    check(Array.isArray(columns) && columns.length <= 100 && new Set(columns.map(c => c.id)).size === columns.length, '字段重复或超过100个');
    for (const c of columns) {
        check(typeof c.id === 'string' && c.id && typeof c.name === 'string' && c.name.trim() && typeof c.description === 'string', '字段定义不完整');
        check(['text', 'number', 'boolean'].includes(c.type) && ['replace', 'append', 'manual'].includes(c.mode), '字段类型/更新模式无效');
        check(c.mode !== 'append' || c.type === 'text', '追加模式只用于文本字段');
    }
}
export async function saveTable(lib: Library, view: CapturedView, input: TableDef) {
    validateColumns(input.columns);
    check(input.name.trim() && input.branch === view.branch.id && input.story === view.branch.story, '表名/范围无效');
    await lib.transaction(['branches', 'custom_table_defs'], 'readwrite', async (tx) => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(branch && branch.epoch === view.branch.epoch, '视图已改变');
        const old = await tx.get<TableDef>('custom_table_defs', input.id);
        check(!old || old.version === input.version, '表定义已改变');
        // Removed column values stay in rows as recoverable historical cells; AI never receives them.
        if (old)
            for (const column of input.columns) {
                const previous = old.columns.find(c => c.id === column.id);
                check(!previous || previous.type === column.type, '已有字段不可原地改类型；请新建字段，旧值保留');
            }
        await tx.put('custom_table_defs', { ...input, version: (old?.version ?? 0) + 1, updated: Date.now() } as TableDef);
        branch.epoch++;
        await tx.put('branches', branch);
    });
}
export function newTable(view: CapturedView, name: string): TableDef {
    return { ...row('table'), story: view.branch.story, branch: view.branch.id, name, description: '',
        columns: [], ai: false, version: 0, created: Date.now(), updated: Date.now(), deleted: false };
}
export function validateCells(def: TableDef, values: TableRow['values'], ai: boolean) {
    check(values && typeof values === 'object' && !Array.isArray(values), '行值应为对象');
    for (const [key, value] of Object.entries(values)) {
        const column = def.columns.find(c => c.id === key);
        check(column, `未知字段 ${key}`);
        check(!ai || column.mode !== 'manual', `人工字段 ${column.name} 禁止 AI 修改`);
        check(typeof value === (column.type === 'text' ? 'string' : column.type), `字段 ${column.name} 类型错误`);
        check(typeof value !== 'number' || Number.isFinite(value), '非有限数字');
    }
}
export interface TableOperation {
    row_id: string | null;
    values: TableRow['values'];
    delete?: boolean;
}
export async function applyRows(lib: Library, view: CapturedView, def: TableDef, ops: TableOperation[], ai: boolean, sources: string[] = [], operation = row('op').id) {
    check(ops.length <= 200, '单次最多200行');
    if (ai)
        check(def.ai && !def.deleted, '此表未允许 AI 填写');
    const valid = await statuses(lib, view);
    check(sources.every(s => valid.get(s) === 'valid'), '所选来源无效');
    for (const op of ops) {
        validateCells(def, op.values, ai);
        check(!ai || !op.delete, 'AI 不允许删除整行（可能含人工字段）');
    }
    const digest = await fingerprint([view.branch.id, def.id, def.version, ops, ai, sources]);
    await lib.transaction(['branches', 'custom_table_defs', 'custom_table_rows', 'table_receipts'], 'readwrite', async (tx) => {
        const previous = await tx.get<any>('table_receipts', operation);
        if (previous) {
            check(previous.fingerprint === digest, '填表操作ID冲突');
            return;
        }
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(branch && branch.epoch === view.branch.epoch, '迟到填表结果已拒绝');
        const stored = await tx.get<TableDef>('custom_table_defs', def.id);
        check(stored && stored.version === def.version && !stored.deleted, '表定义已改变');
        for (const op of ops) {
            let record = op.row_id ? await tx.get<TableRow>('custom_table_rows', op.row_id) : undefined;
            check(!op.row_id || (record && record.owner === def.id && !record.deleted), '行不存在或不属于选定表');
            record ??= { ...row('row'), owner: def.id, story: def.story, branch: def.branch, values: {}, version: 0, deleted: false, sources: [] };
            const values = { ...record.values };
            for (const [key, value] of Object.entries(op.values)) {
                const column = def.columns.find(c => c.id === key)!;
                values[key] = ai && column.mode === 'append' && values[key] ? `${values[key]}\n${value}` : value;
            }
            await tx.put('custom_table_rows', { ...record, values, deleted: !!op.delete, version: record.version + 1, sources } as TableRow);
        }
        await tx.add('table_receipts', { id: operation, schema: 1, branch: def.branch, story: def.story, owner: def.id,
            sources, snapshot: view.snapshot.id, result: 'success', count: ops.length, fingerprint: digest } as any);
        branch.epoch++;
        await tx.put('branches', branch);
    });
}
export async function tablePrompt(lib: Library, view: CapturedView, def: TableDef, selected: string[], maxChars: number): Promise<string> {
    check(def.ai && selected.length > 0, '请允许AI并选择来源范围');
    const validity = await statuses(lib, view);
    const memories = selected.map(id => {
        const m = view.memories.find(m => m.id === id);
        check(m && validity.get(id) === 'valid', '选定摘要不合法');
        return m;
    });
    const rows = (await lib.all<TableRow>('custom_table_rows', 'owner', def.id)).filter(r => !r.deleted)
        .map(r => ({ row_id: r.id, values: Object.fromEntries(Object.entries(r.values).filter(([id]) => def.columns.some(c => c.id === id))) }));
    const prompt = `仅填写选定自定义表。manual字段不能写；append字段仅输出要追加的新内容；replace覆盖。不得删行，不得写其他表。
允许无变化返回{"operations":[]}。严格JSON：{"operations":[{"row_id":null,"values":{"字段ID":"值"}}]}。
新行row_id为null，旧行必须使用提供的ID。类型严格遵守表定义。不执行任何代码。
表定义：${JSON.stringify(def)}\n当前行：${JSON.stringify(rows)}\n选定摘要：${JSON.stringify(memories.map(m => ({ id: m.id, text: m.content, source_declaration: m.declaration })))}`;
    check(prompt.length <= maxChars, '表定义/已有行/选定材料超预算，未截断已有行');
    check(await current(lib, view), '视图已改变');
    return prompt;
}
export function parseTableOutput(raw: string): TableOperation[] {
    const value = parseStrictJson(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as any;
    check(value && Array.isArray(value.operations), '缺少 operations；不视为无变化');
    for (const op of value.operations)
        check(op && (op.row_id === null || typeof op.row_id === 'string') && op.values && !op.delete, '非法填表操作');
    return value.operations;
}
