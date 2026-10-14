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

test('archive blocker display covers every startup gate without changing saved runtime state', async () => {
    const { backupArchiveBlockReason } = await import('./core-backup-runtime');
    const state = { pending: false, error: '', conflict: false, tableError: '' };
    expect(backupArchiveBlockReason(state)).toBe('');
    state.pending = true; expect(backupArchiveBlockReason(state)).toContain('等待当前聊天归档完成');
    state.tableError = '填表待处理'; expect(backupArchiveBlockReason(state)).toContain('填表待处理');
    state.conflict = true; expect(backupArchiveBlockReason(state)).toContain('档案绑定冲突');
    state.error = '摘要基线缺失'; expect(backupArchiveBlockReason(state)).toContain('摘要基线缺失');
    expect(state).toEqual({ pending: true, error: '摘要基线缺失', conflict: true, tableError: '填表待处理' });
});

test('verified protection uses native escaped nonblocking toast once and keeps a retrievable path', async () => {
    vi.resetModules();
    const warning = vi.fn(); vi.stubGlobal('window', { toastr: { warning } });
    const runtime = await import('./core-backup-runtime');
    const entry = { key: 'before-deletion-test.json', snapshotAt: 1800000000000 } as any;
    runtime.reportDeletionProtection(entry, true);
    runtime.reportDeletionProtection(entry, true);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('snapshots-v1/before-deletion-test.json'), '柏宝书', { escapeHtml: true });
    expect(runtime.coreBackupState.protectionNotice).toContain('应用本次删除前');
    vi.stubGlobal('window', {});
    expect(() => runtime.reportDeletionProtection({ ...entry, key: 'other.json' }, true)).not.toThrow();
});

test('explicit retry resets failure backoff without clearing validation or creating extra timers', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new Error('ENOSPC')).mockResolvedValue(undefined);
    const scheduler = createBackupScheduler({ visible: () => true, enabled: () => true, ready: () => true, run, error: vi.fn() });
    scheduler.request(); await vi.advanceTimersByTimeAsync(30_000);
    for (let i = 0; i < 100; i++) scheduler.retry();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(run).toHaveBeenCalledTimes(2); scheduler.stop();
});
