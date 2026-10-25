import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import type { BackupDisk } from '@/st/native-backups';

const disk = (): BackupDisk => ({ list: vi.fn(async () => []), read: vi.fn(), write: vi.fn(), remove: vi.fn(),
    readSettings: vi.fn(async () => undefined), writeSettings: vi.fn() });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('browser export forwards the Worker Blob without native disk access or UI parsing', async () => {
    vi.resetModules();
    const native = await import('@/st/native-backups'), worker = await import('./backup-worker-client');
    const nativeOpen = vi.spyOn(native, 'nativeBackupDisk').mockRejectedValue(new Error('no native API'));
    const blob = new Blob(['opaque worker output']), text = vi.spyOn(blob, 'text');
    const run = vi.spyOn(worker, 'runBackupWorker').mockResolvedValue({ state: 'exported', blob, version: 15 });
    const runtime = await import('./core-backup-runtime');
    const lib = { db: { name: 'mnemosyne_daily_synthetic' } } as import('./db').Library;
    expect(await runtime.exportCoreLibrary(lib, () => true)).toEqual({ blob, version: 15 });
    expect(run).toHaveBeenCalledWith(undefined, { kind: 'export', library: lib.db.name }, expect.any(Function));
    expect(nativeOpen).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
});

test.each(['file', 'disk'].flatMap(route => ['activate', 'revoke'].map(outcome => ({ route, outcome }))))(
    '$route restore keeps the old selector until settings readback, then handles $outcome with the final guard', async ({ route, outcome }) => {
        vi.resetModules();
        const { fixture } = await import('./fixtures'), db = await import('./db');
        const { exportLibrary, restoreLibrary } = await import('./migration');
        const { settings, dailySettingsDefaults } = await import('./event-settings');
        const { lib } = await fixture(1), selectors = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (key: string) => selectors.get(key),
            setItem: (key: string, value: string) => { selectors.set(key, value); } });
        await db.activateLibrary(lib); settings.overviewMaterialMode = 'body';
        const prepared = await restoreLibrary(await exportLibrary(lib), false), name = prepared.db.name;
        prepared.close();
        const worker = await import('./backup-worker-client'), native = await import('@/st/native-backups');
        const run = vi.spyOn(worker, 'runBackupWorker').mockResolvedValue({ state: 'restored', library: name });
        const nativeOpen = vi.spyOn(native, 'nativeBackupDisk').mockResolvedValue(disk());
        const runtime = await import('./core-backup-runtime');
        let release!: () => void, current = true, restored: import('./db').Library | undefined;
        const get = db.Library.prototype.get;
        vi.spyOn(db.Library.prototype, 'get').mockImplementation(function (this: import('./db').Library, store, key) {
            if (this.db.name === name && store === 'library_meta' && key === 'daily-settings')
                return new Promise(resolve => { release = () => resolve({ id: key, schema: 1,
                    value: { ...dailySettingsDefaults, overviewMaterialMode: 'summary' } } as any); });
            return get.call(this, store, key);
        });
        try {
            const blob = new Blob(['opaque package']), text = vi.spyOn(blob, 'text');
            const result = route === 'file' ? runtime.restoreCorePackage(blob, () => current)
                : runtime.restoreCoreBackup('selected', 'checksum', () => current);
            await vi.waitFor(() => expect(release).toBeDefined());
            expect(selectors.get(db.ACTIVE_KEY)).toBe(lib.db.name); expect(settings.overviewMaterialMode).toBe('body');
            if (outcome === 'revoke') {
                current = false;
                const rejected = expect(result).rejects.toThrow('新库未启用');
                release(); await rejected;
                expect(await db.activeLibrary()).toBe(lib); expect(selectors.get(db.ACTIVE_KEY)).toBe(lib.db.name);
                expect(settings.overviewMaterialMode).toBe('body');
            } else {
                release(); restored = await result;
                expect(await db.activeLibrary()).toBe(restored); expect(selectors.get(db.ACTIVE_KEY)).toBe(name);
                expect(settings.overviewMaterialMode).toBe('summary');
            }
            expect(text).not.toHaveBeenCalled();
            if (route === 'file') {
                expect(nativeOpen).not.toHaveBeenCalled();
                expect(run.mock.calls[0].slice(0, 2)).toEqual([undefined, { kind: 'import', blob }]);
            } else expect(run.mock.calls[0][1]).toEqual({ kind: 'restore', key: 'selected', checksum: 'checksum' });
        } finally { restored?.close(); lib.close(); }
    },
);

test('manual and pinned Worker results retain small inventory previews when optional sidecars are absent', async () => {
    vi.resetModules();
    const { fixture } = await import('./fixtures'), { CoreBackups } = await import('./core-backups');
    const { lib } = await fixture(1), files = new Map<string, Blob>(), d = disk();
    d.list = vi.fn(async () => [...files.keys()]);
    d.read = vi.fn(async key => files.get(key)!);
    d.write = vi.fn(async (key, blob) => { files.set(key, blob); });
    try {
        const origin = new CoreBackups(d), saved = await origin.save(lib, 'manual');
        if (saved.state !== 'saved') throw new Error('missing backup');
        const pinned = await origin.pin(saved.entry.key, saved.entry.checksum);
        const native = await import('@/st/native-backups'), worker = await import('./backup-worker-client');
        vi.spyOn(native, 'nativeBackupDisk').mockResolvedValue(d);
        vi.spyOn(worker, 'runBackupWorker').mockResolvedValueOnce(saved).mockResolvedValueOnce({ state: 'pinned', entry: pinned });
        vi.mocked(d.read).mockClear(); vi.mocked(d.write).mockClear();
        const runtime = await import('./core-backup-runtime');
        await runtime.saveCoreBackup(lib, 'manual', 20, () => true);
        await runtime.pinCoreBackup(saved.entry.key, saved.entry.checksum, () => true);
        const entries = (await (await runtime.getCoreBackups()).inventory()).entries;
        expect(entries.find(entry => entry.key === saved.entry.key)?.preview).toEqual(saved.entry);
        expect(entries.find(entry => entry.key === pinned.key)?.preview).toEqual(pinned);
        expect(d.read).not.toHaveBeenCalled(); expect(d.write).not.toHaveBeenCalled();
    } finally { lib.close(); }
});
