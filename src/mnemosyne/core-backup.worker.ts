import { BACKUP_MAX_BYTES, CoreBackups } from './core-backups';
import { Library } from './db';
import { exportLibrary, restoreLibrary } from './migration';
import { parseStrictJson } from './json';
import { check } from './model';
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
// Native disk calls stay on the host. Explicit restore jobs may write only a new
// independent database; activation and host settings remain on the UI thread.
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
                check(blob instanceof Blob && blob.size > 0 && blob.size <= BACKUP_MAX_BYTES, '核心包为空或超过 64 MiB 导入上限');
                const pack = parseStrictJson(await blob.text(), BACKUP_MAX_BYTES);
                check(await guard(), '恢复页面已改变，原库保留');
                lib = await restoreLibrary(pack, false);
            }
            check(await guard(), '恢复页面已改变，已验证的新库未启用，原库保留');
            send({ type: 'done', result: { state: 'restored', library: lib.db.name } });
            return;
        }
        lib = await Library.open(message.job.library, true);
        if (message.job.kind === 'export') {
            const pack = await exportLibrary(lib);
            const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
            check(await guard(), '导出页面或档案已改变，请重试');
            send({ type: 'done', result: { state: 'exported', blob, version: pack.version } });
            return;
        }
        const result = await backups.save(lib, message.job.kind, message.job.keep, guard);
        send({ type: 'done', result });
    } catch (error) {
        send({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally { lib?.close(); }
};
send({ type: 'ready' });
