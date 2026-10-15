import { previewArchiveDeletion, commitArchiveDeletion } from './archive-deletion';
import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import type { BackupDisk } from '@/st/native-backups';
import { fixture } from './fixtures';
import { synchronize, capture, forkBranch } from './canonical';
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

test('current-head deletion protects the last saved full package then resumes against the new head', async () => {
    const { lib, input } = await fixture(2), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    const first = await backups.save(lib, 'auto'); const before = await exportLibrary(lib);
    const identities = await lib.all('source_messages');
    input.messages.pop(); input.memories.pop(); await synchronize(lib, input); time.advance();
    expect(await lib.all('source_messages')).toEqual(identities);
    const notified = vi.fn();
    const saved = await backups.save(lib, 'auto', 10, () => true, notified);
    expect(saved.state).toBe('saved'); expect(notified).toHaveBeenCalledTimes(1);
    const protection = (await backups.inventory()).entries.find(e => e.kind === 'before-deletion')!;
    expect((await backups.read(protection.key)).file.pack.data).toEqual(before.data);
    expect(protection.snapshotAt).toBe(first.state === 'saved' ? first.entry.snapshotAt : 0);
    const current = await capture(lib, (await lib.all<any>('branches'))[0].id);
    expect(current.refs).toHaveLength(3); expect(current.memories).toHaveLength(1);
    expect(current.sources.size).toBe(3);
    expect(disk.write).toHaveBeenCalledTimes(3); expect(disk.remove).not.toHaveBeenCalled();
    time.advance(); expect(await backups.save(lib, 'auto')).toEqual({ state: 'unchanged' });
    lib.close();
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


test('protection failure keeps the baseline; retry verifies an uncertain write without duplicating protection', async () => {
    const { lib, input } = await fixture(2), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto'); time.advance();
    input.messages.pop(); input.memories.pop(); await synchronize(lib, input);
    const notice = vi.fn();
    disk.write.mockImplementationOnce(async (key, value) => { disk.files.set(key, value); throw new Error('uncertain write'); });
    await expect(backups.save(lib, 'auto', 5, () => true, notice)).rejects.toThrow('uncertain write');
    expect(notice).not.toHaveBeenCalled(); expect(disk.remove).not.toHaveBeenCalled();
    expect((await backups.save(lib, 'auto', 5, () => true, notice)).state).toBe('saved');
    expect(notice).toHaveBeenCalledTimes(1);
    expect((await backups.inventory()).entries.filter(e => e.kind === 'before-deletion')).toHaveLength(1);
    expect(disk.write).toHaveBeenCalledTimes(3); lib.close();
});

test('failed post-deletion save and restart reuse protection before resuming', async () => {
    const { lib, input } = await fixture(2), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto'); time.advance();
    input.messages.pop(); input.memories.pop(); await synchronize(lib, input);
    disk.write.mockImplementation(async (key, value) => {
        if (key.startsWith('auto-')) throw new Error('ENOSPC');
        disk.files.set(key, value);
    });
    await expect(backups.save(lib, 'auto')).rejects.toThrow('ENOSPC');
    expect(disk.remove).not.toHaveBeenCalled();
    disk.write.mockImplementation(async (key, value) => { disk.files.set(key, value); });
    const restarted = new CoreBackups(disk, time.now);
    expect((await restarted.save(lib, 'auto')).state).toBe('saved');
    expect((await restarted.inventory()).entries.filter(e => e.kind === 'before-deletion')).toHaveLength(1);
    lib.close();
});

test('unreadable deletion protection blocks new baseline and all rotation', async () => {
    const { lib, input } = await fixture(2), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto'); time.advance(); input.messages.pop(); input.memories.pop(); await synchronize(lib, input);
    disk.write.mockImplementationOnce(async (key) => { disk.files.set(key, new Blob(['bad'])); });
    await expect(backups.save(lib, 'auto')).rejects.toThrow();
    await expect(backups.save(lib, 'auto')).rejects.toThrow();
    expect(disk.write).toHaveBeenCalledTimes(2); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});

test.each(['empty', 'mixed', 'binding', 'epoch'] as const)('ambiguous %s reduction still fails closed', async mode => {
    const { lib, input, branch } = await fixture(2), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto'); time.advance();
    input.messages.pop(); input.memories.pop();
    if (mode === 'empty') { input.messages = []; input.memories = []; }
    if (mode === 'mixed') input.messages[0].content += ' edited';
    await synchronize(lib, input);
    if (mode === 'epoch') await lib.transaction(['branches'], 'readwrite', async tx => {
        const current = await tx.get<any>('branches', branch.id); await tx.put('branches', { ...current, epoch: branch.epoch });
    });
    if (mode === 'binding') await lib.transaction(['host_bindings'], 'readwrite', async tx => {
        const binding = (await tx.all<any>('host_bindings'))[0]; await tx.put('host_bindings', { ...binding, generation: binding.generation + 1 });
    });
    await expect(backups.save(lib, 'auto')).rejects.toThrow();
    expect(disk.write).toHaveBeenCalledTimes(1); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
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

test('protection remains outside rotation and stale selection after protection prevents baseline adoption', async () => {
    const { lib, input } = await fixture(2), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto'); time.advance(); input.messages.pop(); input.memories.pop(); await synchronize(lib, input);
    let current = true;
    disk.write.mockImplementationOnce(async (key, value) => { disk.files.set(key, value); current = false; });
    await expect(backups.save(lib, 'auto', 5, () => current)).rejects.toThrow('当前档案已改变');
    expect(disk.remove).not.toHaveBeenCalled();
    const protection = (await backups.inventory()).entries.find(e => e.kind === 'before-deletion')!;
    expect((await backups.save(lib, 'auto', 5)).state).toBe('saved');
    for (let i = 0; i < 6; i++) {
        time.advance(); input.messages[1].content += ` ${i}`; await synchronize(lib, input); await backups.save(lib, 'auto', 5);
    }
    expect(disk.files.has(protection.key)).toBe(true);
    expect((await backups.inventory()).entries.filter(e => e.kind === 'auto')).toHaveLength(5); lib.close();
});

test('fresh deletion protection exports current data, not an older automatic package, with bounded readback', async () => {
    const { lib, input } = await fixture(2), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto');
    // Permanent historical files must not be opened on each new deletion.
    for (let i = 0; i < 8; i++) {
        input.messages[1].content += ` new-${i}`;
        const branch = await synchronize(lib, input);
        const beforeReads = disk.read.mock.calls.length;
        await backups.protectCurrentDeletion(lib, branch);
        expect(disk.read.mock.calls.length - beforeReads).toBe(1);
        time.advance();
    }
    const current = await exportLibrary(lib), branch = (await lib.all<any>('branches'))[0];
    const beforeWrites = disk.write.mock.calls.length, beforeReads = disk.read.mock.calls.length;
    const reused = await backups.protectCurrentDeletion(lib, branch);
    expect(disk.write.mock.calls.length).toBe(beforeWrites);
    expect(disk.read.mock.calls.length - beforeReads).toBe(1);
    expect((await backups.read(reused.key)).file.pack.data).toEqual(current.data);
    lib.close();
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


test('explicit archive deletion protects current full core then establishes a verified reduced baseline', async () => {
    const { lib, input, branch } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await synchronize(lib, { ...input, scope: 'retained-story' });
    await backups.save(lib, 'auto'); time.advance();
    const plan = await previewArchiveDeletion(lib, branch.id);
    const protection = await backups.protectArchiveDeletion(lib, plan, () => true);
    expect(protection.kind).toBe('before-archive-deletion');
    expect((await backups.read(protection.key)).file.pack.data).toEqual(plan.before.data);
    await commitArchiveDeletion(lib, plan, () => true);
    expect((await backups.completeArchiveDeletion(lib, plan, () => true)).state).toBe('saved');
    time.advance(); expect(await backups.save(lib, 'auto')).toEqual({ state: 'unchanged' });
    expect(disk.files.has(protection.key)).toBe(true); expect(await lib.all('branches')).toHaveLength(1); lib.close();
});

test('failed archive protection cannot authorize deletion; changed preview is rejected', async () => {
    const { lib, input, branch } = await fixture(1), disk = new Disk(), backups = new CoreBackups(disk);
    const plan = await previewArchiveDeletion(lib, branch.id);
    disk.write.mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(backups.protectArchiveDeletion(lib, plan, () => true)).rejects.toThrow('ENOSPC');
    expect(await lib.get('branches', branch.id)).toBeDefined();
    input.messages[1].content += ' new'; await synchronize(lib, input);
    await expect(backups.protectArchiveDeletion(lib, plan, () => true)).rejects.toThrow('重新预览'); lib.close();
});

test('already-deleted archive remains blocked until explicit old-package protection and new-baseline acceptance', async () => {
    const { lib, input, branch } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await synchronize(lib, { ...input, scope: 'retained-story' });
    const saved = await backups.save(lib, 'auto'); time.advance();
    await commitArchiveDeletion(lib, await previewArchiveDeletion(lib, branch.id), () => true);
    await expect(backups.save(lib, 'auto')).rejects.toThrow('数量或身份减少');
    const approval = await backups.previewArchiveLoss(lib);
    expect(approval.previous.counts.branches).toBe(2); expect(approval.currentCounts.branches).toBe(1);
    expect(approval.previous.snapshotAt).toBe(saved.state === 'saved' ? saved.entry.snapshotAt : 0);
    expect((await backups.acceptArchiveLoss(lib, approval, () => true)).state).toBe('saved');
    expect((await backups.inventory()).entries.filter(e => e.kind === 'before-archive-deletion')).toHaveLength(1);
    time.advance(); expect(await backups.save(lib, 'auto')).toEqual({ state: 'unchanged' }); lib.close();
});

test('post-delete baseline failure keeps protection and can recover without repeating archive deletion', async () => {
    const { lib, input, branch } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await synchronize(lib, { ...input, scope: 'retained-story' });
    await backups.save(lib, 'auto'); time.advance();
    const plan = await previewArchiveDeletion(lib, branch.id);
    const protection = await backups.protectArchiveDeletion(lib, plan, () => true);
    await commitArchiveDeletion(lib, plan, () => true);
    disk.write.mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(backups.completeArchiveDeletion(lib, plan, () => true)).rejects.toThrow('ENOSPC');
    expect(await lib.get('branches', branch.id)).toBeUndefined(); expect(disk.files.has(protection.key)).toBe(true);
    const approval = await backups.previewArchiveLoss(lib);
    expect((await backups.acceptArchiveLoss(lib, approval, () => true)).state).toBe('saved'); lib.close();
});

test('explicit last-archive deletion keeps protection and does not create or accept an empty baseline', async () => {
    const { lib, branch } = await fixture(1), disk = new Disk(), backups = new CoreBackups(disk);
    const plan = await previewArchiveDeletion(lib, branch.id);
    const protectedFile = await backups.protectArchiveDeletion(lib, plan, () => true);
    await commitArchiveDeletion(lib, plan, () => true);
    expect(await backups.completeArchiveDeletion(lib, plan, () => true)).toEqual({ state: 'empty' });
    expect(disk.files.has(protectedFile.key)).toBe(true); expect(disk.remove).not.toHaveBeenCalled();
    await expect(backups.save(lib, 'auto')).rejects.toThrow('为空'); lib.close();
});

test('archive-loss acceptance rejects changed current data, stale baseline, and corrupt latest baseline', async () => {
    const { lib, input } = await fixture(1), disk = new Disk(), time = clock(), backups = new CoreBackups(disk, time.now);
    await backups.save(lib, 'auto'); time.advance();
    const approval = await backups.previewArchiveLoss(lib);
    input.messages[1].content += ' changed'; await synchronize(lib, input);
    await expect(backups.acceptArchiveLoss(lib, approval, () => true)).rejects.toThrow('重新核对');
    await backups.save(lib, 'manual');
    await expect(backups.acceptArchiveLoss(lib, approval, () => true)).rejects.toThrow('起点已改变');
    const latest = await backups.previewArchiveLoss(lib);
    disk.files.set(latest.previous.key, new Blob(['corrupt']));
    await expect(backups.previewArchiveLoss(lib)).rejects.toThrow(); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});


test('asynchronous worker guards are awaited, never accepted as a truthy Promise', async () => {
    const { lib, branch } = await fixture(1), disk = new Disk(), backups = new CoreBackups(disk);
    const guard = vi.fn(async () => false);
    await expect(backups.save(lib, 'auto', 5, guard)).rejects.toThrow('已取消');
    await expect(backups.protectCurrentDeletion(lib, branch, guard)).rejects.toThrow('尚未应用删除');
    expect(guard).toHaveBeenCalledTimes(2);
    expect(disk.write).not.toHaveBeenCalled(); expect(disk.remove).not.toHaveBeenCalled(); lib.close();
});
