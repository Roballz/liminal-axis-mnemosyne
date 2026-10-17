import { runBackupWorker } from './backup-worker-client';
import { reactive, watch } from 'vue';
import { nativeBackupDisk } from '@/st/native-backups';
import { activeLibrary, ACTIVE_KEY } from './db';
import { AUTO_BACKUP_INTERVAL, AUTO_BACKUP_KEEP, CoreBackups, backupFailure, backupSettings, type BackupSettings } from './core-backups';

export const BACKUP_WAITING_STATUS = '自动备份已启用，等待前台稳定状态';
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
});
function reportPendingNative(message: string) {
    coreBackupState.error = message;
    coreBackupState.status = '后台处理已停止，等待原生磁盘操作确认';
}
/** Explicit retry only resets scheduler backoff, never the validation baseline. */
export function retryCoreBackups() { retryCheck?.(); }
let manager: CoreBackups | undefined;
let connecting: Promise<CoreBackups> | undefined;

export async function getCoreBackups(): Promise<CoreBackups> {
    if (manager) return manager;
    return connecting ??= (async () => {
        try {
            const disk = await nativeBackupDisk();
            let settings = backupSettings(undefined), settingsError = '';
            try { settings = backupSettings(await disk.readSettings()); }
            catch (error) { settingsError = backupFailure(error); }
            manager = new CoreBackups(disk);
            Object.assign(coreBackupState, { available: true, enabled: settings.enabled, keep: settings.keep, settingsVerified: !settingsError,
                status: settingsError ? '备份设置无法读取，自动备份已关闭；仍可查看和恢复文件' :
                    settings.enabled ? BACKUP_WAITING_STATUS : '自动备份未启用', error: settingsError });
            return manager;
        } catch (error) {
            coreBackupState.error = backupFailure(error);
            coreBackupState.status = '磁盘备份不可用或设置读取失败';
            throw error;
        } finally { connecting = undefined; }
    })();
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
        coreBackupState.status = '备份设置保存结果未确认'; coreBackupState.error = message;
        throw new Error(message);
    }
    Object.assign(coreBackupState, { enabled, keep, settingsVerified: true, error: '', status: enabled ? BACKUP_WAITING_STATUS : '自动备份已关闭，旧文件保留' });
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
    let alive = true;
    const scheduler = createBackupScheduler({
        visible: () => document.visibilityState === 'visible',
        enabled: () => coreBackupState.enabled,
        ready: () => ready() && !coreBackupState.busy,
        run: async () => {
            coreBackupState.busy = true;
            try {
                const backups = await getCoreBackups(), lib = await activeLibrary();
                const selected = localStorage.getItem(ACTIVE_KEY), stamp = revision();
                const result = await backups.runExclusive(() => runBackupWorker(backups.disk,
                    { kind: 'auto', library: lib.db.name, keep: coreBackupState.keep },
                    () => alive && ready() && document.visibilityState === 'visible' && coreBackupState.enabled &&
                        selected === localStorage.getItem(ACTIVE_KEY) && stamp === revision(), undefined, reportPendingNative)) as import('./core-backups').BackupOutcome;
                coreBackupState.error = '';
                if (result.state === 'saved') {
                    coreBackupState.lastSavedAt = result.entry.savedAt;
                    coreBackupState.status = result.warning ?? '自动磁盘备份已写入并读回验证，继续按当前档案运行';
                } else coreBackupState.status = result.state === 'unchanged' ? '核心数据未变化，保留已有备份' : '尚未到下一次自动备份时间';
            } finally { coreBackupState.busy = false; }
        },
        error: error => { coreBackupState.error = backupFailure(error); coreBackupState.status = '自动备份暂缓，旧备份保留；会延后重试，也可手动重试检查'; },
    });
    requestCheck = scheduler.request;
    retryCheck = scheduler.retry;
    const unwatch = watch(revision, scheduler.request);
    const visibility = () => scheduler.request();
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
