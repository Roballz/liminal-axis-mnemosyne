import { afterEach, expect, test, vi } from 'vitest';
import { AUTO_BACKUP_INTERVAL, backupFailure } from './core-backups';
import { createBackupScheduler } from './core-backup-runtime';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('foreground scheduler coalesces requests, defers busy archives, and stops on shutdown', async () => {
    vi.useFakeTimers();
    let visible = true, ready = false;
    const run = vi.fn(async () => {});
    const scheduler = createBackupScheduler({ visible: () => visible, enabled: () => true, ready: () => ready, run, error: vi.fn() });
    for (let i = 0; i < 100; i++) scheduler.request();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(run).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(30_000); expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) scheduler.request();
    await vi.advanceTimersByTimeAsync(AUTO_BACKUP_INTERVAL - 1); expect(run).toHaveBeenCalledTimes(1);
    visible = false; scheduler.request(); expect(vi.getTimerCount()).toBe(0);
    visible = true; scheduler.request(); await vi.advanceTimersByTimeAsync(30_000); expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop(); await vi.advanceTimersByTimeAsync(AUTO_BACKUP_INTERVAL * 2); expect(run).toHaveBeenCalledTimes(2);
});

test('failed disk writes back off; no unbounded queue or rapid quota retry loop', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => { throw new Error('ENOSPC'); }), error = vi.fn();
    const scheduler = createBackupScheduler({ visible: () => true, enabled: () => true, ready: () => true, run, error });
    scheduler.request(); await vi.advanceTimersByTimeAsync(30_000); expect(run).toHaveBeenCalledTimes(1);
    scheduler.request(); await vi.advanceTimersByTimeAsync(5 * 60_000 - 1); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000); expect(run).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(1); scheduler.stop();
});

test('damaged settings keep automatic work disabled but do not hide independently valid backup files', async () => {
    vi.resetModules();
    const store = Object.fromEntries(['listBlobKeys', 'getBlob', 'setBlob', 'deleteBlob', 'tryGetJson', 'setJson'].map(name => [name, vi.fn()]));
    store.tryGetJson.mockRejectedValue(new Error('settings IO failed'));
    store.listBlobKeys.mockResolvedValue([]);
    vi.stubGlobal('__TAURITAVERN__', { api: { extension: { store } } });
    const runtime = await import('./core-backup-runtime');
    const backups = await runtime.getCoreBackups();
    expect(runtime.coreBackupState.available).toBe(true);
    expect(runtime.coreBackupState.enabled).toBe(false);
    expect(runtime.coreBackupState.error).toContain('settings IO failed');
    expect(await backups.inventory()).toEqual({ entries: [], invalid: [] });
    expect(store.setBlob).not.toHaveBeenCalled(); expect(store.deleteBlob).not.toHaveBeenCalled();
});

test('uncertain disable is locally stopped and explicitly warns that restart can resume old settings', async () => {
    vi.resetModules();
    const store = Object.fromEntries(['listBlobKeys', 'getBlob', 'setBlob', 'deleteBlob', 'tryGetJson', 'setJson'].map(name => [name, vi.fn()]));
    store.tryGetJson.mockResolvedValue({ found: true, value: { schema: 1, enabled: true, keep: 10 } });
    store.setJson.mockRejectedValue(new Error('ENOSPC'));
    vi.stubGlobal('__TAURITAVERN__', { api: { extension: { store } } });
    const runtime = await import('./core-backup-runtime');
    await runtime.getCoreBackups(); expect(runtime.coreBackupState.enabled).toBe(true);
    await expect(runtime.configureCoreBackups(false, 10)).rejects.toThrow('重启后可能');
    expect(runtime.coreBackupState.enabled).toBe(false);
    expect(runtime.coreBackupState.status).toContain('未确认');
    expect(backupFailure(new Error(runtime.coreBackupState.error))).toContain('重启后可能');
});

test('pagehide revokes an in-flight automatic-write guard and prevents subsequent rotation/scheduling', async () => {
    vi.resetModules(); vi.useFakeTimers();
    const store = Object.fromEntries(['listBlobKeys', 'getBlob', 'setBlob', 'deleteBlob', 'tryGetJson', 'setJson'].map(name => [name, vi.fn()]));
    store.tryGetJson.mockResolvedValue({ found: true, value: { schema: 1, enabled: true, keep: 10 } });
    const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('__TAURITAVERN__', { api: { extension: { store } } });
    const db = await import('./db'), core = await import('./core-backups');
    vi.spyOn(db, 'activeLibrary').mockResolvedValue({ db: { name: 'mnemosyne_daily_default' } } as any);
    let guard: (() => boolean) | undefined, finish: (() => void) | undefined;
    const save = vi.spyOn(core.CoreBackups.prototype, 'save').mockImplementation(async (_lib, _kind, _keep, current) => {
        guard = current;
        await new Promise<void>(resolve => { finish = resolve; });
        return { state: 'unchanged' };
    });
    const runtime = await import('./core-backup-runtime');
    runtime.bindCoreBackups(() => true);
    await runtime.getCoreBackups(); await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledTimes(1); expect(guard?.()).toBe(true);
    win.dispatchEvent(new Event('pagehide')); expect(guard?.()).toBe(false);
    finish!(); await vi.advanceTimersByTimeAsync(AUTO_BACKUP_INTERVAL * 2);
    expect(save).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
