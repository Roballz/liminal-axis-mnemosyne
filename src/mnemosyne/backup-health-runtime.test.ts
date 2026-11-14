import { afterEach, expect, test, vi } from 'vitest';
import { reactive, nextTick } from 'vue';
import { BACKUP_HEALTH_KEY, BackupHealthHistory } from './backup-health';
import type { BackupDisk } from '@/st/native-backups';
import type { BackupOutcome } from './core-backups';

vi.mock('./review-source-repair', () => ({ ensureReviewSourceRepair: vi.fn(async () => ({ disabled: 0, changed: false })) }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const activeKey = 'mnemosyne_daily_active_v1';
const libraryA = 'mnemosyne_daily_health_a', libraryB = 'mnemosyne_daily_health_b';

function environment() {
    const values = new Map<string, string>([[activeKey, libraryA]]);
    const local = { getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
    vi.stubGlobal('localStorage', local);
    let settings = { schema: 1, enabled: true, keep: 20 };
    const disk: BackupDisk = { list: vi.fn(async () => []), read: vi.fn(), write: vi.fn(), remove: vi.fn(),
        readSettings: vi.fn(async () => settings), writeSettings: vi.fn(async value => { settings = value as typeof settings; }) };
    return { values, local, disk };
}
function saved(library: string, savedAt: number): BackupOutcome {
    return { state: 'saved', entry: { key: `manual-${savedAt}`, kind: 'manual', savedAt, snapshotAt: savedAt,
        sourceLibrary: library, bytes: 10, counts: {} as any, checksum: 'verified' } };
}

test('preparation failures are persisted, while a cancelled preparation cannot mark the new library as failed', async () => {
    vi.resetModules();
    const env = environment(), repair = await import('./review-source-repair'), runtime = await import('./core-backup-runtime');
    vi.mocked(repair.ensureReviewSourceRepair).mockRejectedValueOnce(new Error('审核修复未完成'));
    await expect(runtime.prepareCoreBackup({ db: { name: libraryA } } as any, () => true)).rejects.toThrow('审核修复未完成');
    expect(runtime.coreBackupState.error).toBe('审核修复未完成');
    expect(new BackupHealthHistory(() => env.local).get(libraryA).error).toBe('审核修复未完成');
    env.values.set(activeKey, libraryB); runtime.syncCoreBackupHealth();
    vi.mocked(repair.ensureReviewSourceRepair).mockRejectedValueOnce(new Error('页面已改变'));
    await expect(runtime.prepareCoreBackup({ db: { name: libraryA } } as any, () => false)).rejects.toThrow('页面已改变');
    expect(runtime.coreBackupState).toMatchObject({ library: libraryB, error: '', failureSince: 0 });
    expect(new BackupHealthHistory(() => env.local).get(libraryB).error).toBe('');
});

test('manual success and failure persist across restart; toggling the switch cannot clear a data fault', async () => {
    vi.resetModules();
    const env = environment();
    let native = await import('@/st/native-backups'), worker = await import('./backup-worker-client');
    vi.spyOn(native, 'nativeBackupDisk').mockResolvedValue(env.disk);
    const run = vi.spyOn(worker, 'runBackupWorker').mockResolvedValueOnce(saved(libraryA, 100)).mockRejectedValueOnce(new Error('审核来源身份不匹配'));
    let runtime = await import('./core-backup-runtime');
    const lib = { db: { name: libraryA } } as any;
    await runtime.saveCoreBackup(lib, 'manual', 20, () => true);
    await expect(runtime.saveCoreBackup(lib, 'manual', 20, () => true)).rejects.toThrow('审核来源身份');
    expect(run).toHaveBeenCalledTimes(2);
    const failureSince = runtime.coreBackupState.failureSince;
    expect(JSON.parse(env.values.get(BACKUP_HEALTH_KEY)!).entries[0].error).toBe('审核来源身份不匹配');
    vi.resetModules();
    native = await import('@/st/native-backups'); worker = await import('./backup-worker-client');
    vi.spyOn(native, 'nativeBackupDisk').mockResolvedValue(env.disk);
    runtime = await import('./core-backup-runtime');
    await runtime.getCoreBackups();
    expect(runtime.coreBackupState).toMatchObject({ lastSavedAt: 100, error: '审核来源身份不匹配', failureSince });
    await runtime.configureCoreBackups(false, 20);
    await runtime.configureCoreBackups(true, 20);
    expect(runtime.coreBackupState.error).toBe('审核来源身份不匹配');
    vi.spyOn(worker, 'runBackupWorker').mockResolvedValue(saved(libraryA, 500));
    await runtime.saveCoreBackup(lib, 'manual', 20, () => true);
    expect(runtime.coreBackupState).toMatchObject({ lastSavedAt: 500, error: '', failureSince: 0 });
    expect(env.disk.read).not.toHaveBeenCalled();
});

test('automatic too-soon leaves the saved failure intact; unchanged validation clears it without inventing a newer backup', async () => {
    vi.resetModules(); vi.useFakeTimers();
    const env = environment(), history = new BackupHealthHistory(() => env.local);
    history.saved(libraryA, 100); history.failed(libraryA, '仍未修复');
    const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
    const native = await import('@/st/native-backups'), worker = await import('./backup-worker-client'), db = await import('./db');
    vi.spyOn(native, 'nativeBackupDisk').mockResolvedValue(env.disk);
    vi.spyOn(db, 'activeLibrary').mockResolvedValue({ db: { name: libraryA } } as any);
    const run = vi.spyOn(worker, 'runBackupWorker').mockResolvedValueOnce({ state: 'too-soon' }).mockResolvedValueOnce({ state: 'unchanged' });
    const runtime = await import('./core-backup-runtime');
    runtime.bindCoreBackups(() => true);
    await runtime.getCoreBackups(); await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledOnce();
    expect(runtime.coreBackupState).toMatchObject({ lastSavedAt: 100, error: '仍未修复' });
    runtime.retryCoreBackups(); await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(runtime.coreBackupState).toMatchObject({ lastSavedAt: 100, error: '', failureSince: 0 });
    win.dispatchEvent(new Event('pagehide'));
});

test('a delayed result stays attached to its original library and cannot replace the active library warning', async () => {
    vi.resetModules();
    const env = environment(), history = new BackupHealthHistory(() => env.local);
    history.failed(libraryB, 'B库故障', 200);
    const native = await import('@/st/native-backups'), worker = await import('./backup-worker-client');
    vi.spyOn(native, 'nativeBackupDisk').mockResolvedValue(env.disk);
    let finish!: (value: BackupOutcome) => void;
    vi.spyOn(worker, 'runBackupWorker').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const runtime = await import('./core-backup-runtime');
    const pending = runtime.saveCoreBackup({ db: { name: libraryA } } as any, 'manual', 20, () => true);
    await vi.waitFor(() => expect(finish).toBeDefined());
    env.values.set(activeKey, libraryB); runtime.syncCoreBackupHealth();
    expect(runtime.coreBackupState).toMatchObject({ library: libraryB, error: 'B库故障' });
    finish(saved(libraryA, 300)); await pending;
    expect(runtime.coreBackupState).toMatchObject({ library: libraryB, error: 'B库故障', lastSavedAt: 0 });
    env.values.set(activeKey, libraryA); runtime.syncCoreBackupHealth();
    expect(runtime.coreBackupState).toMatchObject({ library: libraryA, error: '', lastSavedAt: 300 });
});

test('startup reads filenames once and never opens packages; repeated revision signals do not repeat discovery', async () => {
    vi.resetModules(); vi.useFakeTimers();
    const env = environment();
    const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
    const native = await import('@/st/native-backups'), { fingerprint } = await import('./model');
    const bank = (await fingerprint(libraryA)).slice(0, 16);
    const legacyAt = 1_700_000_000_000;
    vi.mocked(env.disk.list).mockResolvedValue([`auto-v1-${legacyAt}-${bank}-11111111-1111-4111-8111-111111111111.json`]);
    vi.spyOn(native, 'nativeBackupDisk').mockResolvedValue(env.disk);
    const runtime = await import('./core-backup-runtime'), revision = reactive({ value: 0 });
    runtime.bindCoreBackups(() => false, () => revision.value);
    await runtime.getCoreBackups();
    await vi.waitFor(() => expect(runtime.coreBackupState.lastFileAt).toBe(legacyAt));
    for (let i = 0; i < 100; i++) { revision.value++; await nextTick(); }
    expect(runtime.coreBackupState).toMatchObject({ lastSavedAt: 0, lastFileAt: legacyAt });
    expect(env.disk.list).toHaveBeenCalledOnce();
    expect(env.disk.read).not.toHaveBeenCalled();
    expect(env.disk.readPreviews).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    win.dispatchEvent(new Event('pagehide'));
});
