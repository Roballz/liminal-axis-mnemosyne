import BackupWorker from './core-backup.worker?worker&inline';
import type { BackupDisk } from '@/st/native-backups';
import type { BackupJob, BackupResult, HostMessage, WorkerMessage, DiskRequest } from './backup-worker-protocol';

/** Only Blobs, file keys and small previews cross the UI boundary. Full packages,
 * IndexedDB snapshot reads, parsing, hashing and validation stay in the worker.
 * There is deliberately no synchronous/main-thread fallback on unsupported WebViews.
 */
export function runBackupWorker(disk: BackupDisk, job: BackupJob, isCurrent: () => boolean,
    createWorker: () => Worker = () => new BackupWorker(),
    onPendingNative?: (message: string) => void): Promise<BackupResult> {
    const unavailable = job.kind === 'preview'
        ? '后台校验线程不可用；所选文件仍未验证，未恢复或删除。请重新加载插件后重试（需要宿主允许 Web Worker）；此前手动导出的核心包仍可在“档案 / 迁移”导入'
        : '后台备份线程不可用；已暂停本次备份，旧备份保留。请重新加载插件后重试（需要宿主允许 Web Worker）';
    return new Promise((resolve, reject) => {
        let worker: Worker;
        try { worker = createWorker(); } catch { reject(new Error(unavailable)); return; }
        let finished = false, started = false;
        const inFlight = new Set<Promise<void>>();
        // Bound a broken startup/worker without releasing the disk writer reservation
        // while a native operation is still pending. Stopping JS is not cancelling IO.
        let timer: ReturnType<typeof setTimeout>;
        const finish = (error?: Error, result?: BackupResult) => {
            if (finished) return;
            finished = true; clearTimeout(timer);
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            worker.removeEventListener('messageerror', onError);
            worker.terminate();
            if (error && inFlight.size) {
                // Native calls cannot be cancelled here. Make the blocked state visible
                // while retaining the reservation; never start a competing write.
                try { onPendingNative?.(`${error.message}；原生磁盘操作结果尚未确认，正在等待返回；不会继续写入或轮换`); } catch { /* reporting must not release the lock */ }
            }
            void Promise.allSettled([...inFlight]).then(() => error ? reject(error) : resolve(result!));
        };
        const send = (message: HostMessage) => {
            if (finished) return;
            try { worker.postMessage(message); } catch { finish(new Error(unavailable)); }
        };
        const onError = () => finish(new Error(unavailable));
        const execute = async (request: DiskRequest): Promise<unknown> => {
            // Detail jobs can only read their exact selected backup, never mutate disk.
            if (job.kind === 'preview' && (request.method !== 'read' || request.key !== job.key || !isCurrent()))
                throw new Error('备份选择已改变或校验请求越界');
            switch (request.method) {
                case 'guard': return isCurrent();
                case 'list': return disk.list();
                case 'readPreviews': return disk.readPreviews?.();
                case 'writePreviews':
                    if (!isCurrent()) throw new Error('档案状态改变，暂不保存预览元数据');
                    return disk.writePreviews?.(request.value);
                case 'read': return disk.read(request.key);
                case 'write':
                    // Recheck on the main thread immediately before native side effects,
                    // not only before the asynchronous worker roundtrip.
                    if (!isCurrent()) throw new Error('档案仍在变化，本次备份已取消');
                    return disk.write(request.key, request.blob);
                case 'remove':
                    if (!isCurrent()) throw new Error('档案状态改变，保留新备份并暂停轮换');
                    return disk.remove(request.key);
                default: throw new Error('后台备份请求无效');
            }
        };
        const onMessage = (event: MessageEvent<WorkerMessage>) => {
            if (finished) return;
            const message = event.data;
            if (message.type === 'ready') {
                if (started) return;
                started = true; clearTimeout(timer);
                timer = setTimeout(() => finish(new Error('后台备份处理超时，旧备份保留；请稍后重试')), 5 * 60_000);
                send({ type: 'start', job });
            } else if (message.type === 'rpc' && started) {
                const task = execute(message).then(result => send({ type: 'reply', id: message.id, result }),
                    error => send({ type: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) }));
                inFlight.add(task);
                void task.finally(() => inFlight.delete(task));
            } else if (message.type === 'done') finish(undefined, message.result);
            else if (message.type === 'failed') finish(new Error(message.error));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onError);
        timer = setTimeout(onError, 15_000);
    });
}
