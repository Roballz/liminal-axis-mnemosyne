import { test, expect, vi } from 'vitest';
import { fixture, batchFixture, output } from './fixtures';
import { capture, forkBranch, synchronize } from './canonical';
import { newTable, saveTable, applyRows, readTables } from './tables';
import { commitEventBatch, editEvent, eventView, setEventArchived } from './events';
import { cleanLibraryHistory } from './history-cleanup';
import { exportLibrary, restoreLibrary } from './migration';
import { exportArchive } from './archive-package';
import { Transaction } from './db';
import { sourceSyncBaseline } from './source-sync-guard';
import { TABLE_STORES, recordTableWrite } from './table-history';
import type { TableDef, TableCommit, EventRevision, Branch } from './model';
import { normalizeTags } from '@/memory/contextTags';

test('permanent table removal clears rows, receipts and all after-images without affecting sibling tables or child', async () => {
    const { lib, branch } = await fixture(2);
    const make = async (name: string) => {
        let view = await capture(lib, branch.id);
        const def = newTable(view, name); def.columns = [{ id: 'k', name: '名称', type: 'text', description: '', mode: 'replace' }];
        await saveTable(lib, view, def);
        view = await capture(lib, branch.id);
        const saved = (await lib.get<TableDef>('custom_table_defs', def.id))!;
        await applyRows(lib, view, saved, [{ row_id: null, values: { k: name } }], true, [view.memories[0].id]);
        return (await lib.get<TableDef>('custom_table_defs', def.id))!;
    };
    const deleted = await make('要删除'), kept = await make('要保留');
    const child = await forkBranch(lib, await capture(lib, branch.id), 'before-delete');
    const childTables = await readTables(lib, child);
    await saveTable(lib, await capture(lib, branch.id), { ...deleted, deleted: true });
    expect(await lib.get('custom_table_defs', deleted.id)).toBeUndefined();
    await expect(saveTable(lib, await capture(lib, branch.id), deleted)).rejects.toThrow('已删除');
    expect(await lib.all('custom_table_rows', 'owner', deleted.id)).toEqual([]);
    expect(await lib.all('table_receipts', 'owner', deleted.id)).toEqual([]);
    for (const h of await lib.all<TableCommit>('table_history', 'branch', branch.id)) {
        expect(h.defs.some(d => d.id === deleted.id)).toBe(false);
        expect(h.rows.some(r => r.owner === deleted.id)).toBe(false);
    }
    expect(await lib.get('custom_table_defs', kept.id)).toEqual(kept);
    expect(await readTables(lib, child)).toEqual(childTables);
    const later = await forkBranch(lib, await capture(lib, branch.id), 'after-delete');
    expect((await readTables(lib, later)).map(t => t.def.name)).toEqual(['要保留']);
    const restored = await restoreLibrary(await exportLibrary(lib), false);
    expect(await restored.get('custom_table_defs', deleted.id)).toBeUndefined();
    restored.close(); lib.close();
});

test('old soft-deleted tables never inherit and explicit cleanup physically removes their data', async () => {
    const { lib, branch, view } = await fixture(1), def = newTable(view, '旧版已删表');
    await saveTable(lib, view, def);
    const saved = (await lib.get<TableDef>('custom_table_defs', def.id))!;
    await lib.transaction(TABLE_STORES, 'readwrite', async tx => {
        const current = (await tx.get<Branch>('branches', branch.id))!, deleted = { ...saved, deleted: true };
        await tx.put('custom_table_defs', deleted); await recordTableWrite(tx, current, [deleted], [], 'old-soft-delete');
        current.epoch++; await tx.put('branches', current);
    });
    const child = await forkBranch(lib, await capture(lib, branch.id), 'legacy-deleted-table');
    expect(await lib.all('custom_table_defs', 'branch', child.id)).toEqual([]);
    await cleanLibraryHistory(lib, async () => true);
    expect(await lib.get('custom_table_defs', def.id)).toBeUndefined();
    await exportLibrary(lib); lib.close();
});

