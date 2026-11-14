import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { STORES } from './model';
import { exportLibrary } from './migration';
import { measureCorePackageSize } from './core-package-size';

afterEach(() => vi.restoreAllMocks());

test('size diagnosis matches serialized store bytes, pages reads and returns no private text or identities', async () => {
    const { lib, input } = await fixture(70);
    try {
        const pack = await exportLibrary(lib);
        const expected = Object.fromEntries(STORES.map(store => [store, {
            records: pack.data[store].length, bytes: new TextEncoder().encode(JSON.stringify(pack.data[store])).length,
        }]));
        const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
        const transaction = vi.spyOn(lib, 'transaction');
        const report = await measureCorePackageSize(lib, () => true);
        expect(getAll).not.toHaveBeenCalled();
        expect(transaction.mock.calls.every(([stores, mode]) => stores.length === 1 && mode === 'readonly')).toBe(true);
        expect(transaction.mock.calls.filter(([stores]) => stores[0] === 'source_bodies').length).toBeGreaterThan(1);
        for (const size of report.stores) expect(size).toEqual({ store: size.store, ...expected[size.store] });
        expect(report.bytes).toBe(Object.values(expected).reduce((sum, value) => sum + value.bytes, 0));
        expect(report.stores.map(row => row.bytes)).toEqual(report.stores.map(row => row.bytes).sort((a, b) => b - a));
        expect(report.details.compactViews).toBeGreaterThan(0);
        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain(lib.db.name);
        expect(serialized).not.toContain(input.messages[1].content);
        expect(serialized).not.toContain(pack.data.branches[0].id);
        getAll.mockRestore();
        expect((await exportLibrary(lib)).data).toEqual(pack.data);
    } finally { lib.close(); }
});

test('size diagnosis stops between pages when its captured view expires, without mutations', async () => {
    const { lib } = await fixture(70);
    try {
        const add = vi.spyOn(IDBObjectStore.prototype, 'add'), put = vi.spyOn(IDBObjectStore.prototype, 'put');
        const remove = vi.spyOn(IDBObjectStore.prototype, 'delete');
        let checks = 0;
        await expect(measureCorePackageSize(lib, () => ++checks < 5)).rejects.toThrow('已取消');
        expect(checks).toBe(5);
        expect(add).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    } finally { lib.close(); }
});
