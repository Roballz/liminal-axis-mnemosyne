import { runBackupWorker } from './backup-worker-client';
import { reactive, watch } from 'vue';
import { nativeBackupDisk } from '@/st/native-backups';
import { activeLibrary, activateLibrary, Library, ACTIVE_KEY, DB_PREFIX } from './db';
import { check, fingerprint } from './model';
import type { BackupResult } from './backup-worker-protocol';
import { AUTO_BACKUP_INTERVAL, AUTO_BACKUP_KEEP, CoreBackups, backupFailure, backupSettings, type BackupInventory, type BackupOutcome, type BackupSettings } from './core-backups';
import { BACKUP_HEALTH_LIMIT, BackupHealthHistory, type BackupHealth } from './backup-health';
import { ensureReviewSourceRepair } from './review-source-repair';

export const BACKUP_WAITING_STATUS = '自动备份已启用，等待前台稳定状态';
const BACKUP_FAILED_STATUS = '备份失败，旧备份保留；请查看原因后重试';
/** Display the same archive gates used by startup without changing scheduler policy. */
export function backupArchiveBlockReason(state: { pending: boolean; error: string; conflict: boolean; tableError: string }): string {
    if (state.error) return `归档未完成：${state.error}`;
    if (state.conflict) return '档案绑定冲突，请先核对当前聊天的档案';
    if (state.tableError) return `表格处理未完成：${state.tableError}`;
    return state.pending ? '等待当前聊天归档完成' : '';
}

export const coreBackupState = reactive({
    available: false, enabled: false, keep: AUTO_BACKUP_KEEP as typeof AUTO_BACKUP_KEEP, busy: false,
    status: '尚未检查原生磁盘备份接口', error: '', lastSavedAt: 0, settingsVerified: false,
    library: '', backupError: '', settingsError: '', persistenceError: '', lastFileAt: 0, failureSince: 0, lastFailureAt: 0,
});
const healthHistory = new BackupHealthHistory();
let historicalInventory: Promise<BackupInventory> | undefined;
const hintRequests = new Set<string>();
function selectedLibrary() {
    try { return localStorage.getItem(ACTIVE_KEY) || `${DB_PREFIX}default`; }
    catch { return `${DB_PREFIX}default`; }
}
function applyHealth(library: string, health: BackupHealth, status?: string) {
    if (library !== selectedLibrary()) return;
    const changed = coreBackupState.library !== library;
    Object.assign(coreBackupState, { library, backupError: health.error, lastSavedAt: health.lastSavedAt,
        lastFileAt: health.lastFileAt, failureSince: health.failureSince, lastFailureAt: health.lastFailureAt,
        error: health.error || coreBackupState.settingsError, persistenceError: healthHistory.persistenceError });
    if (status) coreBackupState.status = status;
    else if (health.error) coreBackupState.status = BACKUP_FAILED_STATUS;
    else if (changed) coreBackupState.status = coreBackupState.enabled ? BACKUP_WAITING_STATUS : '自动备份未启用';
}
/** One directory-only inventory per session. Filename dates remain explicitly unverified hints. */
async function restoreFileHint(library: string) {
    if (!manager || hintRequests.has(library) || healthHistory.get(library).lastSavedAt) return;
    hintRequests.add(library);
    if (hintRequests.size > BACKUP_HEALTH_LIMIT) hintRequests.delete(hintRequests.values().next().value!);
    try {
        historicalInventory ??= manager.inventory();
        const [inventory, bank] = await Promise.all([historicalInventory, fingerprint(library)]);
        const latest = inventory.entries.find(entry => entry.bank === bank.slice(0, 16) &&
            ['auto', 'manual', 'before-restore', 'after-archive-deletion'].includes(entry.kind));
        if (latest) applyHealth(library, healthHistory.fileHint(library, latest.savedAt));
    } catch { /* Hints never suppress the actual failure or start a full-package read. */ }
}
/** Called on the existing archive revision/activation signals; no extra polling or database reads. */
export function syncCoreBackupHealth() {
    const library = selectedLibrary();
    if (coreBackupState.library !== library) applyHealth(library, healthHistory.get(library));
    void restoreFileHint(library);
}
function recordFailure(library: string, error: unknown, status = BACKUP_FAILED_STATUS) {
    applyHealth(library, healthHistory.failed(library, backupFailure(error)), status);
}
function recordOutcome(library: string, result: BackupOutcome) {
    if (result.state === 'saved') {
        check(result.entry.sourceLibrary === library, '后台备份来源库不匹配');
        manager?.cachePreview(result.entry);
        applyHealth(library, healthHistory.saved(library, result.entry.savedAt), result.warning ?? '核心包已写入并读回验证');
    } else if (result.state === 'unchanged') {
        applyHealth(library, healthHistory.validated(library), '核心数据未变化，已有备份已验证');
    } else if (library === selectedLibrary() && !coreBackupState.error) {
        coreBackupState.status = result.state === 'too-soon' ? '尚未到下一次自动备份时间' : '当前核心库为空，未生成备份';
    }
}
function reportPendingNative(message: string, library: string) {
    if (library !== selectedLibrary()) return;
    coreBackupState.error = message;
    coreBackupState.status = '后台处理已停止，等待原生磁盘操作确认';
}
/** Explicit retry only resets scheduler backoff, never the validation baseline. */
export function retryCoreBackups() { retryCheck?.(); }
let manager: CoreBackups | undefined;
let connecting: Promise<CoreBackups> | undefined;

