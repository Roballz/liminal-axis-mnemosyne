import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import type { BackupDisk } from '@/st/native-backups';
import { fixture } from './fixtures';
import { synchronize } from './canonical';
import { Library, freshLibraryName, ACTIVE_KEY } from './db';
import { exportLibrary } from './migration';
import { STORES } from './model';
import { AUTO_BACKUP_INTERVAL, CoreBackups, backupSettings } from './core-backups';

class Disk implements BackupDisk {
    files = new Map<string, Blob>();
    list = vi.fn(async () => [...this.files.keys()]);
    read = vi.fn(async (key: string) => { const value = this.files.get(key); if (!value) throw new Error('missing'); return value; });
    write = vi.fn(async (key: string, value: Blob) => { this.files.set(key, value); });
    remove = vi.fn(async (key: string) => { this.files.delete(key); });
    readSettings = vi.fn(async (): Promise<unknown> => undefined);
    writeSettings = vi.fn(async (_value: unknown) => {});
}
const clock = () => {
    let now = 1_800_000_000_000;
    return { now: () => now, advance: () => { now += AUTO_BACKUP_INTERVAL + 1; } };
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('new installations stay disabled and invalid settings do not silently become defaults', () => {
    expect(backupSettings(undefined)).toEqual({ schema: 1, enabled: false, keep: 10 });
    expect(() => backupSettings({ enabled: true })).toThrow('设置损坏');
});

test('empty library does not write or rotate; empty pre-restore protection can be skipped', async () => {
    const lib = await Library.open(freshLibraryName()), disk = new Disk(), backups = new CoreBackups(disk);
    await expect(backups.save(lib, 'auto')).rejects.toThrow('为空');
    expect(await backups.save(lib, 'before-restore')).toEqual({ state: 'empty' });
    expect(disk.write).not.toHaveBeenCalled(); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test('distinct snapshots are verified, unchanged data ignores export time, and rapid changes are coalesced', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const first = await backups.save(lib, 'auto'); expect(first.state).toBe('saved');
    expect(await backups.save(lib, 'auto')).toEqual({ state: 'too-soon' });
    time.advance();
    expect(await backups.save(lib, 'auto')).toEqual({ state: 'unchanged' });
    input.messages[1].content += ' changed'; await synchronize(lib, input);
    expect((await backups.save(lib, 'auto')).state).toBe('saved');
    expect(disk.write).toHaveBeenCalledTimes(2); expect((await backups.inventory()).entries).toHaveLength(2); lib.close();
});

test('rotation keeps 5 per library and never touches manual, pinned, foreign-name, or other-library files', async () => {
    const { lib, input } = await fixture(1), other = await fixture(1);
    const disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    disk.files.set('user-backup.json', new Blob(['never touched']));
    const otherCopy = await backups.save(other.lib, 'auto'); expect(otherCopy.state).toBe('saved');
    const manual = await backups.save(lib, 'manual'); expect(manual.state).toBe('saved');
    let pinned = '';
    for (let i = 0; i < 7; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input);
        const saved = await backups.save(lib, 'auto', 5);
        if (i === 0 && saved.state === 'saved') pinned = (await backups.pin(saved.entry.key, saved.entry.checksum)).key;
    }
    const inventory = await backups.inventory();
    expect(inventory.entries.filter(e => e.kind === 'auto' && e.sourceLibrary === lib.db.name)).toHaveLength(5);
    expect(inventory.entries.filter(e => e.sourceLibrary === other.lib.db.name)).toHaveLength(1);
    expect(disk.files.has(pinned)).toBe(true); expect(disk.files.has('user-backup.json')).toBe(true);
    if (manual.state === 'saved') expect(disk.files.has(manual.entry.key)).toBe(true);
    expect(disk.remove).toHaveBeenCalledTimes(2); lib.close(); other.lib.close();
});

test('disk-full or incomplete readback cannot rotate older good copies', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto'); const good = [...disk.files.keys()];
    time.advance(); input.messages[1].content += ' changed'; await synchronize(lib, input);
    disk.write.mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(backups.save(lib, 'auto')).rejects.toThrow('ENOSPC');
    expect([...disk.files.keys()]).toEqual(good);
    disk.write.mockImplementationOnce(async (key) => { disk.files.set(key, new Blob(['{"partial":true}'])); });
    await expect(backups.save(lib, 'auto')).rejects.toThrow('字段');
    expect(disk.files.has(good[0])).toBe(true); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test('enumeration/read errors are not treated as no backups', async () => {
    const { lib } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    disk.list.mockRejectedValueOnce(new Error('directory IO'));
    await expect(backups.save(lib, 'auto')).rejects.toThrow('directory IO'); expect(disk.write).not.toHaveBeenCalled();
    await backups.save(lib, 'auto'); time.advance(); disk.read.mockRejectedValueOnce(new Error('read IO'));
    await expect(backups.save(lib, 'auto')).rejects.toThrow('read IO');
    expect(disk.write).toHaveBeenCalledTimes(1); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test('valid but smaller core library pauses automatic rotation until an explicit manual baseline', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const small = await exportLibrary(lib);
    await synchronize(lib, { ...input, scope: 'another-story' });
    await backups.save(lib, 'auto'); time.advance();
    await lib.transaction(STORES, 'readwrite', async tx => {
        for (const store of STORES) {
            for (const row of await tx.all(store)) await tx.delete(store, row.id);
            for (const row of small.data[store]) await tx.add(store, row);
        }
    });
    await expect(backups.save(lib, 'auto')).rejects.toThrow('数量或身份减少');
    expect(disk.write).toHaveBeenCalledTimes(1); expect(disk.remove).not.toHaveBeenCalled();
    await backups.save(lib, 'manual');
    expect(await backups.save(lib, 'auto')).toEqual({ state: 'unchanged' }); lib.close();
});

test('same-key collision aborts rather than overwriting; changed selection cannot restore', async () => {
    const { lib } = await fixture(1), disk = new Disk(), time = clock();
    const backups = new CoreBackups(disk, time.now, () => '00000000-0000-0000-0000-000000000000');
    const saved = await backups.save(lib, 'manual');
    await expect(backups.save(lib, 'manual')).rejects.toThrow('冲突');
    expect(disk.write).toHaveBeenCalledTimes(1);
    if (saved.state === 'saved') await expect(backups.restore(saved.entry.key, 'wrong')).rejects.toThrow('已改变'); lib.close();
});

test('restore revalidates selected file, preserves source file, and guards active-selector switch', async () => {
    const { lib } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const saved = await backups.save(lib, 'auto');
    if (saved.state !== 'saved') throw new Error('missing save');
    let checks = 0;
    await expect(backups.restore(saved.entry.key, saved.entry.checksum, () => ++checks === 1)).rejects.toThrow('未启用');
    expect(storage.has(ACTIVE_KEY)).toBe(false);
    const restored = await backups.restore(saved.entry.key, saved.entry.checksum);
    expect(storage.get(ACTIVE_KEY)).toBe(restored.db.name);
    expect((await exportLibrary(restored)).data).toEqual((await exportLibrary(lib)).data);
    expect(disk.files.has(saved.entry.key)).toBe(true); expect(disk.remove).not.toHaveBeenCalled(); restored.close(); lib.close();
});

test('obsolete generation after publication keeps the new copy but does not rotate', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    for (let i = 0; i < 5; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input); await backups.save(lib, 'auto', 5);
    }
    time.advance(); input.messages[1].content += ' final'; await synchronize(lib, input);
    let current = true;
    disk.write.mockImplementationOnce(async (key, data) => { disk.files.set(key, data); current = false; });
    const result = await backups.save(lib, 'auto', 5, () => current);
    expect(result.state).toBe('saved'); if (result.state === 'saved') expect(result.warning).toContain('暂停轮换');
    expect(disk.files.size).toBe(6); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test('current-head truncation pauses even when historical message identities survive', async () => {
    const { lib, input } = await fixture(2), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto'); const identities = await lib.all('source_messages');
    input.messages.pop(); input.memories.pop(); await synchronize(lib, input); time.advance();
    expect(await lib.all('source_messages')).toEqual(identities);
    await expect(backups.save(lib, 'auto')).rejects.toThrow('正文变短');
    expect(disk.write).toHaveBeenCalledTimes(1); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test('a corrupt retained file cannot displace a valid older backup', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const saved: string[] = [];
    for (let i = 0; i < 5; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input);
        const result = await backups.save(lib, 'auto', 5); if (result.state === 'saved') saved.push(result.entry.key);
    }
    disk.files.set(saved[2], new Blob(['corrupt'])); // latest baseline is intact
    time.advance(); input.messages[1].content += ' newest'; await synchronize(lib, input);
    const result = await backups.save(lib, 'auto', 5);
    expect(result.state).toBe('saved'); if (result.state === 'saved') expect(result.warning).toContain('清理未完成');
    expect(disk.files.has(saved[0])).toBe(true); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test('losing the lifecycle guard during awaited deletion-target verification cannot delete it', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    let oldest = '';
    for (let i = 0; i < 5; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input);
        const result = await backups.save(lib, 'auto', 5); if (i === 0 && result.state === 'saved') oldest = result.entry.key;
    }
    let current = true;
    disk.read.mockImplementation(async key => {
        if (key === oldest) current = false;
        return disk.files.get(key)!;
    });
    time.advance(); input.messages[1].content += ' last'; await synchronize(lib, input);
    const result = await backups.save(lib, 'auto', 5, () => current);
    expect(result.state).toBe('saved'); if (result.state === 'saved') expect(result.warning).toContain('暂停轮换');
    expect(disk.files.has(oldest)).toBe(true); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});
