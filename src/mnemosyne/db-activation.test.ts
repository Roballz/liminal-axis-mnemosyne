import 'fake-indexeddb/auto';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { ACTIVE_KEY, Library, activateLibrary, activeLibrary, freshLibraryName } from './db';
import { capture, synchronize } from './canonical';
import { observation } from './fixtures';
import { exportLibrary, restoreLibrary } from './migration';

const selectors = new Map<string, string>();
vi.stubGlobal('localStorage', {
    getItem: (key: string) => selectors.get(key) ?? null,
    setItem: (key: string, value: string) => { selectors.set(key, value); },
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => vi.unstubAllGlobals());

test('restore remains successful and usable when the cached previous active open rejected', async () => {
    const source = await Library.open(freshLibraryName());
    let restored: Library | undefined;
    try {
        const branch = await synchronize(source, observation(1, 'activation-backup'));
        const pack = await exportLibrary(source);
        const open = vi.spyOn(Library, 'open').mockRejectedValueOnce(new Error('old library unavailable'));
        await expect(activeLibrary()).rejects.toThrow('old library unavailable');
        open.mockRestore();
        restored = await restoreLibrary(pack, true);
        expect(selectors.get(ACTIVE_KEY)).toBe(restored.db.name);
        expect(await activeLibrary()).toBe(restored);
        expect((await capture(restored, branch.id)).sources.size).toBe(2);
        // A fresh transaction proves restore did not close the newly selected database in its catch.
        expect((await exportLibrary(restored)).data).toEqual(pack.data);
    } finally { restored?.close(); source.close(); }
});

test('activating the same validated library twice never closes the current connection', async () => {
    const lib = await Library.open(freshLibraryName());
    try {
        await activateLibrary(lib);
        await activateLibrary(lib);
        expect(await activeLibrary()).toBe(lib);
        expect(await lib.all('stories')).toEqual([]);
        await lib.transaction(['stories'], 'readwrite', tx => tx.add('stories', { id: 'active-proof', schema: 1, created: 1 } as any));
        expect(await lib.get('stories', 'active-proof')).toBeDefined();
    } finally { lib.close(); }
});
