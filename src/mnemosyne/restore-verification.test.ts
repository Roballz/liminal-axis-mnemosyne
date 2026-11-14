import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { ACTIVE_KEY, Library, Transaction, freshLibraryName } from './db';
import { fixture } from './fixtures';
import { exportLibrary, restoreLibrary, type Package } from './migration';
import { STORES, fingerprint, type Row, type SourceBody } from './model';
import { verifyRestoredRows } from './restore-verification';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('restore verifies all persisted rows in one readonly snapshot without a second full export', async () => {
    const { lib } = await fixture(2);
    let restored: Library | undefined;
    try {
        const pack = await exportLibrary(lib), original = await fingerprint(pack.data);
        const rawAll = vi.spyOn(Transaction.prototype, 'rawAll').mockImplementation(() => { throw new Error('full export'); });
        const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => { throw new Error('full store read'); });
        const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
        const cursors = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
        restored = await restoreLibrary(pack, false);
        expect(rawAll).not.toHaveBeenCalled();
        expect(getAll).not.toHaveBeenCalled();
        expect(transactions.mock.calls.filter(args => args[1] === 'readonly')).toHaveLength(1);
        expect(cursors).toHaveBeenCalledTimes(STORES.length);
        expect(await fingerprint(pack.data)).toBe(original);
    } finally { restored?.close(); lib.close(); }
});

test.each(['missing', 'extra', 'replaced', 'reordered'] as const)('persisted %s rows fail exact roundtrip verification', async kind => {
    const lib = await Library.open(freshLibraryName());
    const a: Row = { id: 'a', schema: 1 }, b: Row = { id: 'b', schema: 1 };
    const data = Object.fromEntries(STORES.map(store => [store, [] as Row[]])) as Package['data'];
    data.stories = kind === 'reordered' ? [b, a] : [a, b];
    const extra: Row = { id: 'c', schema: 1 }, replaced = { ...b, created: 2 };
    const rows: Row[] = kind === 'missing' ? [a] : kind === 'extra' ? [a, b, extra] :
        kind === 'replaced' ? [a, replaced] : [a, b];
    try {
        await lib.transaction(['stories'], 'readwrite', async tx => {
            for (const row of rows) await tx.add('stories', row);
        });
        await expect(verifyRestoredRows(lib, data)).rejects.toThrow('恢复后对象不一致 stories');
    } finally { lib.close(); }
});

test('persisted corruption is rejected before activation and leaves the original library and import data intact', async () => {
    const { lib } = await fixture(1);
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === ACTIVE_KEY ? lib.db.name : null, setItem });
    try {
        const pack = await exportLibrary(lib), original = await fingerprint(pack.data);
        const body = pack.data.source_bodies[0] as SourceBody;
        const add = Transaction.prototype.add;
        vi.spyOn(Transaction.prototype, 'add').mockImplementation(function (this: Transaction, store, value) {
            return add.call(this, store, store === 'source_bodies' ? { ...value, content: 'corrupted persisted bytes' } as Row : value);
        });
        await expect(restoreLibrary(pack)).rejects.toThrow('恢复后对象不一致 source_bodies');
        expect(setItem).not.toHaveBeenCalled();
        expect((await lib.get<SourceBody>('source_bodies', body.id))?.content).toBe(body.content);
        expect(await fingerprint(pack.data)).toBe(original);
    } finally { lib.close(); }
});
