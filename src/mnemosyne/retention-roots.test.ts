import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { DB_VERSION, Library, Transaction, freshLibraryName, request } from './db';
import { fixture } from './fixtures';
import { exportLibrary, restoreLibrary } from './migration';
import { STORES, type Branch, type Row, type Store } from './model';
import { EVIDENCE_STORES, RETENTION_CONTROL_STORE, RETENTION_STAMP_KEY } from './retention-roots';

afterEach(() => vi.restoreAllMocks());

const evidenceStores = new Set<Store>(EVIDENCE_STORES);
type EvidenceRow = Row & Record<string, unknown>;
function evidence(id: string, story: string | undefined, payload: Record<string, unknown>): EvidenceRow {
    return { id, schema: 1, story, ...payload };
}
function rootPair(snapshot: string, source: string) {
    return { snapshot, refs: [{ message: `message-${source}`, revision: source }] };
}
function sorted(roots: { snapshotRoots: ReadonlySet<string>; sourceRoots: ReadonlySet<string> }) {
    return { snapshots: [...roots.snapshotRoots].sort(), sources: [...roots.sourceRoots].sort() };
}
async function roots(lib: Library, story = 'story', refresh = false) {
    return lib.transaction(EVIDENCE_STORES, 'readonly', async tx => sorted(await tx.retentionRoots(story, refresh)));
}
async function stamp(lib: Library) {
    const native = lib.db.transaction(RETENTION_CONTROL_STORE, 'readonly');
    const row = await request<{ stamp: number } | undefined>(native.objectStore(RETENTION_CONTROL_STORE).get(RETENTION_STAMP_KEY));
    return row?.stamp ?? 0;
}
function scans() {
    const getAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    return {
        count: () => getAll.mock.contexts.filter(context => {
            const index = context as IDBIndex;
            return index.name === 'story' && evidenceStores.has(index.objectStore.name as Store);
        }).length,
        clear: () => getAll.mockClear(),
    };
}

test('all nine evidence stores collect nested roots once per cold story and reuse the same IndexedDB proof', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        await lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            for (const store of EVIDENCE_STORES) await tx.add(store, evidence(`row-${store}`, 'story', {
                basis: `basis-${store}`, output: [{ nested: rootPair(`snapshot-${store}`, `source-${store}`),
                    ignored: [{ message: 12, revision: 'not-a-source' }, { message: 'm', revision: 42 },
                        { basis: 12, snapshot: false }, 'snapshot-inside-text'] }],
            }));
            await tx.add('table_receipts', evidence('other-story', 'other', rootPair('other-snapshot', 'other-source')));
            await tx.add('reviews', evidence('no-story', undefined, rootPair('unscoped-snapshot', 'unscoped-source')));
        });
        const read = scans(), beforeStamp = await stamp(lib);
        const expected = {
            snapshots: EVIDENCE_STORES.flatMap(store => [`basis-${store}`, `snapshot-${store}`]).sort(),
            sources: EVIDENCE_STORES.map(store => `source-${store}`).sort(),
        };
        expect(await roots(lib)).toEqual(expected);
        expect(read.count()).toBe(9);
        read.clear();
        for (let n = 0; n < 5; n++) expect(await roots(lib)).toEqual(expected);
        expect(read.count()).toBe(0);
        expect(await roots(lib, 'other')).toEqual({ snapshots: ['other-snapshot'], sources: ['other-source'] });
        expect(read.count()).toBe(9);
        read.clear();
        expect(await roots(lib)).toEqual(expected);
        expect(read.count()).toBe(0);
        expect(await stamp(lib)).toBe(beforeStamp);
    } finally { lib.close(); }
});

