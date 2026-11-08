import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { capture, statuses, synchronize } from './canonical';
import { Transaction } from './db';
import { newTable, allowedTableSources, renderTableState, summaryTablesPrompt, type TableInput } from './tables';
import { sortTableRows } from './table-order';
import type { TableDef, TableRow } from './model';

afterEach(() => vi.restoreAllMocks());

function definition(branch = { id: 'branch', story: 'story' }): TableDef {
    const def = newTable({ branch } as any, '排序与来源测试');
    def.columns = [
        { id: 'key', name: '名称', type: 'text', mode: 'replace', description: '' },
        { id: 'detail', name: '内容', type: 'text', mode: 'replace', description: '' },
    ];
    return def;
}
function record(def: TableDef, id: string, key: string | number | boolean | undefined, sources: string[] = []): TableRow {
    return { id, schema: 1, story: def.story, branch: def.branch, owner: def.id, version: 1,
        deleted: false, sources, values: { ...(key === undefined ? {} : { key }), detail: `完整内容 ${id}` } };
}

test.each([
    { keys: ['S-10', 'S-2', 'S-1'], expected: ['S-1', 'S-2', 'S-10'] },
    { keys: ['S-010', 'S-002', 'S-001'], expected: ['S-001', 'S-002', 'S-010'] },
    { keys: [-2, 10, -10, 0], expected: [-10, -2, 0, 10] },
    { keys: [true, false], expected: [false, true] },
])('first-column names sort naturally without mutating keys or input: $keys', ({ keys, expected }) => {
    const def = definition(), rows = keys.map((key, i) => record(def, String(i), key));
    const before = structuredClone(rows);
    expect(sortTableRows(def, rows).map(row => row.values.key)).toEqual(expected);
    expect(rows).toEqual(before);
});

test('legacy empty names sort last and equal names keep deterministic distinct rows', () => {
    const def = definition();
    const rows = [record(def, 'empty', undefined), record(def, 'b', 'S-1'), record(def, 'blank', ' '),
        record(def, 'a', 'S-1'), record(def, 'padded', 'S-01')];
    const sorted = sortTableRows(def, rows);
    expect(sorted.map(row => row.id)).toEqual(['padded', 'a', 'b', 'blank', 'empty']);
    expect(sortTableRows(def, rows.slice().reverse()).map(row => row.id)).toEqual(sorted.map(row => row.id));
    expect(sorted).toHaveLength(rows.length);
});

test('main and summary serialization send every visible row in name order beyond one UI page', () => {
    const def = definition();
    const names = Array.from({ length: 25 }, (_, i) => `S-${String(i + 1).padStart(3, '0')}`);
    const rows = names.slice().reverse().map((key, i) => record(def, String(i), key));
    const hidden = { ...record(def, 'hidden', 'S-000'), hidden: true };
    const deleted = { ...record(def, 'deleted', 'S-026'), deleted: true };
    const text = renderTableState([{ def, rows: [hidden, ...rows, deleted] }]);
    expect(text.split('\n').filter(line => line.startsWith('- 名称: ')).map(line => line.split('；')[0]))
        .toEqual(names.map(name => '- 名称: ' + name));
    expect(text).not.toContain('S-000'); expect(text).not.toContain('S-026');
    for (const row of rows) expect(text).toContain(row.values.detail);
    const prompt = summaryTablesPrompt([{ def, rows }]);
    const payload = JSON.parse(prompt.user.slice(prompt.user.indexOf('[{')));
    expect(payload[0].rows.map((row: any) => row.values['名称'])).toEqual(names);
    expect(payload[0].rows.at(-1).values['内容']).toBe(rows[0].values.detail);
});

test('shared old tag revisions are resolved once, survive compression, and never change stored provenance', async () => {
    const f = await fixture(2);
    try {
        const def = definition(f.branch), old = f.view.memories[0];
        const inputs: TableInput[] = [{ def, rows: Array.from({ length: 200 }, (_, i) =>
            record(def, String(i), `S-${String(200 - i).padStart(3, '0')}`, [old.id])) }];
        f.input.memories[0].tags = { version: 1, planIds: [], eventIds: ['event-tag'] };
        f.input.memories.push({ hostId: 'high', content: '合并摘要', level: 1, anchorKey: null,
            children: f.input.memories.map(memory => memory.hostId), storyTime: '', seed: false, enabled: true });
        await synchronize(f.lib, f.input);
        const view = await capture(f.lib, f.branch.id), validity = await statuses(f.lib, view);
        const next = view.memories.find(memory => memory.owner === old.owner)!;
        expect(next.id).not.toBe(old.id); expect(validity.get(next.id)).toBe('valid');
        const get = vi.spyOn(Transaction.prototype, 'get'), all = vi.spyOn(Transaction.prototype, 'all');
        const allowed = await allowedTableSources(f.lib, view, inputs, validity);
        expect(get.mock.calls).toEqual([['memory_revisions', old.id]]);
        expect(all).not.toHaveBeenCalled();
        expect(renderTableState(inputs, allowed).split('\n').filter(line => line.startsWith('- '))).toHaveLength(200);
        expect(inputs[0].rows.every(row => row.sources.length === 1 && row.sources[0] === old.id)).toBe(true);
        get.mockClear();
        await allowedTableSources(f.lib, view, [{ def, rows: [record(def, 'current', 'S-001', [next.id])] }], validity);
        expect(get).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled();
    } finally { f.lib.close(); }
});

test.each(['summary-edit', 'body-edit', 'disabled', 'private', 'removed', 'other-invalid-source'] as const)
('tag equivalence does not admit a table row with %s', async kind => {
    const f = await fixture(2);
    try {
        const def = definition(f.branch), old = f.view.memories[0];
        const sources = [old.id];
        f.input.memories[0].tags = { version: 1, planIds: [], eventIds: ['changed-tag'] };
        if (kind === 'summary-edit') f.input.memories[0].content += '剧情事实改变';
        if (kind === 'body-edit') f.input.messages[0].content += '正文改变';
        if (kind === 'disabled') f.input.memories[0].enabled = false;
        if (kind === 'private') f.input.memories[0].private = true;
        if (kind === 'removed') f.input.memories.shift();
        if (kind === 'other-invalid-source') {
            sources.push(f.view.memories[1].id);
            f.input.memories[1].content += '另一来源已改变';
        }
        await synchronize(f.lib, f.input);
        const view = await capture(f.lib, f.branch.id), validity = await statuses(f.lib, view);
        const inputs = [{ def, rows: [record(def, 'excluded', '应排除的整行', sources),
            record(def, 'manual', '手动无来源行')] }];
        const allowed = await allowedTableSources(f.lib, view, inputs, validity);
        const text = renderTableState(inputs, allowed);
        expect(text).not.toContain('应排除的整行'); expect(text).toContain('手动无来源行');
        if (kind === 'other-invalid-source') expect(allowed.has(old.id)).toBe(true);
    } finally { f.lib.close(); }
});