test('inherited archived event prose shares immutable payload and child edits leave parent unchanged', async () => {
    const { lib, branch, batch } = await batchFixture(3);
    await commitEventBatch(lib, batch, output(batch));
    const view = await capture(lib, branch.id), card = (await eventView(lib, view)).cards[0];
    const prose = '已结束事件的完整经过，保留父子分支共同剧情。'.repeat(30);
    await editEvent(lib, view, card.chain.id, { ...card.meta, overview: prose });
    await setEventArchived(lib, await capture(lib, branch.id), card.chain.id, true);
    const prior = (await exportLibrary(lib)).data;
    const payloads = new Set(prior.memory_payloads.map(r => r.id));
    const parentMeta = (await eventView(lib, await capture(lib, branch.id))).cards[0].meta;
    const parentRaw = prior.event_revisions.find(r => r.id === parentMeta.id) as any;
    expect(parentRaw.overview.shared).toBeTruthy();
    const child = await forkBranch(lib, await capture(lib, branch.id), 'shared-event-child');
    const childView = await capture(lib, child.id), childCard = (await eventView(lib, childView)).cards[0];
    const physical = await lib.transaction(['event_revisions'], 'readonly', tx => tx.rawGet<any>('event_revisions', childCard.meta.id));
    expect(physical.overview).toEqual(parentRaw.overview);
    expect(childCard.chain.archived).toBe(true);
    expect((await lib.all<any>('memory_payloads')).filter(p => p.kind === 'text' && p.value === prose)).toHaveLength(1);
    await editEvent(lib, childView, childCard.chain.id, { ...childCard.meta, overview: prose + '子分支补充' });
    expect((await eventView(lib, await capture(lib, branch.id))).cards[0].meta.overview).toBe(prose);
    const changed = (await eventView(lib, await capture(lib, child.id))).cards[0];
    const updated = await lib.transaction(['event_revisions'], 'readonly', tx => tx.rawGet<any>('event_revisions', changed.meta.id));
    expect(updated.overview.shared).not.toBe(parentRaw.overview.shared);
    expect(payloads.has(parentRaw.overview.shared)).toBe(true);
    const reads = vi.spyOn(Transaction.prototype, 'rawAll');
    const pack = await exportArchive(lib, child.id);
    expect(reads.mock.calls.every(([, index]) => !!index)).toBe(true);
    reads.mockRestore();
    expect(pack.pack.data.memory_payloads.some(r => r.id === updated.overview.shared)).toBe(true);
    await exportLibrary(lib); lib.close();
});

test('live body plus summary replacement retires related event evidence and old selection', async () => {
    const { lib, input, branch, batch } = await batchFixture(2);
    await commitEventBatch(lib, batch, output(batch));
    const old = batch.memories[1].id;
    input.memories[1].tags = normalizeTags({ participants: ['甲'] });
    await synchronize(lib, input, { ...await sourceSyncBaseline(lib, input), retireHistory: true, isCurrent: () => true });
    expect(await lib.get('memory_revisions', old)).toBeDefined(); // Still proves unchanged event prose after a tag-only edit.
    input.messages[3].content = '新的正文'; input.memories[1].content = '新的摘要';
    await synchronize(lib, input, { ...await sourceSyncBaseline(lib, input), retireHistory: true, isCurrent: () => true });
    expect(await lib.get('memory_revisions', old)).toBeUndefined();
    expect(await lib.all('memory_views', 'branch', branch.id)).toHaveLength(1);
    expect(await lib.all('event_processing_receipts', 'branch', branch.id)).toHaveLength(0);
    expect(await lib.all('event_progress', 'branch', branch.id)).toHaveLength(0);
    expect((await lib.all<EventRevision>('event_revisions', 'branch', branch.id)).every(r => !r.refs.includes(old))).toBe(true);
    await exportLibrary(lib); lib.close();
});
