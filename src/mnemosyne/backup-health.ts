/** Small display metadata only. Never used to approve, skip or rotate a backup. */
export const BACKUP_HEALTH_KEY = 'mnemosyne_core_backup_health_v1';
export const BACKUP_HEALTH_LIMIT = 12;
const MAX_TEXT = 2048;
const MAX_BYTES = 64 * 1024;

export interface BackupHealth {
    library: string;
    lastSavedAt: number;
    lastFileAt: number;
    failureSince: number;
    lastFailureAt: number;
    error: string;
    updatedAt: number;
}
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const empty = (library: string): BackupHealth => ({ library, lastSavedAt: 0, lastFileAt: 0,
    failureSince: 0, lastFailureAt: 0, error: '', updatedAt: 0 });

export class BackupHealthHistory {
    private entries = new Map<string, BackupHealth>();
    private loaded = false;
    persistenceError = '';
    constructor(private storage: () => StorageAccess | undefined = () => typeof localStorage === 'undefined' ? undefined : localStorage) {}

    private load() {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const raw = this.storage()?.getItem(BACKUP_HEALTH_KEY);
            if (!raw || raw.length > MAX_BYTES) return;
            const value = JSON.parse(raw);
            if (value?.schema !== 1 || !Array.isArray(value.entries)) return;
            for (const row of value.entries.slice(0, BACKUP_HEALTH_LIMIT)) {
                if (!row || typeof row.library !== 'string' || row.library.length > 256 || !row.library.startsWith('mnemosyne_daily_') ||
                    !['lastSavedAt', 'lastFileAt', 'failureSince', 'lastFailureAt', 'updatedAt'].every(key => timestamp(row[key])) ||
                    typeof row.error !== 'string' || row.error.length > MAX_TEXT) continue;
                this.entries.set(row.library, { library: row.library, lastSavedAt: row.lastSavedAt, lastFileAt: row.lastFileAt,
                    failureSince: row.error ? row.failureSince : 0, lastFailureAt: row.error ? row.lastFailureAt : 0,
                    error: row.error, updatedAt: row.updatedAt });
            }
        } catch { this.persistenceError = '备份状态记录无法读取'; }
    }

    get(library: string): BackupHealth {
        this.load();
        return { ...(this.entries.get(library) ?? empty(library)) };
    }

    private update(library: string, patch: Partial<BackupHealth>, now: number): BackupHealth {
        const next = { ...this.get(library), ...patch, library, updatedAt: now };
        this.entries.delete(library);
        this.entries = new Map([[library, next] as const, ...this.entries].slice(0, BACKUP_HEALTH_LIMIT));
        try {
            this.storage()?.setItem(BACKUP_HEALTH_KEY, JSON.stringify({ schema: 1, entries: [...this.entries.values()] }));
            this.persistenceError = '';
        } catch { this.persistenceError = '备份状态未能保存，重启后可能丢失提示'; }
        return { ...next };
    }

    failed(library: string, error: string, now = Date.now()): BackupHealth {
        const previous = this.get(library);
        return this.update(library, { error: error.slice(0, MAX_TEXT), failureSince: previous.failureSince || now,
            lastFailureAt: now }, now);
    }

    saved(library: string, savedAt: number, now = Date.now()): BackupHealth {
        const previous = this.get(library);
        return this.update(library, { lastSavedAt: Math.max(previous.lastSavedAt, savedAt),
            lastFileAt: Math.max(previous.lastFileAt, savedAt), error: '', failureSince: 0, lastFailureAt: 0 }, now);
    }

    /** The unchanged path validates current data and the existing baseline, but writes no new file. */
    validated(library: string, now = Date.now()): BackupHealth {
        return this.update(library, { error: '', failureSince: 0, lastFailureAt: 0 }, now);
    }

    fileHint(library: string, savedAt: number, now = Date.now()): BackupHealth {
        const previous = this.get(library);
        if (previous.lastFileAt >= savedAt) return previous;
        return this.update(library, { lastFileAt: savedAt }, now);
    }
}

export function backupTimeLabel(state: Pick<BackupHealth, 'lastSavedAt' | 'lastFileAt'>, compact = false): string {
    const time = state.lastSavedAt || state.lastFileAt;
    if (!time) return '尚无成功备份记录';
    const date = new Date(time).toLocaleString(undefined, compact
        ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
        : undefined);
    return `${state.lastSavedAt ? '最近成功' : '最近文件（未复核）'}：${date}`;
}
