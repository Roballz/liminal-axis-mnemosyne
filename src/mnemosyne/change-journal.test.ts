import { expect, test } from 'vitest';
import { fixture } from './fixtures';
import { Library } from './db';
import { LibraryChanges, TransactionChanges, sourceNeutralChanges } from './change-journal';
import { row, type Branch, type EventChain } from './model';

test('only committed writes establish a continuous source-neutral branch transition', async () => {
    const { lib, branch } = await fixture(1), version = lib.changes.version;
    const original = structuredClone(branch);
    try {
        await expect(lib.transaction(['branches', 'event_chains'], 'readwrite', async tx => {
            const live = (await tx.get<Branch>('branches', branch.id))!;
            live.epoch++;
            await tx.put('branches', live);
            throw new Error('cancelled');
        })).rejects.toThrow('cancelled');
        expect(lib.changes.version).toBe(version);
        await lib.transaction(['branches', 'event_chains'], 'readwrite', async tx => {
            const live = (await tx.get<Branch>('branches', branch.id))!;
            live.epoch++;
            await tx.add('event_chains', { ...row('ev'), story: live.story, branch: live.id, created: 1 } as EventChain);
            await tx.put('branches', live);
            live.epoch = 9999; // The journal, like IDB, owns an immutable submitted snapshot.
        });
        const after = (await lib.get<Branch>('branches', branch.id))!;
        expect(sourceNeutralChanges(lib.changes, version, original, after)).toEqual({ events: true, tables: false });
        expect(after.epoch).toBe(original.epoch + 1);
    } finally { lib.close(); }
});

test('foreign connection changes and unclassified writes cannot grant source validity reuse', async () => {
    const { lib, branch } = await fixture(1), version = lib.changes.version;
    const other = await Library.open(lib.db.name);
    try {
        await other.transaction(['branches'], 'readwrite', async tx => {
            const live = (await tx.get<Branch>('branches', branch.id))!;
            live.epoch++; await tx.put('branches', live);
        });
        const after = (await lib.get<Branch>('branches', branch.id))!;
        expect(sourceNeutralChanges(lib.changes, version, branch, after)).toBeNull();
        const observed = lib.changes.version;
        await lib.transaction(['reviews'], 'readwrite', async tx => {
            await tx.add('reviews', { ...row('review'), branch: branch.id, story: branch.story });
        });
        expect(sourceNeutralChanges(lib.changes, observed, after, after)).toBeNull();
    } finally { other.close(); lib.close(); }
});

test('table pointer changes invalidate tables; missing bounded journal evidence falls back', () => {
    const before: Branch = { ...row('branch'), story: 'story', head: 'head', view: 'view', epoch: 1, fork: null };
    const after = { ...before, epoch: 2, tableHead: 'table-history' };
    const journal = new LibraryChanges(), edit = new TransactionChanges();
    edit.read('branches', before); edit.write('branches', after.id, after); journal.commit(edit);
    expect(sourceNeutralChanges(journal, 0, before, after)).toEqual({ events: false, tables: true });
    for (let i = 0; i < 65; i++) {
        const write = new TransactionChanges();
        write.write('event_chains', String(i), { ...row('ev'), id: String(i), branch: before.id }); journal.commit(write);
    }
    expect(journal.since(0)).toBeNull();
    expect(sourceNeutralChanges(journal, 0, before, after)).toBeNull();
});
