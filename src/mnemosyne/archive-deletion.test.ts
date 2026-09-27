import { test, expect } from 'vitest';
import { fixture, observation } from './fixtures';
import { capture, forkBranch, synchronize } from './canonical';
import { editEvent, eventView } from './events';
import { exportLibrary, restoreLibrary } from './migration';
import { archiveDeletionChoices, previewArchiveDeletion, commitArchiveDeletion, archiveWasDeleted, allowArchiveCreation } from './archive-deletion';
import { newTable, saveTable } from './tables';
import { STORES } from './model';

test('delete exactly one archive, preserve another story, and persist the no-recreate marker through export', async () => {
    const { lib, branch, view, input } = await fixture(1);
    await editEvent(lib, view, null, { title: '待删事件', status: 'open', keywords: [] });
    const tableView = await capture(lib, branch.id);
    await saveTable(lib, tableView, newTable(tableView, '待删表'));
    const other = await synchronize(lib, observation(1, 'other-story'));
    const retained = await capture(lib, other.id);
    expect(await archiveDeletionChoices(lib)).toHaveLength(2);
    const plan = await previewArchiveDeletion(lib, branch.id);
    expect(plan).toMatchObject({ branches: [branch.id], events: 1, summaries: 1, messages: 2, tables: 1 });
    await commitArchiveDeletion(lib, plan, () => true);
    expect(await lib.get('branches', branch.id)).toBeUndefined();
    expect(await capture(lib, other.id)).toEqual(retained);
    expect(await lib.all('event_chains')).toEqual([]);
    expect(await lib.all('stories')).toHaveLength(1);
    expect(await archiveWasDeleted(lib, input.scope)).toBe(true);
    expect(await archiveWasDeleted(lib, 'other-story')).toBe(false);
    const restored = await restoreLibrary(await exportLibrary(lib), false);
    expect(await archiveWasDeleted(restored, input.scope)).toBe(true);
    await allowArchiveCreation(restored, input.scope);
    expect(await archiveWasDeleted(restored, input.scope)).toBe(false);
    restored.close(); lib.close();
});

test('parent deletion is blocked, deleting a child preserves parent and sibling including shared sources', async () => {
    const { lib, branch, view } = await fixture(1);
    await editEvent(lib, view, null, { title: '原事件', status: 'open', keywords: [] });
    const parent = await capture(lib, branch.id);
    const child = await forkBranch(lib, parent, 'child');
    const sibling = await forkBranch(lib, parent, 'sibling');
    const siblingBefore = await capture(lib, sibling.id);
    const before = await exportLibrary(lib);
    await expect(previewArchiveDeletion(lib, branch.id)).rejects.toThrow('子分支依赖');
    expect((await exportLibrary(lib)).data).toEqual(before.data);
    await commitArchiveDeletion(lib, await previewArchiveDeletion(lib, child.id), () => true);
    expect(await capture(lib, branch.id)).toEqual(parent);
    expect(await capture(lib, sibling.id)).toEqual(siblingBefore);
    expect((await eventView(lib, siblingBefore)).cards).toHaveLength(1);
    const restored = await restoreLibrary(await exportLibrary(lib), false); restored.close();
    lib.close();
});

test('stale preview and cancelled delete roll back every store; last archive can be deleted cleanly', async () => {
    const { lib, branch, view } = await fixture(1);
    const stale = await previewArchiveDeletion(lib, branch.id);
    await editEvent(lib, view, null, { title: '预览后新增', status: 'open', keywords: [] });
    await expect(commitArchiveDeletion(lib, stale, () => true)).rejects.toThrow('档案已改变');
    const plan = await previewArchiveDeletion(lib, branch.id);
    let checks = 0;
    await expect(commitArchiveDeletion(lib, plan, () => ++checks < 2)).rejects.toThrow('撤销');
    expect((await exportLibrary(lib)).data).toEqual(plan.before.data);
    await commitArchiveDeletion(lib, plan, () => true);
    for (const store of STORES.filter(s => s !== 'library_meta')) expect(await lib.all(store)).toEqual([]);
    const restored = await restoreLibrary(await exportLibrary(lib), false); restored.close(); lib.close();
});


test('deleting a detached mistaken archive does not pause the other archive now bound to that name', async () => {
    const { lib, branch, input } = await fixture(1);
    const binding = (await lib.all<any>('host_bindings'))[0];
    await lib.transaction(['host_bindings'], 'readwrite', tx => tx.put('host_bindings', { ...binding, rebindSchema: 1, detached: true }));
    const replacement = await synchronize(lib, input);
    const before = await capture(lib, replacement.id);
    const plan = await previewArchiveDeletion(lib, branch.id);
    expect(plan.scopes).toEqual([]);
    await commitArchiveDeletion(lib, plan, () => true);
    expect(await archiveWasDeleted(lib, input.scope)).toBe(false);
    expect(await capture(lib, replacement.id)).toEqual(before);
    const restored = await restoreLibrary(await exportLibrary(lib), false); restored.close(); lib.close();
});
