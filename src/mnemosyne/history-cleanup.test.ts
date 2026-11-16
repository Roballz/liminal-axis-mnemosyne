import { test, expect, vi } from 'vitest';
import { fixture, batchFixture, output, withoutTableHistory } from './fixtures';
import { capture, forkBranch, synchronize } from './canonical';
import { exportLibrary, restoreLibrary } from './migration';
import { cleanLibraryHistory } from './history-cleanup';
import { commitEventBatch, eventView } from './events';
import { Transaction } from './db';
import { sourceSyncBaseline } from './source-sync-guard';
import { fingerprint } from './model';

test('existing repeated replacements compact to current content and stay compact on later edits', async () => {
    const { lib, input, branch } = await fixture(1);
    for (let i = 0; i < 20; i++) {
        input.messages[1].content = `corrected story ${i}`;
        input.memories[0].content = `corrected summary ${i} ${'summary '.repeat(120)}`;
        await synchronize(lib, input);
    }
    expect(await lib.all('memory_revisions')).toHaveLength(21);
    const report = await cleanLibraryHistory(lib, async () => true);
    expect(report.removed.memory_revisions).toBe(20);
    expect(report.removed.memory_views).toBe(20);
    expect(report.afterBytes).toBeLessThan(report.beforeBytes / 2);
    expect(await lib.all('memory_selection_nodes')).toHaveLength(1);
    expect(await lib.all('source_revisions')).toHaveLength(2);
    expect(await lib.all('history_snapshots')).toHaveLength(1);
    expect((await capture(lib, branch.id)).memories[0].content).toBe(input.memories[0].content);
    const restored = await restoreLibrary(await exportLibrary(lib), false);
    expect((await capture(restored, branch.id)).memories[0].content).toBe(input.memories[0].content);
    const read = vi.spyOn(Transaction.prototype, 'rawAll');
    input.messages[1].content = 'edit after cleanup'; input.memories[0].content = 'summary after cleanup';
    await synchronize(lib, input, { ...await sourceSyncBaseline(lib, input), retireHistory: true, isCurrent: () => true });
    expect(read.mock.calls.some(([store]) => store === 'memory_payloads')).toBe(false);
    read.mockRestore();
    expect(await lib.all('memory_revisions')).toHaveLength(1);
    expect(await lib.all('memory_selection_nodes')).toHaveLength(1);
    expect(await lib.all('memory_payloads')).toHaveLength(0);
    await exportLibrary(lib);
    restored.close(); lib.close();
});

test('cleanup removes superseded event evidence while preserving a child using the original content', async () => {
    const { lib, input, branch, batch } = await batchFixture(2);
    await commitEventBatch(lib, batch, output(batch));
    const child = await forkBranch(lib, await capture(lib, branch.id), 'independent child');
    const original = await capture(lib, child.id), originalEvents = await eventView(lib, original);
    input.messages[3].content = 'changed parent story'; input.memories[1].content = 'changed parent summary';
    await synchronize(lib, input);
    await cleanLibraryHistory(lib, async () => true);
    const after = await capture(lib, child.id);
    expect([...after.sources]).toEqual([...original.sources]);
    expect(after.memories.map(m => m.content)).toEqual(original.memories.map(m => m.content));
    expect((await eventView(lib, after)).cards.map(c => c.meta.overview)).toEqual(originalEvents.cards.map(c => c.meta.overview));
    expect((await eventView(lib, await capture(lib, branch.id))).cards[0].progress).toHaveLength(0);
    await exportLibrary(lib); lib.close();
});

test('cleanup detects a concurrent write before committing any deletion', async () => {
    const { lib, input } = await fixture(1);
    input.memories[0].content = 'new summary'; await synchronize(lib, input);
    let wrote = false;
    const before = (await exportLibrary(lib)).data;
    await expect(cleanLibraryHistory(lib, async () => {
        if (!wrote) { wrote = true; return true; }
        if (wrote && !(await lib.get('library_meta', 'daily-settings'))) {
            await lib.transaction(['library_meta'], 'readwrite', tx => tx.put('library_meta', { id: 'daily-settings', schema: 1, value: {} } as any));
        }
        return true;
    })).rejects.toThrow('已改变');
    const after = (await lib.transaction(['memory_revisions', 'memory_views'], 'readonly', async tx => ({
        revisions: await tx.rawAll('memory_revisions'), views: await tx.rawAll('memory_views'),
    })));
    expect(after.revisions).toEqual(before.memory_revisions); expect(after.views).toEqual(before.memory_views);
    lib.close();
});

test('old packages with inline source text and predecessor chains clean up without losing a child source', async () => {
    const { lib, input, branch } = await fixture(2);
    const child = await forkBranch(lib, await capture(lib, branch.id), 'legacy-child');
    const legacy = withoutTableHistory(await exportLibrary(lib)); legacy.version = 10;
    const { checksum: _checksum, ...base } = legacy; legacy.checksum = await fingerprint(base);
    const restored = await restoreLibrary(legacy, false);
    const before = await capture(restored, child.id);
    input.messages[3].content = 'current parent text'; input.memories[1].content = 'current parent summary';
    await synchronize(restored, input);
    await cleanLibraryHistory(restored, async () => true);
    const pack = await exportLibrary(restored);
    expect(pack.data.source_revisions.every(r => !('content' in r))).toBe(true);
    expect(pack.data.history_snapshots.every((r: any) => r.previous === null && r.snapshotSchema === 2)).toBe(true);
    expect((await capture(restored, child.id)).memories.map(m => m.content)).toEqual(before.memories.map(m => m.content));
    expect([...(await capture(restored, child.id)).sources.values()].map(s => s.content)).toEqual([...before.sources.values()].map(s => s.content));
    restored.close(); lib.close();
});