export async function getCoreBackups(): Promise<CoreBackups> {
    syncCoreBackupHealth();
    if (manager) return manager;
    return connecting ??= (async () => {
        try {
            const disk = await nativeBackupDisk();
            let settings = backupSettings(undefined), settingsError = '';
            try { settings = backupSettings(await disk.readSettings()); }
            catch (error) { settingsError = backupFailure(error); }
            manager = new CoreBackups(disk);
            Object.assign(coreBackupState, { available: true, enabled: settings.enabled, keep: settings.keep,
                settingsVerified: !settingsError, settingsError });
            const library = selectedLibrary(), health = healthHistory.get(library);
            applyHealth(library, health, health.error ? BACKUP_FAILED_STATUS : settingsError
                ? '备份设置无法读取，自动备份已关闭；仍可查看和恢复文件'
                : settings.enabled ? BACKUP_WAITING_STATUS : '自动备份未启用');
            void restoreFileHint(library);
            return manager;
        } catch (error) {
            coreBackupState.settingsError = backupFailure(error);
            coreBackupState.error = coreBackupState.backupError || coreBackupState.settingsError;
            coreBackupState.status = '磁盘备份不可用或设置读取失败';
            throw error;
        } finally { connecting = undefined; }
    })();
}

/** No main-thread parsing fallback: unavailable Workers leave the file unverified. */
export async function readCoreBackupPreview(key: string, isCurrent: () => boolean) {
    const backups = await getCoreBackups();
    return backups.runExclusive(async () => {
        if (!isCurrent()) throw new Error('备份选择已改变');
        const result = await runBackupWorker(backups.disk, { kind: 'preview', key }, isCurrent);
        if (result.state !== 'preview' || result.entry.key !== key || !isCurrent()) throw new Error('备份选择已改变');
        await backups.rememberPreview(result.entry);
        if (!isCurrent()) throw new Error('备份选择已改变');
        return result.entry;
    });
}

/** Prepare known metadata repairs before callers capture their final write/export guard. */
export async function prepareCoreBackup(lib: Library, isCurrent: () => boolean) {
    try { return await ensureReviewSourceRepair(lib, isCurrent); }
    catch (error) {
        if (isCurrent()) recordFailure(lib.db.name, error);
        throw error;
    }
}

/** Large packages never cross the UI boundary. Keep each native job in the same
 * writer queue used by automatic backups, including draining uncertain native IO. */
