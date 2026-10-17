import type { BackupDisk } from '@/st/native-backups';
import { exportLibrary, restoreLibrary, validateCurrentData, type Package } from './migration';
import { type Library, DB_PREFIX, activateLibrary } from './db';
import { check, fingerprint } from './model';
import { parseStrictJson } from './json';

export const AUTO_BACKUP_KEEP = 20;
export const AUTO_BACKUP_INTERVAL = 30 * 60 * 1000;
export const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const OWNER = 'mnemosyne-core-backup-v1';
const KEY = /^(auto|manual|pinned|before-restore|before-deletion|before-archive-deletion|after-archive-deletion)-v1-(\d{13})-([a-f0-9]{16})-([a-f0-9-]{36})\.json$/;
export type BackupGuard = () => boolean | Promise<boolean>;
type Kind = 'auto' | 'manual' | 'pinned' | 'before-restore' | 'before-deletion' | 'before-archive-deletion' | 'after-archive-deletion';
export interface BackupSettings { schema: 1; enabled: boolean; keep: typeof AUTO_BACKUP_KEEP }
export interface BackupFile {
    format: typeof OWNER;
    kind: Kind;
    savedAt: number;
    sourceLibrary: string;
    dataDigest: string;
    pack: Package;
    checksum: string;
}
export interface BackupPreview {
    key: string;
    kind: Kind;
    savedAt: number;
    snapshotAt: number;
    sourceLibrary: string;
    bytes: number;
    counts: Package['counts'];
    checksum: string;
}
export interface BackupListEntry {
    key: string;
    kind: Kind;
    savedAt: number;
    bank: string;
    /** Untrusted display hint, never evidence for restore, pin, or retention. */
    preview?: BackupPreview;
}
export interface BackupInventory { entries: BackupListEntry[] }
// Only a disposable, bounded display cache. Every backup remains discoverable by filename.
const PREVIEW_LIMIT = 256;
function previewHints(value: unknown): BackupPreview[] {
    if (value === undefined) return [];
    const catalog = value as { schema: number; entries: BackupPreview[] };
    check(catalog?.schema === 1 && Array.isArray(catalog.entries) && catalog.entries.length <= PREVIEW_LIMIT, '预览元数据无效');
    return catalog.entries.filter(entry => {
        const match = typeof entry?.key === 'string' && KEY.exec(entry.key);
        return match && entry.kind === match[1] && entry.savedAt === Number(match[2]) &&
            Number.isSafeInteger(entry.snapshotAt) && entry.snapshotAt > 0 &&
            typeof entry.sourceLibrary === 'string' && entry.sourceLibrary.startsWith(DB_PREFIX) && entry.sourceLibrary.length < 256 &&
            Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= BACKUP_MAX_BYTES &&
            typeof entry.checksum === 'string' && /^[a-f0-9]{64}$/.test(entry.checksum) &&
            entry.counts && typeof entry.counts === 'object' && Object.keys(entry.counts).length <= 64 &&
            Object.values(entry.counts).every(n => Number.isSafeInteger(n) && n >= 0) &&
            ['stories', 'branches', 'source_messages', 'memories', 'event_chains', 'custom_table_rows'].every(k => Number.isSafeInteger((entry.counts as any)[k]));
    }).map(({ key, kind, savedAt, snapshotAt, sourceLibrary, bytes, counts, checksum }) =>
        ({ key, kind, savedAt, snapshotAt, sourceLibrary, bytes, counts, checksum }));
}
export type BackupOutcome = { state: 'saved'; entry: BackupPreview; warning?: string } | { state: 'unchanged' | 'too-soon' | 'empty' };
function latestBaseline(keys: string[]): string | undefined {
    // Legacy deletion packages remain readable, but no longer gate ordinary backups.
    return keys.find(k => /^(auto|manual)-/.test(k));
}
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function backupFailure(e: unknown): string {
    const text = errorText(e);
    if (text.startsWith('本次会话已暂停；')) return text; // Preserve uncertain-settings/restart warning.
    return /quota|enospc|no space|disk.*full|空间不足/i.test(text)
        ? '本机空间不足，磁盘备份未完成；没有删除旧备份。请先腾出空间，再重试'
        : text;
}

export function backupSettings(value: unknown): BackupSettings {
    if (value === undefined) return { schema: 1, enabled: false, keep: AUTO_BACKUP_KEEP };
    const v = value as BackupSettings;
    check(v && v.schema === 1 && typeof v.enabled === 'boolean' && [5, 10, AUTO_BACKUP_KEEP].includes(v.keep), '磁盘备份设置损坏，已停止自动备份');
    // Upgrade old 5/10-copy settings in memory without changing the enabled flag.
    return { schema: 1, enabled: v.enabled, keep: AUTO_BACKUP_KEEP };
}

