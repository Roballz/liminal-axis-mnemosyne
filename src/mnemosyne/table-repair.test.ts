import { expect, test } from 'vitest';
import { fixture } from './fixtures';
import { capture, statuses } from './canonical';
import { newTable, saveTable, applyRows, tableInjectionProjection } from './tables';
import type { TableDef, TableRow } from './model';

test('diagnostics match omitted rows; manual confirmation persists, rejects stale edits and preserves history', async () => {
  const f = await fixture(2);
  try {
    let view = await capture(f.lib, f.branch.id);
    const def = newTable(view, '合成表');
    def.columns = [{ id: 'key', name: '名称', type: 'text', mode: 'replace', description: '' }];
    await saveTable(f.lib, view, def);
    view = await capture(f.lib, f.branch.id);
    const stored = (await f.lib.get<TableDef>('custom_table_defs', def.id))!;
    await applyRows(f.lib, view, stored, [
      { row_id: null, values: { key: 'S-001' } }, { row_id: null, values: { key: 'S-002' } },
      { row_id: null, values: { key: 'S-003' } }, { row_id: null, values: { key: 'S-004' }, hidden: true },
    ], false);
    const rows = await f.lib.all<TableRow>('custom_table_rows', 'owner', def.id);
    const byKey = new Map(rows.map(r => [r.values.key, r]));
    const bad = byKey.get('S-002')!, body = byKey.get('S-003')!;
    bad.sources = ['missing-summary'];
    body.bodySources = [{ ...view.refs[0], revision: 'old-body' }];
    await f.lib.transaction(['custom_table_rows'], 'readwrite', async tx => {
      await tx.put('custom_table_rows', bad); await tx.put('custom_table_rows', body);
    });
    view = await capture(f.lib, f.branch.id);
    const projection = await tableInjectionProjection(f.lib, view, await statuses(f.lib, view));
    expect(projection.tableIssues.size).toBe(2);
    expect(projection.tableIssues.get(bad.id)?.reason).toContain('摘要');
    expect(projection.tableIssues.get(body.id)?.reason).toContain('正文');
    expect(projection.tableText).toContain('S-001');
    for (const key of ['S-002', 'S-003', 'S-004']) expect(projection.tableText).not.toContain(key);
    for (const record of [bad, body]) {
      view = await capture(f.lib, f.branch.id);
      const latest = (await f.lib.get<TableDef>('custom_table_defs', def.id))!;
      await applyRows(f.lib, view, latest, [{ row_id: record.id, values: record.values, expectedVersion: record.version }], false);
      const saved = (await f.lib.get<TableRow>('custom_table_rows', record.id))!;
      expect(saved.values).toEqual(record.values);
      expect(saved.sources).toEqual([]);
      expect(saved.bodySources ?? []).toEqual([]);
      view = await capture(f.lib, f.branch.id);
      await expect(applyRows(f.lib, view, latest, [{ row_id: record.id, values: record.values, expectedVersion: record.version }], false)).rejects.toThrow('此行已被更新');
    }
    view = await capture(f.lib, f.branch.id);
    const repaired = await tableInjectionProjection(f.lib, view, await statuses(f.lib, view));
    expect(repaired.tableIssues.size).toBe(0);
    expect(repaired.tableText).toContain('S-002'); expect(repaired.tableText).toContain('S-003');
    expect(repaired.tableText).not.toContain('S-004');
    expect((await f.lib.all('table_history', 'branch', view.branch.id)).length).toBeGreaterThan(1);
  } finally { f.lib.close(); }
});
