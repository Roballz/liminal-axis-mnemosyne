import { runBackupWorker } from './backup-worker-client';
import { reactive, watch } from 'vue';
import { toast } from '@/st/toast';
import { BACKUP_LOCATION, nativeBackupDisk } from '@/st/native-backups';
import { deletionBeforeSync } from './deletion-protection';
import type { ArchiveDeletionPlan } from './archive-deletion';
import type { CapturedView } from './model';
import type { HostObservation } from './canonical';
import { activeLibrary, ACTIVE_KEY, type Library } from './db';
import { AUTO_BACKUP_INTERVAL, CoreBackups, backupFailure, backupSettings, type BackupSettings, type BackupPreview } from './core-backups';

export const BACKUP_WAITING_STATUS = '自动备份已启用，等待前台稳定状态';
/** Display the same archive gates used by startup without changing scheduler policy. */
export function backupArchiveBlockReason(state: { pending: boolean; error: string; conflict: boolean; tableError: string }): string {
    if (state.error) return `归档未完成：${state.error}`;
    if (state.conflict) return '档案绑定冲突，请先核对当前聊天的档案';
    if (state.tableError) return `表格处理未完成：${state.tableError}`;
    return state.pending ? '等待当前聊天归档完成' : '';
}

export const coreBackupState = reactive({
    available: false, enabled: false, keep: 10 as 5 | 10, busy: false,
    status: '尚未检查原生磁盘备份接口', error: '', lastSavedAt: 0, protectionNotice: '', settingsVerified: false,
});
const notifiedProtections = new Set<string>();
function reportPendingNative(message: string) {
    coreBackupState.error = message;
    coreBackupState.status = '后台处理已停止，等待原生磁盘操作确认';
}
export function reportDeletionProtection(entry: BackupPreview, current = false) {
    const message = `检测到正文消失被删除，已自动备份最近核心包，路径：${BACKUP_LOCATION}${entry.key}。核心包时间：${new Date(entry.snapshotAt).toLocaleString()}；${current ? '已在应用本次删除前导出当前已归档核心库。' : '这是最近已保存的完整核心包，不保证包含删除前尚未备份的楼层。'}`;
    if (notifiedProtections.has(entry.key)) return;
    coreBackupState.protectionNotice = message;
    notifiedProtections.add(entry.key);
    toast(message, 'warning', true);
}
let deletionFailure: { library: string; retryAt: number; failures: number; message: string } | undefined;
export function retryDeletionProtection() { deletionFailure = undefined; }
/** Runs inside the bridge source-sync queue, before canonical head/body mutation. */
export async function protectDeletionBeforeSync(lib: Library, input: HostObservation, isCurrent: () => boolean, cached?: CapturedView) {
    // Startup settings loading may still be in flight. Do not let it race the first sync.
    if (connecting) await connecting.catch(() => {});
    if (!coreBackupState.enabled && (!coreBackupState.available || coreBackupState.settingsVerified)) return;
    const expected = await deletionBeforeSync(lib, input, cached);
    if (!expected) return {};
    if (!expected.needsProtection) return { branch: expected.branch, binding: expected.binding };
    if (deletionFailure?.library === lib.db.name && Date.now() < deletionFailure.retryAt) throw new Error(deletionFailure.message);
    try {
        if (!coreBackupState.settingsVerified) throw new Error('自动备份设置未确认，不能安全应用正文删除；请先重新确认备份设置');
        const backups = await getCoreBackups();
        const entry = await backups.runExclusive(() => runBackupWorker(backups.disk,
            { kind: 'protect-deletion', library: lib.db.name, expected: expected.branch }, isCurrent, undefined, undefined, reportPendingNative)) as BackupPreview;
        reportDeletionProtection(entry, true);
        deletionFailure = undefined;
        coreBackupState.error = '';
        coreBackupState.status = '删除前保护已验证，正在归档当前聊天；完成后自动备份继续';
        return { branch: expected.branch, binding: expected.binding };
    } catch (error) {
        coreBackupState.error = `删除前保护未完成，当前核心档案保留，尚未应用删除：${backupFailure(error)}`;
        const failures = deletionFailure?.library === lib.db.name ? deletionFailure.failures + 1 : 1;
        deletionFailure = { library: lib.db.name, failures, retryAt: Date.now() + Math.min(AUTO_BACKUP_INTERVAL, 5 * 60_000 * 2 ** Math.min(failures - 1, 3)), message: coreBackupState.error };
        coreBackupState.status = '删除归档暂缓，已限制失败重试频率；可点重试删除前保护 / 归档';
        throw new Error(coreBackupState.error);
    }
}
export function reportArchiveProtection(entry: BackupPreview, current: boolean) {
    const message = `检测到档案删除，已保存核心包保护副本，路径：${BACKUP_LOCATION}${entry.key}。核心包时间：${new Date(entry.snapshotAt).toLocaleString()}。${current ? '已在删除档案前导出当前核心库。' : '这是最近已保存的旧包，不保证包含此前尚未备份的数据。'}`;
    if (notifiedProtections.has(entry.key)) return;
    notifiedProtections.add(entry.key); coreBackupState.protectionNotice = message;
    toast(message, 'warning', true);
}
export async function protectArchiveBeforeDeletion(lib: Library, plan: ArchiveDeletionPlan, guard: () => boolean) {
    if (connecting) await connecting.catch(() => {});
    if (!coreBackupState.enabled && (!coreBackupState.available || coreBackupState.settingsVerified)) return false;
    if (!coreBackupState.settingsVerified) throw new Error('备份设置结果未确认，请先重新确认设置；尚未删除档案');
    const entry = await (await getCoreBackups()).protectArchiveDeletion(lib, plan, guard);
    reportArchiveProtection(entry, true);
    return true;
}
export async function completeArchiveBackup(lib: Library, plan: ArchiveDeletionPlan, guard: () => boolean) {
    try {
        const result = await (await getCoreBackups()).completeArchiveDeletion(lib, plan, guard);
        coreBackupState.error = '';
        coreBackupState.status = result.state === 'empty'
            ? '最后一个档案已删除；删除前保护保留。当前库为空，不写空备份或轮换，请有新档案后核对新起点'
            : '档案已删除，删除后的备份起点已写入并验证，自动备份可继续';
        requestCheck?.();
    } catch (error) {
        coreBackupState.status = '档案已删除，删除前保护保留；自动备份新起点待恢复';
        coreBackupState.error = `档案删除已完成，但新起点保存失败：${backupFailure(error)}。请使用“保护旧包并接受当前档案”重试，不必再次删除。`;
    }
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

export async function configureCoreBackups(enabled: boolean, keep: 5 | 10) {
    const backups = await getCoreBackups();
    // Stop scheduling locally before an uncertain settings write/read. Enabling only
    // takes effect after readback, so a settings IO error cannot silently start work.
    coreBackupState.enabled = false; coreBackupState.settingsVerified = false;
    const settings: BackupSettings = { schema: 1, enabled, keep };
    try {
        await backups.disk.writeSettings(settings);
        const saved = backupSettings(await backups.disk.readSettings());
        if (JSON.stringify(settings) !== JSON.stringify(saved)) throw new Error('备份设置读回不一致');
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
                        selected === localStorage.getItem(ACTIVE_KEY) && stamp === revision(), entry => reportDeletionProtection(entry), undefined, reportPendingNative)) as import('./core-backups').BackupOutcome;
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