async function validatePackage(value: unknown): Promise<Package> {
    const pack = value as Package;
    await validateCurrentData(pack);
    const { checksum, ...base } = pack;
    check(typeof checksum === 'string' && await fingerprint(base) === checksum, '核心包校验和不匹配');
    check(Number.isSafeInteger(pack.created) && pack.created > 0, '核心包日期无效');
    return pack;
}

function assertNonempty(pack: Package) {
    check(pack.counts.stories > 0 && pack.counts.branches > 0 &&
        pack.counts.source_messages + pack.counts.memories + pack.counts.event_chains + pack.counts.custom_table_rows > 0,
    '当前核心库为空，停止备份和轮换；请先从已有备份恢复');
}

export class CoreBackups {
    private running: Promise<unknown> = Promise.resolve();
    private previews = new Map<string, BackupPreview>();
    constructor(readonly disk: BackupDisk, private now = () => Date.now(), private uuid = () => crypto.randomUUID()) {}

    /** Reserve the same writer queue for off-thread work; never nest this around save(). */
    runExclusive<T>(task: () => Promise<T>): Promise<T> { return this.serial(task); }

    private serial<T>(task: () => Promise<T>): Promise<T> {
        const result = this.running.then(task);
        this.running = result.catch(() => {});
        return result;
    }

    private async keys(): Promise<string[]> {
        const keys = await this.disk.list();
        check(Array.isArray(keys) && keys.every(k => typeof k === 'string'), '备份目录列表无效');
        return [...new Set(keys)].filter(k => KEY.test(k)).sort((a, b) => {
            const time = Number(KEY.exec(b)![2]) - Number(KEY.exec(a)![2]);
            return time || b.localeCompare(a);
        });
    }

    async read(key: string): Promise<{ file: BackupFile; entry: BackupPreview }> {
        const match = KEY.exec(key);
        check(match, '不是本功能管理的备份文件');
        const blob = await this.disk.read(key);
        check(blob instanceof Blob && blob.size > 0 && blob.size <= BACKUP_MAX_BYTES, '备份文件为空或超过 64 MiB 安全读取上限');
        const value = parseStrictJson(await blob.text(), BACKUP_MAX_BYTES) as BackupFile;
        check(value && Object.keys(value).sort().join() === ['format', 'kind', 'savedAt', 'sourceLibrary', 'dataDigest', 'pack', 'checksum'].sort().join(), '备份封装字段不完整');
        check(value.format === OWNER && value.kind === match[1] && value.savedAt === Number(match[2]) &&
            typeof value.sourceLibrary === 'string' && value.sourceLibrary.startsWith(DB_PREFIX), '备份归属或日期不匹配');
        check((await fingerprint(value.sourceLibrary)).slice(0, 16) === match[3], '备份库分组不匹配');
        const { checksum, ...base } = value;
        check(typeof checksum === 'string' && await fingerprint(base) === checksum, '磁盘备份校验和不匹配');
        await validatePackage(value.pack);
        check(value.dataDigest === await fingerprint(value.pack.data), '备份数据摘要不匹配');
        assertNonempty(value.pack);
        const entry = { key, kind: value.kind, savedAt: value.savedAt, snapshotAt: value.pack.created,
            sourceLibrary: value.sourceLibrary, bytes: blob.size, counts: value.pack.counts, checksum };
        this.previews.set(key, entry);
        return { file: value, entry };
    }

    async inventory(): Promise<BackupInventory> {
        // Directory-only: never open full packages, including old files with no hints.
        return { entries: (await this.keys()).map(key => {
            const match = KEY.exec(key)!;
            return { key, kind: match[1] as Kind, savedAt: Number(match[2]), bank: match[3], preview: this.previews.get(key) };
        }) };
    }

    async previewHints(): Promise<BackupPreview[]> {
        return previewHints(await this.disk.readPreviews?.());
    }

    async rememberPreview(entry: BackupPreview): Promise<void> {
        this.previews.set(entry.key, entry);
        if (!this.disk.writePreviews) return;
        // Best effort only. A missing/corrupt hint cache must not invalidate a backup.
        let previous: BackupPreview[] = [];
        try { previous = await this.previewHints(); } catch { /* Rebuild hints, not backups. */ }
        const entries = [entry, ...previous.filter(e => e.key !== entry.key)]
            .sort((a, b) => b.savedAt - a.savedAt).slice(0, PREVIEW_LIMIT);
        try { await this.disk.writePreviews({ schema: 1, entries }); } catch { /* Filename-only fallback remains available. */ }
    }