test.each(['memory_revisions', 'event_processing_receipts', 'custom_table_rows'] as const)(
    'foreign same-epoch add, replacement and deletion in %s invalidate only a committed evidence proof', async store => {
        const { lib, branch } = await fixture(1), other = await Library.open(lib.db.name);
        try {
            const before = await roots(lib, branch.story), beforeStamp = await stamp(lib), read = scans();
            const withRoot = (snapshot: string, source: string) => ({
                snapshots: [...before.snapshots, snapshot].sort(), sources: [...before.sources, source].sort(),
            });
            const first = evidence('foreign-root', branch.story, {
                output: [{ original: rootPair('foreign-snapshot-a', 'foreign-source-a') }],
                values: { saved: [{ snapshot: 'foreign-snapshot-a' }] },
            });
            await other.transaction([store], 'readwrite', tx => tx.add(store, first));
            expect(await stamp(lib)).toBeGreaterThan(beforeStamp);
            expect((await lib.get<Branch>('branches', branch.id))!.epoch).toBe(branch.epoch);
            expect(await roots(lib, branch.story)).toEqual(withRoot('foreign-snapshot-a', 'foreign-source-a'));
            expect(read.count()).toBe(9);
            read.clear();
            expect(await roots(lib, branch.story)).toEqual(withRoot('foreign-snapshot-a', 'foreign-source-a'));
            expect(read.count()).toBe(0);
            await other.transaction([store], 'readwrite', tx => tx.put(store, evidence(first.id, branch.story, {
                values: { saved: [{ more: rootPair('foreign-snapshot-b', 'foreign-source-b') }] },
            })));
            expect((await lib.get<Branch>('branches', branch.id))!.epoch).toBe(branch.epoch);
            expect(await roots(lib, branch.story)).toEqual(withRoot('foreign-snapshot-b', 'foreign-source-b'));
            expect(read.count()).toBe(9);
            read.clear();
            await other.transaction([store], 'readwrite', tx => tx.delete(store, first.id));
            expect((await lib.get<Branch>('branches', branch.id))!.epoch).toBe(branch.epoch);
            expect(await roots(lib, branch.story)).toEqual(before);
            expect(read.count()).toBe(9);
        } finally { other.close(); lib.close(); }
    });

test('shared roots survive one row deletion and disappear exactly when their last local row is removed', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        const repeated = rootPair('shared-snapshot', 'shared-source');
        await lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            await tx.add('reviews', evidence('first', 'story', { one: repeated, two: [repeated, repeated] }));
            await tx.add('event_processing_receipts', evidence('second', 'story', { output: [repeated] }));
        });
        expect(await roots(lib)).toEqual({ snapshots: ['shared-snapshot'], sources: ['shared-source'] });
        const read = scans();
        await lib.transaction(['reviews'], 'readwrite', tx => tx.delete('reviews', 'first'));
        expect(await roots(lib)).toEqual({ snapshots: ['shared-snapshot'], sources: ['shared-source'] });
        await lib.transaction(['event_processing_receipts'], 'readwrite', tx => tx.put('event_processing_receipts',
            evidence('second', 'story', { output: rootPair('next-snapshot', 'next-source') })));
        expect(await roots(lib)).toEqual({ snapshots: ['next-snapshot'], sources: ['next-source'] });
        await lib.transaction(['memory_revisions'], 'readwrite', tx => tx.add('memory_revisions',
            evidence('third', 'story', { basis: 'next-snapshot', inputRefs: [{ message: 'm', revision: 'next-source' }] })));
        await lib.transaction(['event_processing_receipts'], 'readwrite', tx => tx.delete('event_processing_receipts', 'second'));
        expect(await roots(lib)).toEqual({ snapshots: ['next-snapshot'], sources: ['next-source'] });
        await lib.transaction(['memory_revisions'], 'readwrite', tx => tx.delete('memory_revisions', 'third'));
        expect(await roots(lib)).toEqual({ snapshots: [], sources: [] });
        expect(read.count()).toBe(0);
    } finally { lib.close(); }
});