export async function saveCoreBackup(lib: Library, kind: 'manual' | 'before-restore', keep: typeof AUTO_BACKUP_KEEP,
    isCurrent: () => boolean): Promise<BackupOutcome> {
    const library = lib.db.name;
    try {
        const backups = await getCoreBackups();
        const result = await backups.runExclusive(() => runBackupWorker(backups.disk,
            { kind, library, keep }, isCurrent, undefined, message => reportPendingNative(message, library)));
        check(['saved', 'unchanged', 'too-soon', 'empty'].includes(result.state), '后台备份结果不匹配');
        recordOutcome(library, result as BackupOutcome);
        return result as BackupOutcome;
    } catch (error) {
        if (isCurrent()) recordFailure(library, error);
        throw error;
    }
}

export async function pinCoreBackup(key: string, checksum: string, isCurrent: () => boolean) {
    const library = selectedLibrary();
    const backups = await getCoreBackups();
    const result = await backups.runExclusive(() => runBackupWorker(backups.disk,
        { kind: 'pin', key, checksum }, isCurrent, undefined, message => reportPendingNative(message, library)));
    check(result.state === 'pinned', '后台固定备份结果不匹配');
    backups.cachePreview(result.entry);
    return result.entry;
}

async function activatePrepared(result: BackupResult, isCurrent: () => boolean): Promise<Library> {
    check(result.state === 'restored' && isCurrent(), '恢复页面已改变，已验证的新库未启用，原库保留');
    const lib = await Library.open(result.library, true);
    try {
        // readDailySettings and the final synchronous guard still precede selector publication.
        await activateLibrary(lib, isCurrent);
        syncCoreBackupHealth();
        return lib;
    } catch (error) { lib.close(); throw error; }
}

/** Caller holds serializeDailyActivation through preparation and final activation. */
export async function restoreCoreBackup(key: string, checksum: string, isCurrent: () => boolean): Promise<Library> {
    const library = selectedLibrary();
    const backups = await getCoreBackups();
    return backups.runExclusive(async () => activatePrepared(await runBackupWorker(backups.disk,
        { kind: 'restore', key, checksum }, isCurrent, undefined, message => reportPendingNative(message, library)), isCurrent));
}

/** Browser file operations do not require TauriTavern's native backup interface. */
export async function exportCoreLibrary(lib: Library, isCurrent: () => boolean) {
    try {
        const result = await runBackupWorker(undefined, { kind: 'export', library: lib.db.name }, isCurrent);
        check(result.state === 'exported' && result.blob instanceof Blob && isCurrent(), '导出页面或档案已改变，请重试');
        return { blob: result.blob, version: result.version };
    } catch (error) {
        if (isCurrent()) recordFailure(lib.db.name, error, '核心包导出失败；请展开备份区查看原因');
        throw error;
    }
}

export async function restoreCorePackage(blob: Blob, isCurrent: () => boolean): Promise<Library> {
    return activatePrepared(await runBackupWorker(undefined, { kind: 'import', blob }, isCurrent), isCurrent);
}

export async function configureCoreBackups(enabled: boolean, keep: typeof AUTO_BACKUP_KEEP) {
    const backups = await getCoreBackups();
    // Stop scheduling locally before an uncertain settings write/read. Enabling only
    // takes effect after readback, so a settings IO error cannot silently start work.
    coreBackupState.enabled = false; coreBackupState.settingsVerified = false;
    const settings: BackupSettings = { schema: 1, enabled, keep };
    try {
        await backups.disk.writeSettings(settings);
        const persisted = await backups.disk.readSettings();
        const saved = backupSettings(persisted);
        // Migration is for loading old settings, not proof that a new write persisted.
        if ((persisted as BackupSettings)?.keep !== keep || JSON.stringify(settings) !== JSON.stringify(saved)) throw new Error('备份设置读回不一致');
    } catch (error) {
        const message = `本次会话已暂停；${enabled ? '启用' : '关闭'}设置未确认保存，重启后可能按旧设置或已写入设置启用。${backupFailure(error)}`;
        coreBackupState.status = '备份设置保存结果未确认'; coreBackupState.settingsError = message;
        coreBackupState.error = coreBackupState.backupError || message;
        throw new Error(message);
    }
    Object.assign(coreBackupState, { enabled, keep, settingsVerified: true, settingsError: '', error: coreBackupState.backupError,
        status: coreBackupState.backupError ? BACKUP_FAILED_STATUS : enabled ? BACKUP_WAITING_STATUS : '自动备份已关闭，旧文件保留' });
    requestCheck?.();
}

