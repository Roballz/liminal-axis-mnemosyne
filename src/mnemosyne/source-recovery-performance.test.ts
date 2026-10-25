import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { capture, statuses, synchronize } from './canonical';
import { DB_VERSION, Library, Transaction, freshLibraryName } from './db';
import { STORES, row, type MemoryRevision } from './model';

afterEach(() => vi.restoreAllMocks());

test('upgrading an existing v3 database indexes its old summary rows without rewriting them', async () => {
    const name = freshLibraryName();
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name, 3);
        open.onupgradeneeded = () => {
            for (const name of STORES.filter(store => store !== 'memory_selection_nodes')) {
                const store = open.result.createObjectStore(name, { keyPath: 'id' });
                for (const index of ['owner', 'branch', 'story']) store.createIndex(index, index);
            }
        };
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const original: MemoryRevision = { ...row('old'), story: 'old-story', branch: 'old-branch', owner: 'old-family',
        hostId: 'old-host', basis: 'old-basis', content: '保留原历史摘要', fingerprint: 'old-fingerprint',
        inputRefs: [], coverage: [], dependencies: [], declaration: '保留原来源声明', level: 0,
        anchor: null, storyTime: '', recall: true, visibility: 'public', seed: false };
    await new Promise<void>((resolve, reject) => {
        const tx = legacy.transaction('memory_revisions', 'readwrite');
        tx.objectStore('memory_revisions').add(original);
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    legacy.close();
    const lib = await Library.open(name);
    try {
        expect(lib.db.version).toBe(DB_VERSION);
        expect(await lib.all('memory_revisions', 'branch_host', ['old-branch', 'old-host'])).toEqual([original]);
        expect(await lib.get('memory_revisions', original.id)).toEqual(original);
        expect(await lib.all('memory_revisions', 'branch_host', ['another-branch', 'old-host'])).toEqual([]);
    } finally { lib.close(); }
});

test.each([0, 2000])('present host bases avoid all historical-summary reads with %i old revisions', async count => {
    const { lib, view, input, branch } = await fixture(40);
    try {
        for (const host of input.memories) host.basisSnapshot = view.snapshot.id;
        await synchronize(lib, input);
        await lib.transaction(['memory_revisions'], 'readwrite', async tx => {
            for (let i = 0; i < count; i++) await tx.add('memory_revisions', {
                ...view.memories[0], ...row('old'), content: `旧修订 ${i}`,
            } as MemoryRevision);
        });
        const all = vi.spyOn(Transaction.prototype, 'all');
        const get = vi.spyOn(Transaction.prototype, 'get');
        const before = (await lib.get<any>('branches', branch.id)).epoch;
        await synchronize(lib, input);
        expect(all.mock.calls.filter(([store]) => store === 'memory_revisions')).toHaveLength(0);
        // All forty host proofs share this basis. One repair lookup replaces forty.
        // Other independent snapshot reads belong to head/table/capture validation.
        expect(get.mock.calls.filter(([store, id]) => store === 'history_snapshots' && id === view.snapshot.id).length).toBeLessThan(8);
        expect((await lib.get<any>('branches', branch.id)).epoch).toBe(before);
    } finally { lib.close(); }
});

test('missing-basis recovery reads only matching branch/host history and sees later foreign inserts', async () => {
    const { lib, input, view, branch } = await fixture(40);
    const other = await Library.open(lib.db.name);
    try {
        const host = input.memories[0];
        host.basisSnapshot = 'missing-host-basis';
        host.inputRefs = [{ message: 'missing-message', revision: 'missing-revision' }];
        host.coverage = [];
        await synchronize(lib, input);
        const current = await capture(lib, branch.id);
        const selected = current.memories.find(memory => memory.hostId === host.hostId)!;
        expect(selected.sourceRecovery).toBeDefined();
        const historical: MemoryRevision = { ...selected, ...row('unselected'), content: '后来恢复的旧修订' };
        delete historical.sourceRecovery;
        const mismatch: MemoryRevision = { ...historical, ...row('different-proof'), inputRefs: [] };
        await other.transaction(['memory_revisions'], 'readwrite', async tx => {
            await tx.add('memory_revisions', historical); await tx.add('memory_revisions', mismatch);
            for (let i = 0; i < 2000; i++) await tx.add('memory_revisions', {
                ...view.memories[1], ...row('unrelated-history'), content: `无关旧修订 ${i}`,
            } as MemoryRevision);
        });
        let matchingRows = 0;
        const original = Transaction.prototype.all;
        const all = vi.spyOn(Transaction.prototype, 'all').mockImplementation(async function (this: Transaction, store, index, key) {
            const values = await original.call(this, store, index, key);
            if (store === 'memory_revisions' && index === 'branch_host') matchingRows += values.length;
            return values as any;
        });
        await synchronize(lib, input);
        expect(all.mock.calls.filter(([store, index]) => store === 'memory_revisions' && index === 'branch')).toHaveLength(0);
        expect(all.mock.calls.filter(([store, index]) => store === 'memory_revisions' && index === 'branch_host')).toEqual([
            ['memory_revisions', 'branch_host', [branch.id, host.hostId]],
        ]);
        expect(matchingRows).toBe(4); // Original, selected recovery, matching old row and nonmatching proof.
        expect(await lib.get('memory_revisions', historical.id)).toMatchObject({ sourceRecovery: { reason: 'missing_basis' } });
        expect(await lib.get('memory_revisions', mismatch.id)).toEqual(mismatch);
        const repaired = await capture(lib, branch.id);
        expect((await statuses(lib, repaired)).get(selected.id)).toBe('needs_review');
        const later = { ...historical, ...row('arrived-later') };
        await other.transaction(['memory_revisions'], 'readwrite', tx => tx.add('memory_revisions', later));
        await synchronize(lib, input);
        expect(await lib.get('memory_revisions', later.id)).toMatchObject({ sourceRecovery: { reason: 'missing_basis' } });
    } finally { other.close(); lib.close(); }
});