test('same-key put, put, delete and add preserve native request order without a rescan', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        await lib.transaction(['memory_revisions'], 'readwrite', tx => tx.add('memory_revisions',
            evidence('same', 'story', rootPair('first-snapshot', 'first-source'))));
        await roots(lib);
        const read = scans();
        await lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            const pending = [
                tx.put('memory_revisions', evidence('same', 'story', rootPair('second-snapshot', 'second-source'))),
                tx.put('memory_revisions', evidence('same', 'story', rootPair('third-snapshot', 'third-source'))),
                tx.delete('memory_revisions', 'same'),
                tx.add('memory_revisions', evidence('same', 'story', rootPair('last-snapshot', 'last-source'))),
            ];
            expect(sorted(await tx.retentionRoots('story'))).toEqual({ snapshots: ['last-snapshot'], sources: ['last-source'] });
            await Promise.all(pending);
        });
        expect(await roots(lib)).toEqual({ snapshots: ['last-snapshot'], sources: ['last-source'] });
        expect(await lib.get('memory_revisions', 'same')).toEqual(evidence('same', 'story', rootPair('last-snapshot', 'last-source')));
        expect(read.count()).toBe(0);
    } finally { lib.close(); }
});

test('a caller mutating a value after put cannot change the roots of the stored structured clone', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        await roots(lib); await roots(lib, 'other');
        const read = scans();
        const value = { id: 'mutable', schema: 1 as const, story: 'story', output: rootPair('stored-snapshot', 'stored-source') };
        await lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            const pending = tx.put('event_processing_receipts', value);
            value.story = 'other'; value.output.snapshot = 'mutated-snapshot'; value.output.refs[0].revision = 'mutated-source';
            await pending;
            expect(sorted(await tx.retentionRoots('story'))).toEqual({ snapshots: ['stored-snapshot'], sources: ['stored-source'] });
            expect(sorted(await tx.retentionRoots('other'))).toEqual({ snapshots: [], sources: [] });
        });
        expect(await lib.get('event_processing_receipts', value.id)).toEqual({ id: value.id, schema: 1, story: 'story',
            output: rootPair('stored-snapshot', 'stored-source') });
        expect(await roots(lib)).toEqual({ snapshots: ['stored-snapshot'], sources: ['stored-source'] });
        expect(await roots(lib, 'other')).toEqual({ snapshots: [], sources: [] });
        expect(read.count()).toBe(0);
    } finally { lib.close(); }
});

test('moving a row between stories transfers only its own counts, including an unscoped intermediate row', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        await lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            await tx.add('reviews', evidence('moving', 'first', rootPair('shared', 'shared-source')));
            await tx.add('table_receipts', evidence('stationary', 'second', rootPair('shared', 'shared-source')));
        });
        await roots(lib, 'first'); await roots(lib, 'second');
        const read = scans();
        await lib.transaction(['reviews'], 'readwrite', tx => tx.put('reviews', evidence('moving', 'second', rootPair('shared', 'shared-source'))));
        expect(await roots(lib, 'first')).toEqual({ snapshots: [], sources: [] });
        expect(await roots(lib, 'second')).toEqual({ snapshots: ['shared'], sources: ['shared-source'] });
        await lib.transaction(['reviews'], 'readwrite', tx => tx.put('reviews', evidence('moving', undefined, rootPair('ignored', 'ignored-source'))));
        expect(await roots(lib, 'second')).toEqual({ snapshots: ['shared'], sources: ['shared-source'] });
        await lib.transaction(['reviews'], 'readwrite', tx => tx.put('reviews', evidence('moving', 'first', rootPair('new', 'new-source'))));
        expect(await roots(lib, 'first')).toEqual({ snapshots: ['new'], sources: ['new-source'] });
        await lib.transaction(['table_receipts'], 'readwrite', tx => tx.delete('table_receipts', 'stationary'));
        expect(await roots(lib, 'second')).toEqual({ snapshots: [], sources: [] });
        expect(read.count()).toBe(0);
    } finally { lib.close(); }
});

