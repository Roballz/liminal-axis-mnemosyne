import { test, expect, vi } from 'vitest';
import { fixture, batchFixture, output } from './fixtures';
import { newTable, saveTable, applyRows, tablePrompt, parseTableOutput } from './tables';
import { capture } from './canonical';
import { commitEventBatch } from './events';
import { exportLibrary, restoreLibrary } from './migration';
import { ACTIVE_KEY, activateLibrary } from './db';
import { fingerprint, type TableDef, type TableRow } from './model';
async function tableFixture() {
    const f = await fixture(2);
    const def = newTable(f.view, '合成约定表');
    def.columns = [{ id: 'manual', name: '人工备注', type: 'text', mode: 'manual', description: '' },
        { id: 'append', name: '进展', type: 'text', mode: 'append', description: '' }, { id: 'number', name: '次数', type: 'number', mode: 'replace', description: '' }];
    def.ai = true;
    await saveTable(f.lib, f.view, def);
    const stored = (await f.lib.get<TableDef>('custom_table_defs', def.id))!;
    return { ...f, view: await capture(f.lib, f.branch.id), def: stored };
}
test('new tables and fields are ordinary data writes, never physical schema upgrades', async () => {
    const { lib, view, def, branch } = await tableFixture();
    const version = lib.db.version;
    def.columns.push({ id: 'extra', name: '新增字段', type: 'boolean', mode: 'replace', description: '' });
    await saveTable(lib, view, def);
    const current = await capture(lib, branch.id);
    await saveTable(lib, current, newTable(current, '第二张表'));
    expect(lib.db.version).toBe(version);
    expect(await lib.all('custom_table_defs')).toHaveLength(2);
    lib.close();
});
test('AI manual field mutation and whole-row deletion are rejected', async () => {
    const { lib, view, def } = await tableFixture();
    await expect(applyRows(lib, view, def, [{ row_id: null, values: { manual: 'AI越权' } }], true)).rejects.toThrow('禁止 AI');
    await expect(applyRows(lib, view, def, [{ row_id: null, values: {}, delete: true }], true)).rejects.toThrow('不允许删除');
    expect(await lib.all('custom_table_rows')).toHaveLength(0);
    lib.close();
});
test('manual CRUD, AI append and replace preserve manual cells', async () => {
    const { lib, view, def, branch } = await tableFixture();
    await applyRows(lib, view, def, [{ row_id: null, values: { manual: '人工保留', append: '初始', number: 1 } }], false);
    let v = await capture(lib, branch.id);
    let r = (await lib.all<TableRow>('custom_table_rows'))[0];
    await applyRows(lib, v, def, [{ row_id: r.id, values: { append: '新增', number: 2 } }], true, [v.memories[0].id]);
    r = (await lib.all<TableRow>('custom_table_rows'))[0];
    expect(r.values).toEqual({ manual: '人工保留', append: '初始\n新增', number: 2 });
    v = await capture(lib, branch.id);
    await applyRows(lib, v, def, [{ row_id: r.id, values: {}, delete: true }], false);
    expect((await lib.get<TableRow>('custom_table_rows', r.id))?.deleted).toBe(true);
    lib.close();
});
test('AI schema validation rejects unknown fields, wrong types and invented rows', async () => {
    const { lib, view, def } = await tableFixture();
    await expect(applyRows(lib, view, def, [{ row_id: null, values: { unknown: 'x' } }], true)).rejects.toThrow('未知字段');
    await expect(applyRows(lib, view, def, [{ row_id: null, values: { number: '2' } }], true)).rejects.toThrow('类型错误');
    await expect(applyRows(lib, view, def, [{ row_id: 'invented', values: { number: 2 } }], true)).rejects.toThrow('行不存在');
    expect(await lib.all('custom_table_rows')).toHaveLength(0);
    lib.close();
});
test('explicit no changes is successful and idempotently receipted', async () => {
    const { lib, view, def } = await tableFixture();
    const ops = parseTableOutput('{"operations":[]}');
    await applyRows(lib, view, def, ops, true, [], 'test-operation');
    await applyRows(lib, view, def, ops, true, [], 'test-operation');
    expect(await lib.all('table_receipts')).toHaveLength(1);
    expect(await lib.all('custom_table_rows')).toHaveLength(0);
    expect(() => parseTableOutput('{}')).toThrow('缺少');
    lib.close();
});
test('schema or row edits while an AI request runs reject its stale result', async () => {
    const { lib, view, def } = await tableFixture();
    await applyRows(lib, view, def, [{ row_id: null, values: { number: 5 } }], false);
    await expect(applyRows(lib, view, def, [{ row_id: null, values: { number: 6 } }], true)).rejects.toThrow('迟到');
    lib.close();
});
test('table AI input includes selected range, definition and existing rows; budget does not silently truncate', async () => {
    const { lib, view, def, branch } = await tableFixture();
    await applyRows(lib, view, def, [{ row_id: null, values: { manual: '可见人工参考' } }], false);
    const v = await capture(lib, branch.id);
    const prompt = await tablePrompt(lib, v, def, [v.memories[0].id], 48000);
    expect(prompt).toContain(def.name);
    expect(prompt).toContain('可见人工参考');
    expect(prompt).toContain(v.memories[0].content);
    expect(prompt).not.toContain(v.memories[1].content);
    await expect(tablePrompt(lib, v, def, [v.memories[0].id], 10)).rejects.toThrow('超预算');
    lib.close();
});
test('removed column cells stay archived but no longer enter AI input', async () => {
    const { lib, view, def, branch } = await tableFixture();
    await applyRows(lib, view, def, [{ row_id: null, values: { manual: '被移除字段旧值' } }], false);
    let v = await capture(lib, branch.id);
    def.columns = def.columns.filter(c => c.id !== 'manual');
    await saveTable(lib, v, def);
    v = await capture(lib, branch.id);
    const d = (await lib.get<TableDef>('custom_table_defs', def.id))!;
    expect(await tablePrompt(lib, v, d, [v.memories[0].id], 48000)).not.toContain('被移除字段旧值');
    expect((await lib.all<TableRow>('custom_table_rows'))[0].values.manual).toBe('被移除字段旧值');
    lib.close();
});
test('round-trip into a new empty DB preserves all IDs, bodies, events, receipts and custom rows', async () => {
    const { lib, batch, branch } = await batchFixture();
    await commitEventBatch(lib, batch, output(batch));
    let v = await capture(lib, branch.id);
    const def = newTable(v, '可迁移表');
    def.columns = [{ id: 'name', name: '名称', type: 'text', description: '', mode: 'manual' }];
    await saveTable(lib, v, def);
    v = await capture(lib, branch.id);
    const saved = (await lib.get<TableDef>('custom_table_defs', def.id))!;
    await applyRows(lib, v, saved, [{ row_id: null, values: { name: '合成记录' } }], false);
    const pack = await exportLibrary(lib);
    const restored = await restoreLibrary(pack, false);
    const after = await exportLibrary(restored);
    expect(after.data).toEqual(pack.data);
    expect(after.counts).toEqual(pack.counts);
    expect(restored.db.name).not.toBe(lib.db.name);
    expect(pack.excluded).toContain('api-secrets');
    expect(pack.excluded).toContain('knowledge-files-and-vectors');
    lib.close();
    restored.close();
});
test('missing references and tampering fail even with recalculated checksums, leaving active library unchanged', async () => {
    const { lib } = await fixture();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k), setItem: (k: string, v: string) => storage.set(k, v) });
    await activateLibrary(lib);
    const name = storage.get(ACTIVE_KEY);
    try {
        const pack = await exportLibrary(lib);
        pack.data.source_revisions.pop();
        pack.counts.source_revisions--;
        const { checksum, ...base } = pack;
        pack.checksum = await fingerprint(base);
        await expect(restoreLibrary(pack)).rejects.toThrow('引用缺失');
        expect(storage.get(ACTIVE_KEY)).toBe(name);
    }
    finally {
        vi.unstubAllGlobals();
        lib.close();
    }
});
test('bad count, checksum and secret settings are rejected before opening replacement', async () => {
    const { lib } = await fixture();
    let pack = await exportLibrary(lib);
    pack.counts.stories++;
    await expect(restoreLibrary(pack, false)).rejects.toThrow('计数');
    pack = await exportLibrary(lib);
    pack.checksum = 'corrupt';
    await expect(restoreLibrary(pack, false)).rejects.toThrow('校验和');
    pack = await exportLibrary(lib);
    pack.data.library_meta.push({ id: 'daily-settings', schema: 1, value: { apiKey: 'SYNTHETIC_NOT_A_SECRET' } } as any);
    pack.counts.library_meta++;
    await expect(restoreLibrary(pack, false)).rejects.toThrow('白名单');
    lib.close();
});
test('cross-story selections are rejected as domain corruption rather than repaired', async () => {
    const { lib } = await fixture();
    const pack = await exportLibrary(lib);
    const view = pack.data.memory_views[0] as any;
    view.selections.invented_family = Object.values(view.selections)[0];
    await expect(restoreLibrary(pack, false)).rejects.toThrow('摘要选择错误');
    lib.close();
});
