import { reorganizeCoreLibrary } from './core-reorganization';
import { BACKUP_MAX_BYTES, CoreBackups, corePackageSizeError } from './core-backups';
import { Library } from './db';
import { exportLibrary, restoreLibrary } from './migration';
import { parseStrictJson } from './json';
import { check } from './model';
import { measureCorePackageSize } from './core-package-size';
import { archivePackage, exportArchive, packageData, restoreArchive } from './archive-package';
import { cleanLibraryHistory } from './history-cleanup';
import type { BackupDisk } from '@/st/native-backups';
import type { DiskCall, DiskRequest, HostMessage, WorkerMessage } from './backup-worker-protocol';

const send = (message: WorkerMessage) => self.postMessage(message);
let sequence = 0, started = false;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
function rpc(request: DiskCall): Promise<any> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ ...request, type: 'rpc', id } as DiskRequest);
    });
}
// Native disk calls stay on the host. Full restores use a new database; archive
// restores and explicit cleanup commit a validated, write-stamped plan in place.
const disk: BackupDisk = {
    list: () => rpc({ method: 'list' }),
    read: key => rpc({ method: 'read', key }),
    write: (key, blob) => rpc({ method: 'write', key, blob }),
    remove: key => rpc({ method: 'remove', key }),
    readSettings: async () => { throw new Error('Worker cannot read settings'); },
    writeSettings: async () => { throw new Error('Worker cannot write settings'); },
    readPreviews: () => rpc({ method: 'readPreviews' }),
    writePreviews: value => rpc({ method: 'writePreviews', value }),
};
self.onmessage = async (event: MessageEvent<HostMessage>) => {
    const message = event.data;
    if (message.type === 'reply') {
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        if (message.error !== undefined) call.reject(new Error(message.error)); else call.resolve(message.result);
        return;
    }
    if (started) return;
    started = true;
    let lib: Library | undefined;
    try {
        const backups = new CoreBackups(disk), guard = () => rpc({ method: 'guard' });
        if (message.job.kind === 'preview') {
            const { entry } = await backups.read(message.job.key);
            send({ type: 'done', result: { state: 'preview', entry } });
            return;
        }
        check(await guard(), '备份或迁移页面已改变');
        if (message.job.kind === 'pin') {
            const entry = await backups.pin(message.job.key, message.job.checksum, guard);
            send({ type: 'done', result: { state: 'pinned', entry } });
            return;
        }
        if (message.job.kind === 'restore' || message.job.kind === 'import') {
            if (message.job.kind === 'restore') lib = await backups.prepareRestore(message.job.key, message.job.checksum, guard);
            else {
                const blob = message.job.blob;
                check(blob instanceof Blob && blob.size > 0, '核心包为空或无效');
                check(blob.size <= BACKUP_MAX_BYTES, `${corePackageSizeError(blob.size)}；未创建恢复库，原库保留`);
                const pack = parseStrictJson(await blob.text(), BACKUP_MAX_BYTES);
                check(await guard(), '恢复页面已改变，原库保留');
                lib = await restoreLibrary(pack, false);
            }
            check(await guard(), '恢复页面已改变，已验证的新库未启用，原库保留');
            send({ type: 'done', result: { state: 'restored', library: lib.db.name } });
            return;
        }
        lib = await Library.open(message.job.library, true);
        if (message.job.kind === 'archive-import' || message.job.kind === 'archive-restore') {
            let value: unknown;
            if (message.job.kind === 'archive-restore') {
                const selected = await backups.read(message.job.key);
                check(selected.entry.checksum === message.job.checksum, '所选备份已改变，请重新预览');
                value = selected.file.pack;
            } else {
                const blob = message.job.blob;
                check(blob instanceof Blob && blob.size > 0 && blob.size <= BACKUP_MAX_BYTES, '核心包为空或超过导入大小上限');
                value = parseStrictJson(await blob.text(), BACKUP_MAX_BYTES);
            }
            check(archivePackage(value), '请选择单档案包；旧整库备份请使用整库恢复');
            const report = await restoreArchive(lib, value, guard, { branch: message.job.branch, scope: message.job.scope });
            send({ type: 'done', result: { state: 'archive-restored', report } });
            return;
        }
        if (message.job.kind === 'reorganize' || message.job.kind === 'clean-history') {
            let lastProgress = 0, lastStage = '';
            const progress = (progress: import('./core-reorganization').ReorganizationProgress) => {
                const now = performance.now(), stage = `${progress.phase}:${progress.store}`;
                if (stage !== lastStage || now - lastProgress >= 200) {
                    lastStage = stage; lastProgress = now; send({ type: 'progress', progress });
                }
            };
            if (message.job.kind === 'clean-history') {
                const report = await cleanLibraryHistory(lib, guard, progress);
                send({ type: 'done', result: { state: 'history-cleaned', report } });
            } else {
                const report = await reorganizeCoreLibrary(lib, guard, progress);
                send({ type: 'done', result: { state: 'reorganized', report } });
            }
            return;
        }
        if (message.job.kind === 'size') {
            const report = await measureCorePackageSize(lib, guard);
            send({ type: 'done', result: { state: 'size', report } });
            return;
        }
        if (message.job.kind === 'export') {
            const pack = message.job.branch ? await exportArchive(lib, message.job.branch) : await exportLibrary(lib);
            const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
            check(await guard(), '导出页面或档案已改变，请重试');
            send({ type: 'done', result: { state: 'exported', blob, version: packageData(pack).version } });
            return;
        }
        const result = await backups.save(lib, message.job.kind, message.job.keep, guard,
            (entry, unchanged) => send({ type: 'verified', entry, ...(unchanged ? { unchanged } : {}) }), message.job.branch);
        send({ type: 'done', result });
    } catch (error) {
        send({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally { lib?.close(); }
};
send({ type: 'ready' });