test('cold and forced scans absorb prior writes exactly once and keep later writes incremental', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        const read = scans();
        await lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            await tx.add('reviews', evidence('changed', 'story', rootPair('first', 'first-source')));
            expect(sorted(await tx.retentionRoots('story'))).toEqual({ snapshots: ['first'], sources: ['first-source'] });
            expect(read.count()).toBe(9);
            await tx.put('reviews', evidence('changed', 'story', rootPair('second', 'second-source')));
            expect(sorted(await tx.retentionRoots('story'))).toEqual({ snapshots: ['second'], sources: ['second-source'] });
            expect(read.count()).toBe(9);
            await tx.add('table_receipts', evidence('late', 'story', rootPair('late', 'late-source')));
            expect(sorted(await tx.retentionRoots('story', true))).toEqual({ snapshots: ['late', 'second'], sources: ['late-source', 'second-source'] });
            expect(read.count()).toBe(18);
            await tx.delete('reviews', 'changed');
            expect(sorted(await tx.retentionRoots('story'))).toEqual({ snapshots: ['late'], sources: ['late-source'] });
        });
        read.clear();
        expect(await roots(lib)).toEqual({ snapshots: ['late'], sources: ['late-source'] });
        expect(read.count()).toBe(0);
        const other = await Library.open(lib.db.name);
        try { expect(await roots(other)).toEqual({ snapshots: ['late'], sources: ['late-source'] }); }
        finally { other.close(); }
        expect(read.count()).toBe(9);
    } finally { lib.close(); }
});

test('writes interleaved with a cold scan apply once according to each store read boundary', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        const stores = ['memory_revisions', 'reviews', 'table_receipts'] as const;
        await lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            for (const store of stores) await tx.add(store, evidence(store, 'story', rootPair(`old-${store}`, `old-source-${store}`)));
        });
        let injected: Promise<unknown> | undefined;
        const nativeAll = Transaction.prototype.all;
        vi.spyOn(Transaction.prototype, 'all').mockImplementation(function (this: Transaction, store, index, key) {
            const result = nativeAll.call(this, store, index, key);
            if (this.native.db.name === lib.db.name && store === 'reviews' && index === 'story' && !injected) {
                // The memory and review reads precede these writes; the table read
                // is queued later. One transaction therefore needs three boundaries.
                injected = Promise.all(stores.map(store => this.put(store,
                    evidence(store, 'story', rootPair(`new-${store}`, `new-source-${store}`)))));
            }
            return result as any;
        });
        const expected = { snapshots: stores.map(store => `new-${store}`).sort(), sources: stores.map(store => `new-source-${store}`).sort() };
        const read = scans();
        await lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            expect(sorted(await tx.retentionRoots('story'))).toEqual(expected);
            await injected;
        });
        expect(read.count()).toBe(9);
        read.clear();
        expect(await roots(lib)).toEqual(expected);
        // A duplicated late-store delta would leave this root behind after deletion.
        await lib.transaction(['table_receipts'], 'readwrite', tx => tx.delete('table_receipts', 'table_receipts'));
        expect(await roots(lib)).toEqual({ snapshots: ['new-memory_revisions', 'new-reviews'],
            sources: ['new-source-memory_revisions', 'new-source-reviews'] });
        expect(read.count()).toBe(0);
    } finally { lib.close(); }
});

test('a callback abort publishes neither an updated warm cache nor its database stamp', async () => {
    const lib = await Library.open(freshLibraryName());
    const other = await Library.open(lib.db.name);
    try {
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', evidence('kept', 'story', rootPair('kept', 'kept-source'))));
        const expected = await roots(lib); await roots(other);
        const beforeStamp = await stamp(lib), read = scans();
        await expect(lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            await tx.put('reviews', evidence('kept', 'story', rootPair('aborted', 'aborted-source')));
            expect(sorted(await tx.retentionRoots('story'))).toEqual({ snapshots: ['aborted'], sources: ['aborted-source'] });
            throw new Error('cancel after reading provisional roots');
        })).rejects.toThrow('cancel after reading provisional roots');
        expect(await stamp(lib)).toBe(beforeStamp);
        expect(await roots(lib)).toEqual(expected);
        expect(await roots(other)).toEqual(expected);
        expect(read.count()).toBe(0);
        expect(await lib.get('reviews', 'kept')).toEqual(evidence('kept', 'story', rootPair('kept', 'kept-source')));
    } finally { other.close(); lib.close(); }
});

