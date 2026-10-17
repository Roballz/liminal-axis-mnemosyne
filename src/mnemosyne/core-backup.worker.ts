import { CoreBackups } from './core-backups';
import { Library } from './db';
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
// No host settings, restore, or database writes are exposed through this bridge.
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
        lib = await Library.open(message.job.library, true);
        const result = await backups.save(lib, 'auto', message.job.keep, guard);
        send({ type: 'done', result });
    } catch (error) {
        send({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally { lib?.close(); }
};
send({ type: 'ready' });
