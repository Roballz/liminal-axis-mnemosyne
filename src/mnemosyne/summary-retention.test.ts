import { test, expect, vi } from 'vitest';
import { fixture, observation } from './fixtures';
import { capture, forkBranch, statuses, synchronize, type HostObservation } from './canonical';
import { sourceSyncBaseline } from './source-sync-guard';
import { Library, freshLibraryName, Transaction } from './db';
import { exportLibrary } from './migration';
import { SHARED_META } from './shared-payloads';

const sync = async (lib: Library, input: HostObservation) => synchronize(lib, input,
    { ...await sourceSyncBaseline(lib, input), retireHistory: true, isCurrent: () => true });

test('twenty body and summary replacements retain only current revisions, view and storage nodes', async () => {
    const lib = await Library.open(freshLibraryName()), input = observation(1);
    await lib.transaction(['library_meta'], 'readwrite', tx => tx.put('library_meta', { id: SHARED_META, schema: 1, value: { version: 1 } } as any));
    lib.compactWrites = true;
    const first = await sync(lib, input);
    const sizes: number[] = [];
    for (let i = 0; i < 20; i++) {
        input.messages[1].content = `new body ${i}`;
        input.memories[0].content = `new summary ${i} ${'s'.repeat(700)}`;
        await sync(lib, input);
        sizes.push(JSON.stringify((await exportLibrary(lib)).data).length);
    }
    expect(await lib.all('memory_revisions')).toHaveLength(1);
    expect(await lib.all('memory_views')).toHaveLength(1);
    expect(await lib.all('memory_selection_nodes')).toHaveLength(1);
    expect(await lib.all('source_revisions')).toHaveLength(2);
    expect(await lib.all('history_snapshots')).toHaveLength(1);
    expect(sizes.at(-1)! - sizes[0]).toBeLessThan(200);
    expect((await capture(lib, first.id)).memories[0].content).toContain('new summary 19');
    lib.close();
});

test('replaced body retires its unchanged old summary and does not resurrect it on the next append', async () => {
    const { lib, input, branch } = await fixture(1);
    input.messages[1].content = 'corrected body';
    await sync(lib, input);
    expect((await capture(lib, branch.id)).memories).toHaveLength(0);
    input.memories[0].tags = { version: 1, participants: ['tag only'], planIds: [], eventIds: [] };
    await sync(lib, input);
    expect((await capture(lib, branch.id)).memories).toHaveLength(0);
    expect(await lib.all('memory_revisions')).toHaveLength(0);
    await sync(lib, input);
    expect((await capture(lib, branch.id)).memories).toHaveLength(0);
    input.memories[0].generationKey = 1;
    await sync(lib, input);
    expect((await capture(lib, branch.id)).memories[0].content).toBe(input.memories[0].content);
    input.memories[0].content = 'corrected summary';
    await sync(lib, input);
    expect((await capture(lib, branch.id)).memories[0].content).toBe('corrected summary');
    await exportLibrary(lib); lib.close();
});

test.each([true, false])('one changed turn leaves dependent floors reviewable without rescanning the basis per floor (native edit %s)', async native => {
    const { lib, input, branch } = await fixture(100);
    const reads = vi.spyOn(Transaction.prototype, 'get');
    try {
        if (native) input.messages[0].editedFrom = new Set([input.messages[0].content]);
        input.messages[0].content = 'first source correction';
        await sync(lib, input);
        expect(reads.mock.calls.filter(([store, id]) => store === 'history_snapshots' && id === branch.head).length).toBeLessThan(8);
        const current = await capture(lib, branch.id);
        expect(current.memories.map(m => m.hostId)).toEqual(input.memories.slice(native ? 0 : 1).map(m => m.hostId));
        expect(new Set((await statuses(lib, current)).values())).toEqual(new Set(['needs_review']));
    } finally { reads.mockRestore(); lib.close(); }
});

