import { expect, test, vi } from 'vitest';
import { BACKUP_HEALTH_KEY, BACKUP_HEALTH_LIMIT, BackupHealthHistory, backupTimeLabel } from './backup-health';

function storage() {
    const data = new Map<string, string>();
    return { data, getItem: vi.fn((key: string) => data.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
}

test('backup health survives reload per library and repeated failures retain the first failure time', () => {
    const disk = storage(), first = new BackupHealthHistory(() => disk);
    first.saved('mnemosyne_daily_a', 100, 100);
    first.failed('mnemosyne_daily_a', '审核来源身份不匹配', 200);
    first.failed('mnemosyne_daily_a', '审核来源身份不匹配', 300);
    first.saved('mnemosyne_daily_b', 250, 250);
    const reopened = new BackupHealthHistory(() => disk);
    expect(reopened.get('mnemosyne_daily_a')).toMatchObject({ lastSavedAt: 100, failureSince: 200, lastFailureAt: 300, error: '审核来源身份不匹配' });
    expect(reopened.get('mnemosyne_daily_b')).toMatchObject({ lastSavedAt: 250, error: '', failureSince: 0 });
    reopened.validated('mnemosyne_daily_a', 400);
    expect(reopened.get('mnemosyne_daily_a')).toMatchObject({ lastSavedAt: 100, error: '', failureSince: 0 });
    reopened.saved('mnemosyne_daily_a', 500, 500);
    expect(reopened.get('mnemosyne_daily_a')).toMatchObject({ lastSavedAt: 500, lastFileAt: 500 });
});

test('directory hints neither invent verified success nor clear a saved failure', () => {
    const disk = storage(), history = new BackupHealthHistory(() => disk);
    history.failed('mnemosyne_daily_a', '故障保留', 200);
    history.fileHint('mnemosyne_daily_a', 100, 300);
    const state = history.get('mnemosyne_daily_a');
    expect(state).toMatchObject({ lastSavedAt: 0, lastFileAt: 100, error: '故障保留', failureSince: 200 });
    expect(backupTimeLabel(state)).toContain('最近文件（未复核）');
    expect(backupTimeLabel(history.get('mnemosyne_daily_b'))).toBe('尚无成功备份记录');
});

test('metadata is bounded, loads only once, and excludes malformed or oversized persisted input', () => {
    const disk = storage(), history = new BackupHealthHistory(() => disk);
    for (let i = 0; i < BACKUP_HEALTH_LIMIT + 5; i++) history.failed(`mnemosyne_daily_${i}`, 'x'.repeat(10_000), i + 1);
    const payload = JSON.parse(disk.data.get(BACKUP_HEALTH_KEY)!);
    expect(payload.entries).toHaveLength(BACKUP_HEALTH_LIMIT);
    expect(payload.entries.every((entry: any) => entry.error.length <= 2048)).toBe(true);
    for (let i = 0; i < 100; i++) history.get('mnemosyne_daily_16');
    expect(disk.getItem).toHaveBeenCalledOnce();
    disk.data.set(BACKUP_HEALTH_KEY, JSON.stringify({ schema: 1, entries: [{ library: 'wrong-owner', lastSavedAt: 5 }] }));
    expect(new BackupHealthHistory(() => disk).get('mnemosyne_daily_a').lastSavedAt).toBe(0);
    disk.data.set(BACKUP_HEALTH_KEY, ' '.repeat(65_537));
    expect(new BackupHealthHistory(() => disk).get('mnemosyne_daily_a').error).toBe('');
});

test('unavailable metadata storage does not change a successful backup into a failed save', () => {
    const disk = storage();
    disk.setItem.mockImplementation(() => { throw new Error('quota'); });
    const history = new BackupHealthHistory(() => disk);
    expect(history.saved('mnemosyne_daily_a', 100, 100).lastSavedAt).toBe(100);
    expect(history.persistenceError).toContain('状态未能保存');
});
