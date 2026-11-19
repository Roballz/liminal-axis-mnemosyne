import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { fixture, observation } from './fixtures';
import { capture, forkBranch, synchronize } from './canonical';
import { exportLibrary } from './migration';
import { Library, ACTIVE_KEY, freshLibraryName } from './db';
import type { BackupDisk } from '@/st/native-backups';
import type { BackupJob, BackupResult, HostMessage, WorkerMessage, DiskRequest } from './backup-worker-protocol';
import { BACKUP_MAX_BYTES } from './core-backups';

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
        const saved = await workerJob({ kind: 'manual', library: lib.db.name, keep: 10 }, disk);
        if (saved.state !== 'saved') throw new Error('missing manual backup');
        expect(Object.keys(saved).sort()).toEqual(['entry', 'state']);
        const protection = await workerJob({ kind: 'before-restore', library: lib.db.name, keep: 10 }, disk);
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
        expect(await workerJob({ kind: 'before-restore', library: lib.db.name, keep: 10 }, disk)).toEqual({ state: 'empty' });
        expect(disk.write).not.toHaveBeenCalled(); expect(disk.remove).not.toHaveBeenCalled();
    } finally { lib.close(); }
});

test('actual archive export/import and disk restore update the same database and preserve unrelated archive bytes', async () => {
    const { lib, input, branch } = await fixture(2), disk = new Disk();
    const other = await synchronize(lib, observation(3, 'other-chat'));
    const before = await capture(lib, other.id), setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === ACTIVE_KEY ? lib.db.name : null, setItem });
    const exported = await workerJob({ kind: 'export', library: lib.db.name, branch: branch.id });
    if (exported.state !== 'exported') throw new Error('missing export');
    const backup = await workerJob({ kind: 'manual', library: lib.db.name, branch: branch.id, keep: 10 }, disk);
    if (backup.state !== 'saved') throw new Error('missing backup');
    input.messages[3].content = 'subsequent source edit'; await synchronize(lib, input);
    const dbs = await indexedDB.databases();
    const imported = await workerJob({ kind: 'archive-import', library: lib.db.name, branch: branch.id, blob: exported.blob });
    expect(imported.state).toBe('archive-restored');
    expect(await indexedDB.databases()).toEqual(dbs);
    expect(await capture(lib, other.id)).toEqual(before);
    const restored = await workerJob({ kind: 'archive-restore', library: lib.db.name, branch: branch.id,
        key: backup.entry.key, checksum: backup.entry.checksum }, disk);
    expect(restored.state).toBe('archive-restored');
    expect(setItem).not.toHaveBeenCalled(); expect(disk.remove).not.toHaveBeenCalled();
    expect(await capture(lib, other.id)).toEqual(before); await exportLibrary(lib); lib.close();
});

test('verified disk backup restores a child in a reorganized library after creating a protection copy', async () => {
    const { lib, view } = await fixture(2), disk = new Disk();
    try {
        const branch = (await forkBranch(lib, view, 'child-disk-restore')).id;
        const old = await workerJob({ kind: 'manual', library: lib.db.name, branch, keep: 10 }, disk);
        if (old.state !== 'saved') throw new Error('missing old backup');
        const migration = await workerJob({ kind: 'reorganize', library: lib.db.name });
        if (migration.state !== 'reorganized') throw new Error('missing reorganized library');
        const library = migration.report.library, { key, checksum } = old.entry;
        expect((await workerJob({ kind: 'preview', key }, disk)).state).toBe('preview');
        expect((await workerJob({ kind: 'before-restore', library, branch, keep: 10 }, disk)).state).toBe('saved');
        const result = await workerJob({ kind: 'archive-restore', library, branch, key, checksum }, disk);
        expect(result).toMatchObject({ state: 'archive-restored', report: { branch } });
        const restored = await Library.open(library, true);
        try {
            expect((await capture(restored, branch)).refs).toEqual(view.refs);
            expect((await capture(restored, view.branch.id)).branch).toEqual(view.branch);
            await exportLibrary(restored);
        } finally { restored.close(); }
    } finally { lib.close(); }
});

test('actual cleanup worker returns only aggregate results and retains the active database identity', async () => {
    const { lib, input } = await fixture(1);
    for (let i = 0; i < 4; i++) { input.memories[0].content = `new summary ${i}`; await synchronize(lib, input); }
    const before = await indexedDB.databases(), result = await workerJob({ kind: 'clean-history', library: lib.db.name });
    if (result.state !== 'history-cleaned') throw new Error('missing cleanup report');
    expect(result.report.removed.memory_revisions).toBe(4);
    expect(JSON.stringify(result)).not.toContain('new summary');
    expect(await indexedDB.databases()).toEqual(before);
    expect(await lib.all('memory_revisions')).toHaveLength(1);
    await exportLibrary(lib); lib.close();
});

test('size diagnosis executes read-only in the Worker and returns only aggregate counts and bytes', async () => {
    const { lib } = await fixture(2), disk = new Disk();
    try {
        const result = await workerJob({ kind: 'size', library: lib.db.name }, disk);
        if (result.state !== 'size') throw new Error('missing size report');
        expect(result.report.bytes).toBeGreaterThan(0);
        expect(result.report.stores.find(store => store.store === 'source_bodies')?.records).toBe(4);
        expect(disk.read).not.toHaveBeenCalled(); expect(disk.write).not.toHaveBeenCalled();
        expect(disk.remove).not.toHaveBeenCalled(); expect(disk.list).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(lib.db.name);
    } finally { lib.close(); }
});

test('raw export/import jobs work without a native disk and return only Blob or verified library identity', async () => {
    const { lib } = await fixture(2);
    const setItem = vi.fn(); vi.stubGlobal('localStorage', { getItem: (key: string) => key === ACTIVE_KEY ? lib.db.name : null, setItem });
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

test('file import accepts the expanded limit and rejects excess bytes before reading or creating a database', async () => {
    const { lib } = await fixture(1);
    try {
        const blob = new Blob([JSON.stringify(await exportLibrary(lib))]);
        const size = vi.spyOn(blob, 'size', 'get').mockReturnValue(BACKUP_MAX_BYTES);
        const restored = await workerJob({ kind: 'import', blob });
        expect(restored.state).toBe('restored');
        const before = await indexedDB.databases(), text = vi.spyOn(blob, 'text');
        size.mockReturnValue(BACKUP_MAX_BYTES + 1);
        await expect(workerJob({ kind: 'import', blob })).rejects.toThrow(`${BACKUP_MAX_BYTES + 1} 字节`);
        expect(text).not.toHaveBeenCalled();
        expect(await indexedDB.databases()).toEqual(before);
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
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === ACTIVE_KEY ? lib.db.name : null, setItem });
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

test('actual reorganization worker preserves original and prepares compact independently verified library', async () => {
    const { lib } = await fixture(8);
    const before = await exportLibrary(lib), result = await workerJob({ kind: 'reorganize', library: lib.db.name });
    if (result.state !== 'reorganized') throw new Error('missing reorganization');
    const target = await Library.open(result.report.library, true);
    try {
        expect(target.compactWrites).toBe(true);
        expect((await exportLibrary(lib)).data).toEqual(before.data);
        expect(await target.all('memory_revisions')).toEqual(await lib.all('memory_revisions'));
        expect(result.report.sourceStamp).toBeGreaterThan(0);
    } finally { target.close(); lib.close(); }
});