test('ordinary append without replacements skips old-view, receipt and table-history cleanup scans', async () => {
    const { lib, input } = await fixture(2);
    const reads = vi.spyOn(Transaction.prototype, 'rawAll');
    try {
        input.messages.push({ key: 'next-user', role: 'user', content: 'next question', swipe: 0 });
        await sync(lib, input);
        expect(reads.mock.calls.filter(([store, index]) => index === 'branch' &&
            ['memory_views', 'event_processing_receipts', 'table_history', 'custom_table_rows', 'custom_table_defs'].includes(store))).toEqual([]);
    } finally { reads.mockRestore(); lib.close(); }
});

test('replacing parent preserves the child current text and copied summary', async () => {
    const { lib, input, branch, view } = await fixture(2);
    const child = await forkBranch(lib, view, 'child'), before = await capture(lib, child.id);
    input.messages[3].content = 'new parent body'; input.memories[1].content = 'new parent summary';
    await sync(lib, input);
    const after = await capture(lib, child.id);
    expect(after).toEqual(before);
    expect((await capture(lib, branch.id)).memories.at(-1)?.content).toBe('new parent summary');
    await exportLibrary(lib); lib.close();
});

test('a failed history deletion aborts the same transaction as the replacement', async () => {
    const { lib, input } = await fixture(1), before = (await exportLibrary(lib)).data;
    input.messages[1].content = 'new body'; input.memories[0].content = 'new summary';
    const original = Transaction.prototype.delete;
    const spy = vi.spyOn(Transaction.prototype, 'delete').mockImplementation(function (this: Transaction, store, id) {
        if (store === 'memory_revisions') throw new Error('synthetic retirement failure');
        return original.call(this, store, id);
    });
    try { await expect(sync(lib, input)).rejects.toThrow('synthetic retirement failure'); }
    finally { spy.mockRestore(); }
    expect((await exportLibrary(lib)).data).toEqual(before);
    await sync(lib, input); await exportLibrary(lib); lib.close();
});

test('an unaffected processing receipt uses the current selection without retaining unrelated history', async () => {
    const { lib, input, branch } = await fixture(2);
    const { prepareEventBatch, commitEventBatch } = await import('./events');
    const batch = (await prepareEventBatch(lib, await capture(lib, branch.id), 1, 48000))!;
    await commitEventBatch(lib, batch, { decisions: batch.memories.map(m => ({ memory: m.id, result: 'none' })), events: [] });
    const unchanged = batch.memories[0].id;
    const changedIndex = batch.memories[0].hostId === input.memories[0].hostId ? 1 : 0;
    input.memories[changedIndex].content = 'a newly corrected summary';
    await sync(lib, input);
    expect(await lib.all('memory_views')).toHaveLength(1);
    expect(await lib.all('memory_revisions')).toHaveLength(2);
    expect((await lib.all<any>('event_processing_receipts'))[0].memories).toEqual([unchanged]);
    await exportLibrary(lib); lib.close();
});

test('editing an old summary preserves a later dependent floor for review through archive cleanup', async () => {
    const { cleanLibraryHistory } = await import('./history-cleanup');
    const { lib, input, branch, view } = await fixture(3);
    try {
        input.memories[2].children = [input.memories[0].hostId];
        input.memories[2].inputRefs = view.refs.slice(4);
        input.memories[2].coverage = view.refs.slice(4);
        const before = await capture(lib, (await sync(lib, input)).id);
        const latest = before.memories.find(m => m.hostId === input.memories[2].hostId)!;
        input.memories[0].content += '人工修订';
        await sync(lib, input);
        await cleanLibraryHistory(lib, async () => true);
        const edited = await capture(lib, branch.id);
        expect(edited.memories.find(m => m.id === latest.id)).toEqual(latest);
        const states = await statuses(lib, edited);
        expect(states.get(latest.id)).toBe('needs_rebuild');
        expect(states.get(edited.memories.find(m => m.hostId === input.memories[1].hostId)!.id)).toBe('valid');
        await exportLibrary(lib);
    } finally { lib.close(); }
});