test('a cold proof built inside an aborted transaction is discarded', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', evidence('kept', 'story', rootPair('kept', 'kept-source'))));
        const beforeStamp = await stamp(lib), read = scans();
        await expect(lib.transaction(EVIDENCE_STORES, 'readwrite', async tx => {
            await tx.put('reviews', evidence('kept', 'story', rootPair('aborted', 'aborted-source')));
            expect(sorted(await tx.retentionRoots('story'))).toEqual({ snapshots: ['aborted'], sources: ['aborted-source'] });
            throw new Error('cancel cold proof');
        })).rejects.toThrow('cancel cold proof');
        expect(read.count()).toBe(9);
        read.clear();
        expect(await stamp(lib)).toBe(beforeStamp);
        expect(await roots(lib)).toEqual({ snapshots: ['kept'], sources: ['kept-source'] });
        expect(read.count()).toBe(9);
    } finally { lib.close(); }
});

test('native write failure rolls back successful earlier mutations and leaves the warm proof usable', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        const original = evidence('same', 'story', rootPair('kept', 'kept-source'));
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', original));
        const expected = await roots(lib), beforeStamp = await stamp(lib), read = scans();
        await expect(lib.transaction(['reviews'], 'readwrite', async tx => {
            await tx.put('reviews', evidence('same', 'story', rootPair('provisional', 'provisional-source')));
            await tx.add('reviews', evidence('same', 'story', rootPair('duplicate', 'duplicate-source')));
        })).rejects.toMatchObject({ name: 'ConstraintError' });
        expect(await stamp(lib)).toBe(beforeStamp);
        expect(await lib.get('reviews', 'same')).toEqual(original);
        expect(await roots(lib)).toEqual(expected);
        expect(read.count()).toBe(0);
    } finally { lib.close(); }
});

test('a synchronous native clone failure cancels the queued old read without publishing or leaking a rejection', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        const original = evidence('same', 'story', rootPair('kept', 'kept-source'));
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', original));
        const expected = await roots(lib), beforeStamp = await stamp(lib), read = scans();
        const invalid = evidence('same', 'story', { ...rootPair('not-stored', 'not-stored-source'), uncloneable: () => true });
        await expect(lib.transaction(['reviews'], 'readwrite', tx => tx.put('reviews', invalid)))
            .rejects.toMatchObject({ name: 'DataCloneError' });
        expect(await stamp(lib)).toBe(beforeStamp);
        expect(await lib.get('reviews', 'same')).toEqual(original);
        expect(await roots(lib)).toEqual(expected);
        expect(read.count()).toBe(0);
    } finally { lib.close(); }
});

test('reads, forced verification and writes outside the evidence stores do not advance the stamp', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', evidence('kept', 'story', rootPair('kept', 'kept-source'))));
        const expected = await roots(lib), beforeStamp = await stamp(lib);
        await lib.transaction(STORES, 'readwrite', async tx => {
            expect(sorted(await tx.retentionRoots('story'))).toEqual(expected);
            await tx.add('stories', { id: 'unrelated', schema: 1 });
        });
        expect(await roots(lib, 'story', true)).toEqual(expected);
        expect(await stamp(lib)).toBe(beforeStamp);
        const read = scans();
        expect(await roots(lib)).toEqual(expected);
        expect(read.count()).toBe(0);
    } finally { lib.close(); }
});

