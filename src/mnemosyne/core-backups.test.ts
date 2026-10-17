import { previewArchiveDeletion, commitArchiveDeletion } from './archive-deletion';
import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import type { BackupDisk } from '@/st/native-backups';
import { fixture } from './fixtures';
import { synchronize, capture, forkBranch } from './canonical';
import { Library, freshLibraryName, ACTIVE_KEY } from './db';
import { exportLibrary } from './migration';
import { STORES, fingerprint } from './model';
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
    expect(backupSettings(undefined)).toEqual({ schema: 1, enabled: false, keep: 20 });
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

test('rotation keeps 20 per library and never touches manual, pinned, foreign-name, or other-library files', async () => {
    const { lib, input } = await fixture(1), other = await fixture(1);
    const disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    disk.files.set('user-backup.json', new Blob(['never touched']));
    const otherCopy = await backups.save(other.lib, 'auto'); expect(otherCopy.state).toBe('saved');
    const manual = await backups.save(lib, 'manual'); expect(manual.state).toBe('saved');
    let pinned = '';
    for (let i = 0; i < 22; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input);
        const saved = await backups.save(lib, 'auto', 20);
        if (i === 0 && saved.state === 'saved') pinned = (await backups.pin(saved.entry.key, saved.entry.checksum)).key;
    }
    const inventory = await backups.inventory();
    expect(inventory.entries.filter(e => e.kind === 'auto' && e.sourceLibrary === lib.db.name)).toHaveLength(20);
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

test('valid smaller core library is backed up without protection or manual baseline acceptance', async () => {
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
    expect((await backups.save(lib, 'auto')).state).toBe('saved');
    expect(disk.write).toHaveBeenCalledTimes(2); expect(disk.remove).not.toHaveBeenCalled();
    expect((await backups.inventory()).entries.every(e => e.kind === 'auto')).toBe(true);
    time.advance(); expect(await backups.save(lib, 'auto')).toEqual({ state: 'unchanged' }); lib.close();
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
    for (let i = 0; i < 20; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input); await backups.save(lib, 'auto', 20);
    }
    time.advance(); input.messages[1].content += ' final'; await synchronize(lib, input);
    let current = true;
    disk.write.mockImplementationOnce(async (key, data) => { disk.files.set(key, data); current = false; });
    const result = await backups.save(lib, 'auto', 20, () => current);
    expect(result.state).toBe('saved'); if (result.state === 'saved') expect(result.warning).toContain('暂停轮换');
    expect(disk.files.size).toBe(21); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test('a corrupt retained file cannot displace a valid older backup', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const saved: string[] = [];
    for (let i = 0; i < 20; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input);
        const result = await backups.save(lib, 'auto', 20); if (result.state === 'saved') saved.push(result.entry.key);
    }
    disk.files.set(saved[2], new Blob(['corrupt'])); // latest baseline is intact
    time.advance(); input.messages[1].content += ' newest'; await synchronize(lib, input);
    const result = await backups.save(lib, 'auto', 20);
    expect(result.state).toBe('saved'); if (result.state === 'saved') expect(result.warning).toContain('清理未完成');
    expect(disk.files.has(saved[0])).toBe(true); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test('losing the lifecycle guard during awaited deletion-target verification cannot delete it', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    let oldest = '';
    for (let i = 0; i < 20; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input);
        const result = await backups.save(lib, 'auto', 20); if (i === 0 && result.state === 'saved') oldest = result.entry.key;
    }
    let current = true;
    disk.read.mockImplementation(async key => {
        if (key === oldest) current = false;
        return disk.files.get(key)!;
    });
    time.advance(); input.messages[1].content += ' last'; await synchronize(lib, input);
    const result = await backups.save(lib, 'auto', 20, () => current);
    expect(result.state).toBe('saved'); if (result.state === 'saved') expect(result.warning).toContain('暂停轮换');
    expect(disk.files.has(oldest)).toBe(true); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});


