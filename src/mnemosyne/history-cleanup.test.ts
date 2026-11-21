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

test('manual source prefixes compact losslessly, including after a v18/v19 restore, repeat cleanup and deletion', async () => {
    const { lib, view, branch } = await fixture(6);
    const { statuses } = await import('./canonical');
    const { exportArchive, restoreArchive } = await import('./archive-package');
    const { commitArchiveDeletion, previewArchiveDeletion } = await import('./archive-deletion');
    const { commitManualEvent } = await import('./manual-events');
    const declaration = '人工修订摘要：以当前来源版本确认内容；原生成版本保留。';
    const prefix = { ...view.memories.at(-1)!, inputRefs: view.refs, declaration };
    const subset = { ...view.memories[2], inputRefs: [view.refs[0], view.refs[5]], declaration };
    const generated = { ...view.memories[1], inputRefs: view.refs.slice(0, 4) };
    try {
        await lib.transaction(['memory_revisions'], 'readwrite', async tx => {
            for (const item of [prefix, subset, generated]) await tx.put('memory_revisions', item);
        });
        let captured = await capture(lib, branch.id);
        const event = await commitManualEvent(lib, captured, null, [prefix.id], JSON.stringify({
            title: '手改摘要', status: 'open', keywords: ['关键词'], overview: '原概要', progress: '进展',
            latestProgress: { text: '最新进展', memory: prefix.id },
        }), () => true);
        captured = await capture(lib, branch.id);
        const oldArchive = await exportArchive(lib, branch.id);
        expect(oldArchive.pack.version).toBe(18);
        const beforeStates = await statuses(lib, captured);
        expect((await cleanLibraryHistory(lib, async () => true)).compactedPrefixes).toBe(1);
        const pack = await exportLibrary(lib);
        expect(pack.version).toBe(19);
        expect(pack.data.memory_revisions.find(m => m.id === prefix.id)).toMatchObject({ sharedSchema: 2, inputRefs: 12 });
        for (const original of [prefix, subset, generated]) expect(await lib.get('memory_revisions', original.id)).toEqual(original);
        expect((await cleanLibraryHistory(lib, async () => true)).compactedPrefixes).toBe(0);

        const archive = await exportArchive(lib, branch.id), restored = await restoreLibrary(pack, false);
        try {
            for (const source of [oldArchive, archive]) {
                await restoreArchive(restored, source, async () => true);
                const current = await capture(restored, branch.id);
                expect(await statuses(restored, current)).toEqual(beforeStates);
                expect(await restored.get('memory_revisions', prefix.id)).toEqual(prefix);
                const card = (await eventView(restored, current)).cards.find(c => c.chain.id === event)!;
                expect(card.members.map(m => m.memory)).toEqual([prefix.id]);
                expect(card.meta).toMatchObject({ overview: '原概要', keywords: ['关键词'], latestProgress: { memory: prefix.id, text: '最新进展' } });
            }
            await commitArchiveDeletion(restored, await previewArchiveDeletion(restored, branch.id), () => true);
            expect(await restored.get('memory_revisions', prefix.id)).toBeUndefined();
        } finally { restored.close(); }
        const physical = pack.data.memory_revisions.find(m => m.id === prefix.id) as any;
        physical.inputRefs--;
        await expect(restoreLibrary(pack, false)).rejects.toThrow('前缀与楼层不符');
    } finally { lib.close(); }
});