export interface BackupSchedulerOptions {
    visible(): boolean;
    enabled(): boolean;
    ready(): boolean;
    run(): Promise<void>;
    error(error: unknown): void;
}

/** One pending timer and one in-flight run. Hidden/shutdown cancels future work.
 * A failed write is never retried in a tight loop (5/10/20/30 minute backoff).
 */
export function createBackupScheduler(options: BackupSchedulerOptions) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false, busy = false, failures = 0, nextAllowed = 0;
    const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const schedule = (delay: number) => {
        clear();
        if (!stopped && options.enabled() && options.visible()) timer = setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
        timer = undefined;
        if (stopped || busy || !options.enabled() || !options.visible()) return;
        if (Date.now() < nextAllowed) { schedule(nextAllowed - Date.now()); return; }
        if (!options.ready()) { schedule(30_000); return; }
        busy = true;
        try {
            await options.run();
            failures = 0;
            nextAllowed = Date.now() + AUTO_BACKUP_INTERVAL;
        } catch (error) {
            failures++;
            nextAllowed = Date.now() + Math.min(AUTO_BACKUP_INTERVAL, 5 * 60_000 * 2 ** Math.min(failures - 1, 3));
            options.error(error);
        } finally {
            busy = false;
            schedule(Math.max(30_000, nextAllowed - Date.now()));
        }
    };
    return {
        request: () => { if (!busy) schedule(Math.max(30_000, nextAllowed - Date.now())); },
        retry: () => { if (!busy) { nextAllowed = 0; schedule(30_000); } },
        stop: () => { stopped = true; clear(); },
    };
}

let retryCheck: (() => void) | undefined;
let requestCheck: (() => void) | undefined;
let bound = false;
/** Called from plugin startup; guard comes from the bridge, avoiding a core dependency cycle. */
export function bindCoreBackups(ready: () => boolean, revision: () => unknown = () => undefined) {
    if (bound) return;
    bound = true;
    syncCoreBackupHealth();
    let alive = true;
    const scheduler = createBackupScheduler({
        visible: () => document.visibilityState === 'visible',
        enabled: () => coreBackupState.enabled,
        ready: () => ready() && !coreBackupState.busy,
        run: async () => {
            coreBackupState.busy = true;
            let library = selectedLibrary();
            let current = () => alive && ready() && document.visibilityState === 'visible' && coreBackupState.enabled && library === selectedLibrary();
            try {
                const backups = await getCoreBackups(), lib = await activeLibrary();
                library = lib.db.name;
                await ensureReviewSourceRepair(lib, current);
                const selected = localStorage.getItem(ACTIVE_KEY), stamp = revision();
                current = () => alive && ready() && document.visibilityState === 'visible' && coreBackupState.enabled &&
                    selected === localStorage.getItem(ACTIVE_KEY) && stamp === revision();
                const result = await backups.runExclusive(() => runBackupWorker(backups.disk,
                    { kind: 'auto', library, keep: coreBackupState.keep }, current, undefined,
                    message => reportPendingNative(message, library))) as BackupOutcome;
                recordOutcome(library, result);
            } catch (error) {
                if (current()) recordFailure(library, error);
                throw error;
            } finally { coreBackupState.busy = false; }
        },
        // run records the error against its captured library before the scheduler backs off.
        error: () => {},
    });
    requestCheck = scheduler.request;
    retryCheck = scheduler.retry;
    const request = () => { syncCoreBackupHealth(); scheduler.request(); };
    const unwatch = watch(revision, request);
    const visibility = request;
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', () => {
        alive = false;
        scheduler.stop();
        unwatch();
        document.removeEventListener('visibilitychange', visibility);
        requestCheck = undefined; retryCheck = undefined;
    }, { once: true });
    void getCoreBackups().then(scheduler.request).catch(() => {});
}