    save(lib: Library, kind: 'auto' | 'manual' | 'before-restore', keep: typeof AUTO_BACKUP_KEEP = AUTO_BACKUP_KEEP, isCurrent: BackupGuard = () => true): Promise<BackupOutcome> {
        return this.serial(async () => {
            check(keep === AUTO_BACKUP_KEEP, '自动备份固定保留最近 20 份');
            const keys = await this.keys();
            const bank = (await fingerprint(lib.db.name)).slice(0, 16);
            const bankKeys = keys.filter(k => KEY.exec(k)![3] === bank);
            const autos = bankKeys.filter(k => k.startsWith('auto-'));
            if (kind === 'auto' && autos.length && this.now() - Number(KEY.exec(autos[0])![2]) < AUTO_BACKUP_INTERVAL)
                return { state: 'too-soon' };
            // A failed/unreadable latest baseline blocks writes, not just deletion.
            const baseline = kind === 'auto' ? latestBaseline(bankKeys) : undefined;
            const baselineRead = baseline ? await this.read(baseline) : undefined;
            const previous = baselineRead?.file;
            const pack = await exportLibrary(lib); // one consistent readonly transaction
            if (kind === 'before-restore' && pack.counts.stories === 0 && pack.counts.branches === 0)
                return { state: 'empty' };
            assertNonempty(pack);
            check((await isCurrent()), '档案仍在变化，本次备份已取消');
            const digest = await fingerprint(pack.data);
            if (previous?.dataDigest === digest) return { state: 'unchanged' };
            const entry = await this.publish(pack, lib.db.name, kind, digest, keys, isCurrent);
            if (kind !== 'auto') return { state: 'saved', entry };
            // Re-list after publication. No delete happens before full persisted readback.
            try {
                const current = await this.keys();
                const automatic = current.filter(k => k.startsWith('auto-') && KEY.exec(k)![3] === bank);
                if (automatic.length > keep) {
                    // Do not discard a good old copy in favor of an unreadable retained
                    // entry. Validate sequentially so only one full package is live here.
                    for (const retained of automatic.slice(0, keep)) await this.read(retained);
                }
                for (const key of automatic.slice(keep)) {
                    if (key === entry.key) continue;
                    check((await isCurrent()), '档案状态改变，保留新备份并暂停轮换');
                    // Only valid, exact-owner automatic files may be retired. Unknown or
                    // damaged files stay untouched even if this exceeds the retention cap.
                    const old = await this.read(key);
                    check(old.file.kind === 'auto' && old.file.sourceLibrary === lib.db.name, '轮换文件归属不匹配');
                    check((await isCurrent()), '档案状态改变，保留新备份并暂停轮换');
                    await this.disk.remove(key);
                    this.previews.delete(key);
                }
                return { state: 'saved', entry };
            } catch (e) {
                return { state: 'saved', entry, warning: `新备份已验证；旧备份清理未完成，可能暂时超过 ${keep} 份：${errorText(e)}` };
            }
        });
    }

    pin(key: string, checksum: string): Promise<BackupPreview> {
        return this.serial(async () => {
            const source = await this.read(key);
            check(source.entry.checksum === checksum, '所选备份已改变，请重新预览');
            return this.publish(source.file.pack, source.file.sourceLibrary, 'pinned', source.file.dataDigest, await this.keys());
        });
    }

    async restore(key: string, checksum: string, isCurrent = () => true): Promise<Library> {
        return this.serial(async () => {
            const selected = await this.read(key);
            check(selected.entry.checksum === checksum && isCurrent(), '所选备份或页面已改变，请重新预览');
            // The caller must obtain explicit confirmation. No automatic import path.
            const lib = await restoreLibrary(selected.file.pack, false);
            try {
                check(isCurrent(), '恢复页面已改变，已验证的新库未启用，原库保留');
                await activateLibrary(lib, isCurrent);
                return lib;
            } catch (error) { lib.close(); throw error; }
        });
    }

    private async publish(pack: Package, sourceLibrary: string, kind: 'auto' | 'manual' | 'pinned' | 'before-restore', dataDigest: string, keys: string[], isCurrent: BackupGuard = () => true): Promise<BackupPreview> {
        const savedAt = this.now();
        const bank = (await fingerprint(sourceLibrary)).slice(0, 16);
        const suffix = `${this.uuid()}.json`;
        const key = `${kind}-v1-${savedAt}-${bank}-${suffix}`;
        check(KEY.test(key) && !keys.includes(key), '备份文件名冲突，已停止以免覆盖旧文件');
        const base = { format: OWNER as typeof OWNER, kind, savedAt, sourceLibrary, dataDigest, pack };
        const file: BackupFile = { ...base, checksum: await fingerprint(base) };
        const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
        check(blob.size <= BACKUP_MAX_BYTES, '核心包超过 64 MiB 安全读取上限；未写入或轮换备份，请手动导出');
        check((await isCurrent()), '档案仍在变化，本次备份已取消');
        await this.disk.write(key, blob); // TT stages and atomically publishes this unique file.
        const persisted = await this.read(key);
        check(persisted.entry.checksum === file.checksum && persisted.entry.bytes === blob.size, '新备份读回不一致，旧备份保留');
        await this.rememberPreview(persisted.entry);
        return persisted.entry;
    }
}