test('another branch is not a deletion; deleting a parent keeps child text and historical summaries', async () => {
    const { lib, input, branch } = await fixture(2), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const child = await forkBranch(lib, await capture(lib, branch.id), 'child');
    await backups.save(lib, 'auto'); time.advance();
    expect(await backups.save(lib, 'auto')).toEqual({ state: 'unchanged' });
    expect((await backups.inventory()).entries.every(e => e.kind !== 'before-deletion')).toBe(true);
    const old = await capture(lib, branch.id);
    input.messages.pop(); input.memories.pop(); await synchronize(lib, input);
    expect((await backups.save(lib, 'auto')).state).toBe('saved');
    expect((await capture(lib, branch.id)).memories).toHaveLength(1);
    const other = await capture(lib, child.id);
    expect(other.refs).toHaveLength(4); expect(other.memories).toHaveLength(2);
    expect(other.sources.get(old.refs[3].revision)?.content).toBeDefined();
    expect(await lib.get('memory_revisions', old.memories[1].id)).toBeDefined(); lib.close();
});

test('deletion excludes related higher summaries from current selection without purging historical revisions', async () => {
    const { lib, input, branch } = await fixture(2);
    input.memories.push({ hostId: 'higher', content: '两层的高层摘要', level: 1, anchorKey: null,
        children: input.memories.map(m => m.hostId), storyTime: '', seed: false, enabled: true });
    await synchronize(lib, input); const before = await capture(lib, branch.id);
    const higher = before.memories.find(m => m.level === 1)!;
    input.messages.pop(); input.memories.splice(1, 1);
    await synchronize(lib, input); const after = await capture(lib, branch.id);
    expect(after.memories.every(m => m.level === 0)).toBe(true);
    expect(await lib.get('memory_revisions', higher.id)).toBeDefined();
    input.messages.push({ key: 'unrelated-new', role: 'user', content: '无关新楼层', swipe: 0 });
    await synchronize(lib, input);
    expect((await capture(lib, branch.id)).memories.every(m => m.level === 0)).toBe(true);
    await synchronize(lib, input);
    expect((await capture(lib, branch.id)).memories.every(m => m.level === 0)).toBe(true);
    lib.close();
});


test('asynchronous worker guards are awaited, never accepted as a truthy Promise', async () => {
    const { lib, branch } = await fixture(1), disk = new Disk(), backups = new CoreBackups(disk);
    const guard = vi.fn(async () => false);
    await expect(backups.save(lib, 'auto', 20, guard)).rejects.toThrow('已取消');
    expect(guard).toHaveBeenCalledTimes(1);
    expect(disk.write).not.toHaveBeenCalled(); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});


test.each([5, 10, 20])('settings keep=%s migrates to 20 without changing the enabled flag', keep => {
    for (const enabled of [false, true]) expect(backupSettings({ schema: 1, enabled, keep })).toEqual({ schema: 1, enabled, keep: 20 });
});
test.each([0, 19, 21, '20', null])('invalid retention %s still fails closed', keep => {
    expect(() => backupSettings({ schema: 1, enabled: true, keep })).toThrow('设置损坏');
});

test('repeated deletions and shortened edits only publish the latest ordinary timed snapshot', async () => {
    const { lib, input, branch } = await fixture(3), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const first = await backups.save(lib, 'auto');
    if (first.state !== 'saved') throw new Error('missing first backup');
    const old = (await backups.read(first.entry.key)).file.pack.data;
    for (let i = 0; i < 2; i++) {
        input.messages.pop(); input.memories.pop(); await synchronize(lib, input);
        expect(await backups.save(lib, 'auto')).toEqual({ state: 'too-soon' });
    }
    input.messages[1].content = '短'; await synchronize(lib, input);
    expect(await backups.save(lib, 'auto')).toEqual({ state: 'too-soon' });
    expect(disk.write).toHaveBeenCalledTimes(1);
    time.advance(); const current = await backups.save(lib, 'auto');
    expect(current.state).toBe('saved'); expect(disk.write).toHaveBeenCalledTimes(2);
    expect((await backups.inventory()).entries.every(e => e.kind === 'auto')).toBe(true);
    expect((await backups.read(first.entry.key)).file.pack.data).toEqual(old);
    if (current.state === 'saved') expect((await backups.read(current.entry.key)).file.pack.data).toEqual((await exportLibrary(lib)).data);
    expect((await capture(lib, branch.id)).refs).toHaveLength(4); lib.close();
});

