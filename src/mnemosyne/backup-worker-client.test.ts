import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { runBackupWorker } from './backup-worker-client';
import { CoreBackups } from './core-backups';
import { Library, freshLibraryName } from './db';
import type { HostMessage, WorkerMessage } from './backup-worker-protocol';
import type { BackupDisk } from '@/st/native-backups';

class FakeWorker extends EventTarget {
    postMessage = vi.fn((_message: HostMessage) => {});
    terminate = vi.fn();
    emit(message: WorkerMessage) { this.dispatchEvent(new MessageEvent('message', { data: message })); }
}
const disk = (): BackupDisk => ({
    list: vi.fn(async () => []), read: vi.fn(async () => new Blob(['persisted'])),
    write: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    readSettings: vi.fn(), writeSettings: vi.fn(),
});
const job = { kind: 'auto' as const, library: 'mnemosyne_daily_test', keep: 20 as const };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function start(d = disk(), guard = () => true) {
    const worker = new FakeWorker();
    const result = runBackupWorker(d, job, guard, () => worker as unknown as Worker);
    worker.emit({ type: 'ready' });
    return { worker, result, disk: d };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('startup sends only database identity; disk RPC preserves Blob without parsing on UI', async () => {
    const { worker, result, disk: d } = start();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'start', job });
    const blob = new Blob(['not parsed by UI']);
    worker.emit({ type: 'rpc', id: 1, method: 'write', key: 'backup', blob }); await flush();
    expect(d.write).toHaveBeenCalledWith('backup', blob);
    worker.emit({ type: 'rpc', id: 2, method: 'read', key: 'backup' }); await flush();
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'reply', id: 2, result: expect.any(Blob) });
    worker.emit({ type: 'done', result: { state: 'unchanged' } });
    expect(await result).toEqual({ state: 'unchanged' }); expect(worker.terminate).toHaveBeenCalledOnce();
    expect(d.readSettings).not.toHaveBeenCalled(); expect(d.writeSettings).not.toHaveBeenCalled();
});

test('current-state guard is rechecked immediately before each native write and deletion', async () => {
    let current = true;
    const { worker, result, disk: d } = start(disk(), () => current);
    worker.emit({ type: 'rpc', id: 1, method: 'guard' }); await flush();
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ result: true });
    current = false; // changes after worker checked, before host side effects
    worker.emit({ type: 'rpc', id: 2, method: 'write', key: 'new', blob: new Blob() });
    worker.emit({ type: 'rpc', id: 3, method: 'remove', key: 'old' }); await flush();
    expect(d.write).not.toHaveBeenCalled(); expect(d.remove).not.toHaveBeenCalled();
    expect(worker.postMessage.mock.calls.slice(-2).every(([message]) => 'error' in message)).toBe(true);
    worker.emit({ type: 'failed', error: 'cancelled' }); await expect(result).rejects.toThrow('cancelled');
});

test('worker blocked/failed startup never falls back to main-thread backup', async () => {
    const d = disk();
    await expect(runBackupWorker(d, job, () => true, () => { throw new Error('CSP'); })).rejects.toThrow('Web Worker');
    expect(d.list).not.toHaveBeenCalled(); expect(d.write).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const result = runBackupWorker(d, job, () => true, () => worker as unknown as Worker);
    const rejected = expect(result).rejects.toThrow('Web Worker');
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

test('worker error drains already-issued native write before releasing shared writer queue', async () => {
    const d = disk(), manager = new CoreBackups(d), worker = new FakeWorker();
    let release!: () => void;
    d.write = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = vi.fn();
    const result = manager.runExclusive(() => runBackupWorker(d, job, () => true, () => worker as unknown as Worker, pending));
    await flush(); worker.emit({ type: 'ready' });
    worker.emit({ type: 'rpc', id: 1, method: 'write', key: 'new', blob: new Blob() }); await flush();
    const next = vi.fn(async () => {}), queued = manager.runExclusive(next);
    const rejected = expect(result).rejects.toThrow('Web Worker');
    worker.dispatchEvent(new Event('error')); await flush();
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled();
    expect(pending).toHaveBeenCalledWith(expect.stringContaining('结果尚未确认'));
    worker.emit({ type: 'rpc', id: 2, method: 'remove', key: 'old' }); expect(d.remove).not.toHaveBeenCalled();
    release(); await rejected; await queued; expect(next).toHaveBeenCalledOnce();
});

test('processing timeout retains writer reservation until outstanding native IO settles', async () => {
    vi.useFakeTimers();
    const d = disk(), worker = new FakeWorker(), manager = new CoreBackups(d), pending = vi.fn();
    let release!: () => void;
    d.write = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const result = manager.runExclusive(() => runBackupWorker(d, job, () => true, () => worker as unknown as Worker, pending));
    await flush(); worker.emit({ type: 'ready' });
    worker.emit({ type: 'rpc', id: 1, method: 'write', key: 'new', blob: new Blob() }); await flush();
    const next = vi.fn(async () => {}), queued = manager.runExclusive(next);
    const rejected = expect(result).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(next).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenCalledWith(expect.stringContaining('结果尚未确认'));
    worker.emit({ type: 'rpc', id: 2, method: 'remove', key: 'old' });
    expect(d.remove).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    release(); await rejected; await queued; expect(next).toHaveBeenCalledOnce();
});

test('worker existing-only database open never creates or upgrades a missing database', async () => {
    const name = freshLibraryName();
    await expect(Library.open(name, true)).rejects.toThrow();
    expect((await indexedDB.databases()).some(db => db.name === name)).toBe(false);
    const original = await Library.open(name), existing = await Library.open(name, true);
    expect(existing.db.name).toBe(original.db.name); original.close(); existing.close();
});


test('worker existing-only open aborts upgrade without modifying an older database', async () => {
    const name = freshLibraryName();
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => open.result.createObjectStore('old-data');
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    old.close();
    await expect(Library.open(name, true)).rejects.toThrow();
    const existing = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    expect(existing.version).toBe(1); expect([...existing.objectStoreNames]).toEqual(['old-data']); existing.close();
});
