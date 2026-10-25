import BackupWorker from './core-backup.worker?worker&inline';
import type { BackupDisk } from '@/st/native-backups';
import type { BackupJob, BackupResult, HostMessage, WorkerMessage, DiskRequest } from './backup-worker-protocol';

/** Only Blobs, file keys and small previews cross the UI boundary. Full packages,
 * IndexedDB snapshot reads, parsing, hashing and validation stay in the worker.
 * There is deliberately no synchronous/main-thread fallback on unsupported WebViews.
 */
export function runBackupWorker(disk: BackupDisk | undefined, job: BackupJob, isCurrent: () => boolean,
    createWorker: () => Worker = () => new BackupWorker(),
    onPendingNative?: (message: string) => void): Promise<BackupResult> {
    const unavailable = job.kind === 'preview'
        ? '后台校验线程不可用；所选文件仍未验证，未恢复或删除。请重新加载插件后重试（需要宿主允许 Web Worker）'
        : job.kind === 'export' || job.kind === 'import' || job.kind === 'restore'
        ? '后台迁移线程不可用；本次导出或恢复未完成，原库保留。请重新加载插件后重试（需要宿主允许 Web Worker）'
        : '后台备份线程不可用；已暂停本次备份，旧备份保留。请重新加载插件后重试（需要宿主允许 Web Worker）';
    return new Promise((resolve, reject) => {
        let worker: Worker;
        try { worker = createWorker(); } catch { reject(new Error(unavailable)); return; }
        let finished = false, started = false;
        const written = new Set<string>();
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
            if (request.method === 'guard') return isCurrent();
            if (!disk || job.kind === 'export' || job.kind === 'import') throw new Error('迁移任务不允许访问原生备份文件');
            const writer = job.kind === 'auto' || job.kind === 'manual' || job.kind === 'before-restore' || job.kind === 'pin';
            if (request.method === 'read') {
                if ((job.kind === 'restore' || job.kind === 'pin') &&
                    (request.key !== job.key && !(job.kind === 'pin' && written.has(request.key)) || !isCurrent()) ||
                    (job.kind === 'manual' || job.kind === 'before-restore') && !written.has(request.key))
                    throw new Error('所选备份已改变或文件读取越界');
            } else if (request.method === 'remove' ? job.kind !== 'auto' : !writer)
                throw new Error('当前任务不允许修改或列出备份文件');
            switch (request.method) {
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
                    if (job.kind === 'pin' && (request.key === job.key || !request.key.startsWith('pinned-v1-')) ||
                        (job.kind === 'manual' || job.kind === 'before-restore') && !request.key.startsWith(`${job.kind}-v1-`))
                        throw new Error('备份写入类型或文件越界');
                    await disk.write(request.key, request.blob);
                    written.add(request.key);
                    return;
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