test('archive deletion continues with a normal timed backup, never before/after archive packages', async () => {
    const { lib, input, branch } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await synchronize(lib, { ...input, scope: 'retained-story' });
    await backups.save(lib, 'auto');
    await commitArchiveDeletion(lib, await previewArchiveDeletion(lib, branch.id), () => true);
    expect(await backups.save(lib, 'auto')).toEqual({ state: 'too-soon' });
    time.advance(); expect((await backups.save(lib, 'auto')).state).toBe('saved');
    expect((await backups.inventory()).entries.every(e => e.kind === 'auto')).toBe(true);
    expect(disk.write).toHaveBeenCalledTimes(2); expect(await lib.all('branches')).toHaveLength(1); lib.close();
});

test('deleting the final archive does not save an empty core or rotate existing backups', async () => {
    const { lib, branch } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto'); const existing = [...disk.files.keys()];
    await commitArchiveDeletion(lib, await previewArchiveDeletion(lib, branch.id), () => true);
    time.advance(); await expect(backups.save(lib, 'auto')).rejects.toThrow('为空');
    expect([...disk.files.keys()]).toEqual(existing); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test('a changed archive-delete preview is still rejected independently of backup policy', async () => {
    const { lib, input, branch } = await fixture(1);
    const plan = await previewArchiveDeletion(lib, branch.id);
    input.messages[1].content += ' changed'; await synchronize(lib, input);
    await expect(commitArchiveDeletion(lib, plan, () => true)).rejects.toThrow();
    expect(await lib.get('branches', branch.id)).toBeDefined(); lib.close();
});

async function legacyCopy(disk: Disk, source: string, kind: 'before-deletion' | 'before-archive-deletion' | 'after-archive-deletion') {
    const { checksum: _, ...base } = JSON.parse(await disk.files.get(source)!.text());
    base.kind = kind;
    const key = source.replace(/^auto-/, `${kind}-`);
    disk.files.set(key, new Blob([JSON.stringify({ ...base, checksum: await fingerprint(base) })]));
    return key;
}
test('legacy deletion packages stay readable/restorable and untouched by 20-copy rotation', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const first = await backups.save(lib, 'auto'); if (first.state !== 'saved') throw new Error('missing first backup');
    const originals = new Map<string, Blob>();
    for (const kind of ['before-deletion', 'before-archive-deletion', 'after-archive-deletion'] as const) {
        const key = await legacyCopy(disk, first.entry.key, kind); originals.set(key, disk.files.get(key)!);
    }
    for (let i = 0; i < 21; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input); await backups.save(lib, 'auto');
    }
    expect((await backups.inventory()).entries.filter(e => e.kind === 'auto')).toHaveLength(20);
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    for (const [key, blob] of originals) {
        expect(disk.files.get(key)).toBe(blob);
        const saved = await backups.read(key), restored = await backups.restore(key, saved.entry.checksum);
        expect((await exportLibrary(restored)).data).toEqual(saved.file.pack.data); restored.close();
    }
    expect(disk.remove.mock.calls.every(([key]) => key.startsWith('auto-'))).toBe(true); lib.close();
});
test('unreadable legacy protection does not gate ordinary automatic snapshots and is never cleaned', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const first = await backups.save(lib, 'auto'); if (first.state !== 'saved') throw new Error('missing first backup');
    const old = await legacyCopy(disk, first.entry.key, 'before-deletion'); disk.files.set(old, new Blob(['corrupt legacy']));
    time.advance(); input.messages[1].content = '短'; await synchronize(lib, input);
    expect((await backups.save(lib, 'auto')).state).toBe('saved');
    expect((await backups.inventory()).invalid.map(e => e.key)).toContain(old);
    expect(disk.files.has(old)).toBe(true); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});
