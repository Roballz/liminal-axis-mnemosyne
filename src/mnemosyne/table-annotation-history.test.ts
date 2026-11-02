import { test, expect } from 'vitest';
import { fixture } from './fixtures';
import { capture, synchronize } from './canonical';
import { newTable, saveTable, parseSummaryTables, readTables, commitSummaryTables } from './tables';
import { exportLibrary } from './migration';
import type { TableRow } from './model';

test.each(['annotation', 'body-edit', 'swipe', 'unverified'] as const)('table history accepts only proven annotation changes: %s', async kind => {
    const f = await fixture(1);
    try {
        const def = newTable(f.view, '来源表');
        def.columns = [{ id: 'key', name: '序号', type: 'text', mode: 'replace', description: '' }];
        await saveTable(f.lib, f.view, def);
        let view = await capture(f.lib, f.branch.id);
        const plan = parseSummaryTables([{ table_id: def.id, add: [{ key: '保留值' }], update: [] }],
            await readTables(f.lib, view.branch), f.branch.id)!;
        plan.tableHead = view.branch.tableHead;
        await commitSummaryTables(f.lib, view, plan, [], () => true, { start: 0, end: 1, refs: view.refs });
        view = await capture(f.lib, f.branch.id);
        const beforeHead = view.branch.tableHead;
        f.input.memories[0].inputRefs = view.refs;
        f.input.memories[0].basisSnapshot = view.snapshot.id;
        f.input.memories[0].generatedSidecar = kind !== 'unverified';
        f.input.messages[1].content += '\n<bbs_vars>\n设定：测试=1\n</bbs_vars>';
        if (kind === 'body-edit') f.input.messages[1].content = '真实剧情改了' + f.input.messages[1].content;
        if (kind === 'swipe') f.input.messages[1].swipe = 1;
        await synchronize(f.lib, f.input);
        const after = await capture(f.lib, f.branch.id);
        expect(after.branch.tableHead).not.toBe(beforeHead);
        const rows = (await readTables(f.lib, after.branch)).flatMap(t => t.rows);
        if (kind === 'annotation') {
            expect(rows.map(r => r.values.key)).toEqual(['保留值']);
            expect(rows[0].bodySources).toEqual(after.refs);
            const currentVersion = (await f.lib.get<any>('custom_table_defs', def.id)).dataVersion;
            f.input.messages.push({ key: 'next', content: '后续正文', role: 'user', swipe: 0 });
            await synchronize(f.lib, f.input);
            const appended = await capture(f.lib, f.branch.id);
            expect(appended.branch.tableHead).toBe(after.branch.tableHead);
            expect((await f.lib.get<any>('custom_table_defs', def.id)).dataVersion).toBe(currentVersion);
            expect((await f.lib.all<TableRow>('custom_table_rows')).filter(r => !r.deleted)).toHaveLength(1);
        } else expect(rows).toEqual([]);
        await expect(exportLibrary(f.lib)).resolves.toBeDefined();
    } finally { f.lib.close(); }
});