test('physical v4 upgrade preserves evidence, adds only internal metadata and rejects old writers', async () => {
    const name = freshLibraryName(), original = evidence('legacy-root', 'story', { output: [rootPair('legacy', 'legacy-source')] });
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name, 4);
        open.onupgradeneeded = () => {
            for (const name of STORES) {
                const store = open.result.createObjectStore(name, { keyPath: 'id' });
                for (const index of ['story', 'branch', 'owner']) store.createIndex(index, index);
                if (name === 'memory_revisions') store.createIndex('branch_host', ['branch', 'hostId']);
            }
            open.transaction!.objectStore('reviews').add(original);
        };
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const changed = vi.fn(() => legacy.close()); legacy.onversionchange = changed;
    const lib = await Library.open(name);
    try {
        expect(DB_VERSION).toBeGreaterThan(4);
        expect(lib.db.version).toBe(DB_VERSION);
        expect(changed).toHaveBeenCalledOnce();
        expect(() => legacy.transaction('reviews', 'readwrite')).toThrow();
        expect([...lib.db.objectStoreNames].sort()).toEqual([...STORES, RETENTION_CONTROL_STORE].sort());
        expect(await lib.get('reviews', original.id)).toEqual(original);
        const read = scans();
        expect(await roots(lib)).toEqual({ snapshots: ['legacy'], sources: ['legacy-source'] });
        expect(read.count()).toBe(9);
        const oldError = await new Promise<DOMException | null>(resolve => {
            const open = indexedDB.open(name, 4);
            open.onerror = () => resolve(open.error);
            open.onsuccess = () => { open.result.close(); resolve(null); };
        });
        expect(oldError?.name).toBe('VersionError');
    } finally { legacy.close(); lib.close(); }
});

test('a rejected blocked upgrade cannot migrate the library after its old connection closes', async () => {
    const name = freshLibraryName();
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name, 4);
        open.onupgradeneeded = () => {
            const store = open.result.createObjectStore('stories', { keyPath: 'id' });
            for (const index of ['story', 'branch', 'owner']) store.createIndex(index, index);
            store.add({ id: 'preserved', schema: 1, created: 1 });
        };
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const nativeOpen = indexedDB.open.bind(indexedDB);
    let blockedRequest: IDBOpenDBRequest | undefined, lib: Library | undefined;
    const open = vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
        const pending = nativeOpen(name, version);
        if (version === DB_VERSION) blockedRequest = pending;
        return pending;
    });
    try {
        await expect(Library.open(name)).rejects.toThrow('数据库升级被另一个标签页阻塞');
        const abandoned = new Promise<DOMException | null>(resolve => {
            blockedRequest!.addEventListener('error', () => resolve(blockedRequest!.error), { once: true });
            blockedRequest!.addEventListener('success', () => {
                blockedRequest!.result.close(); resolve(null);
            }, { once: true });
        });
        legacy.close();
        expect((await abandoned)?.name).toBe('AbortError');
        open.mockRestore();
        const unchanged = await new Promise<IDBDatabase>((resolve, reject) => {
            const pending = indexedDB.open(name);
            pending.onsuccess = () => resolve(pending.result); pending.onerror = () => reject(pending.error);
        });
        try {
            expect(unchanged.version).toBe(4);
            expect([...unchanged.objectStoreNames]).toEqual(['stories']);
        } finally { unchanged.close(); }
        lib = await Library.open(name);
        expect(lib.db.version).toBe(DB_VERSION);
        expect(await lib.get('stories', 'preserved')).toEqual({ id: 'preserved', schema: 1, created: 1 });
    } finally { open.mockRestore(); legacy.close(); lib?.close(); }
});

test('internal stamps stay outside v15 packages and a restored library rebuilds its own proof', async () => {
    const { lib, branch } = await fixture(2);
    let restored: Library | undefined;
    try {
        const expected = await roots(lib, branch.story), pack = await exportLibrary(lib);
        expect(pack.version).toBe(15);
        expect(Object.keys(pack.data).sort()).toEqual([...STORES].sort());
        expect(Object.keys(pack.counts).sort()).toEqual([...STORES].sort());
        expect(pack.data).not.toHaveProperty(RETENTION_CONTROL_STORE);
        expect(pack.counts).not.toHaveProperty(RETENTION_CONTROL_STORE);
        restored = await restoreLibrary(pack, false);
        expect(restored.db.version).toBe(DB_VERSION);
        expect(restored.db.objectStoreNames.contains(RETENTION_CONTROL_STORE)).toBe(true);
        expect((await exportLibrary(restored)).data).toEqual(pack.data);
        const read = scans();
        expect(await roots(restored, branch.story)).toEqual(expected);
        expect(read.count()).toBe(9);
        read.clear();
        expect(await roots(restored, branch.story)).toEqual(expected);
        expect(read.count()).toBe(0);
    } finally { restored?.close(); lib.close(); }
});
