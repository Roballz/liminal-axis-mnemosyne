import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { exportLibrary } from './migration';
import { Library, ACTIVE_KEY, freshLibraryName } from './db';
import type { BackupDisk } from '@/st/native-backups';
import type { BackupJob, BackupResult, HostMessage, WorkerMessage, DiskRequest } from './backup-worker-protocol';

class Disk implements BackupDisk {
    files = new Map<string, Blob>();
    list = vi.fn(async () => [...this.files.keys()]);
    read = vi.fn(async (key: string) => this.files.get(key)!);
    write = vi.fn(async (key: string, blob: Blob) => { this.files.set(key, blob); });
    remove = vi.fn(async (key: string) => { this.files.delete(key); });
    readSettings = vi.fn(async () => undefined);
    writeSettings = vi.fn(async () => {});
}

/** Run the actual worker entrypoint. Only its native RPC transport is simulated. */
async function workerJob(job: BackupJob, disk?: BackupDisk, current = () => true): Promise<BackupResult> {
    vi.resetModules();
    const messages: WorkerMessage[] = [];
    const execute = async (request: DiskRequest): Promise<unknown> => {
        if (request.method === 'guard') return current();
        if (!disk) throw new Error('unexpected native disk access');
        switch (request.method) {
            case 'list': return disk.list();
            case 'read': return disk.read(request.key);
            case 'write': return disk.write(request.key, request.blob);
            case 'remove': return disk.remove(request.key);
            case 'readPreviews': return disk.readPreviews?.();
            case 'writePreviews': return disk.writePreviews?.(request.value);
        }
    };
    const host = { onmessage: undefined as unknown as (event: { data: HostMessage }) => Promise<void>,
        postMessage: (message: WorkerMessage) => {
            messages.push(message);
            if (message.type === 'rpc') queueMicrotask(() => {
                void execute(message).then(result => host.onmessage({ data: { type: 'reply', id: message.id, result } }),
                    error => host.onmessage({ data: { type: 'reply', id: message.id, error: String(error.message) } }));
            });
        } };
    vi.stubGlobal('self', host);
    await import('./core-backup.worker');
    await host.onmessage({ data: { type: 'start', job } });
    const result = messages.at(-1)!;
    if (result.type === 'failed') throw new Error(result.error);
    if (result.type !== 'done') throw new Error('worker did not complete');
    return result.result;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('actual manual, protection, pin and disk-restore jobs verify files and prepare a fresh library without activation', async () => {
    const { lib } = await fixture(2), disk = new Disk();
    const selector = new Map([[ACTIVE_KEY, lib.db.name]]), setItem = vi.fn((key: string, value: string) => { selector.set(key, value); });
    vi.stubGlobal('localStorage', { getItem: (key: string) => selector.get(key), setItem });
    try {
        const original = await exportLibrary(lib);
        const saved = await workerJob({ kind: 'manual', library: lib.db.name, keep: 20 }, disk);
        if (saved.state !== 'saved') throw new Error('missing manual backup');
        expect(Object.keys(saved).sort()).toEqual(['entry', 'state']);
        const protection = await workerJob({ kind: 'before-restore', library: lib.db.name, keep: 20 }, disk);
        expect(protection.state).toBe('saved');
        const pinned = await workerJob({ kind: 'pin', key: saved.entry.key, checksum: saved.entry.checksum }, disk);
        expect(pinned.state).toBe('pinned');
        expect(disk.files.size).toBe(3);
        await expect(workerJob({ kind: 'pin', key: saved.entry.key, checksum: 'wrong' }, disk)).rejects.toThrow('所选备份已改变');
        expect(disk.files.size).toBe(3);
        const result = await workerJob({ kind: 'restore', key: saved.entry.key, checksum: saved.entry.checksum }, disk);
        if (result.state !== 'restored') throw new Error('missing prepared restore');
        expect(result.library).not.toBe(lib.db.name);
        const restored = await Library.open(result.library, true);
        try { expect((await exportLibrary(restored)).data).toEqual(original.data); }
        finally { restored.close(); }
        expect(selector.get(ACTIVE_KEY)).toBe(lib.db.name); expect(setItem).not.toHaveBeenCalled();
        expect(disk.remove).not.toHaveBeenCalled(); expect(disk.writeSettings).not.toHaveBeenCalled();
    } finally { lib.close(); }
});

test('empty current library permits protection skip without publishing or rotating', async () => {
    const lib = await Library.open(freshLibraryName()), disk = new Disk();
    try {
        expect(await workerJob({ kind: 'before-restore', library: lib.db.name, keep: 20 }, disk)).toEqual({ state: 'empty' });
        expect(disk.write).not.toHaveBeenCalled(); expect(disk.remove).not.toHaveBeenCalled();
    } finally { lib.close(); }
});

test('raw export/import jobs work without a native disk and return only Blob or verified library identity', async () => {
    const { lib } = await fixture(2);
    const setItem = vi.fn(); vi.stubGlobal('localStorage', { getItem: () => lib.db.name, setItem });
    try {
        const result = await workerJob({ kind: 'export', library: lib.db.name });
        if (result.state !== 'exported') throw new Error('missing export');
        expect(Object.keys(result).sort()).toEqual(['blob', 'state', 'version']);
        expect(result.blob).toBeInstanceOf(Blob);
        const restored = await workerJob({ kind: 'import', blob: result.blob });
        if (restored.state !== 'restored') throw new Error('missing import');
        expect(Object.keys(restored).sort()).toEqual(['library', 'state']);
        const copy = await Library.open(restored.library, true);
        try { expect((await exportLibrary(copy)).data).toEqual((await exportLibrary(lib)).data); }
        finally { copy.close(); }
        expect(setItem).not.toHaveBeenCalled();
    } finally { lib.close(); }
});

test.each(['duplicate-json', 'checksum', 'body'] as const)('invalid %s import is rejected before creating any replacement database', async kind => {
    const { lib } = await fixture(1);
    try {
        const pack = await exportLibrary(lib);
        if (kind === 'checksum') pack.checksum = 'invalid';
        if (kind === 'body') (pack.data.source_bodies[0] as any).content = 'same synthetic source changed';
        const blob = new Blob([kind === 'duplicate-json' ? '{"format":1,"format":2}' : JSON.stringify(pack)]);
        const before = await indexedDB.databases();
        await expect(workerJob({ kind: 'import', blob })).rejects.toThrow(kind === 'duplicate-json' ? '重复字段' : kind === 'checksum' ? '校验和' : '正文载荷摘要');
        expect(await indexedDB.databases()).toEqual(before);
    } finally { lib.close(); }
});

test('a revoked import guard leaves the fully verified new library unactivated and the original intact', async () => {
    const { lib } = await fixture(1), setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => lib.db.name, setItem });
    try {
        const original = await exportLibrary(lib), before = new Set((await indexedDB.databases()).map(db => db.name));
        let checks = 0;
        await expect(workerJob({ kind: 'import', blob: new Blob([JSON.stringify(original)]) }, undefined, () => ++checks < 3))
            .rejects.toThrow('未启用');
        expect(setItem).not.toHaveBeenCalled();
        expect((await exportLibrary(lib)).data).toEqual(original.data);
        const created = (await indexedDB.databases()).filter(db => !before.has(db.name));
        expect(created).toHaveLength(1);
        const copy = await Library.open(created[0].name!, true);
        try { expect((await exportLibrary(copy)).data).toEqual(original.data); }
        finally { copy.close(); }
    } finally { lib.close(); }
});
