import type { BackupDisk } from '@/st/native-backups';
import { exportLibrary, restoreLibrary, validateCurrentData, type Package } from './migration';
import { type Library, DB_PREFIX, activateLibrary } from './db';
import { check, fingerprint } from './model';
import { parseStrictJson } from './json';
import { archivePackage, backupBankKey, exportArchive, packageData, validateArchive, type ArchivePackage, type CorePackage } from './archive-package';

export const AUTO_BACKUP_KEEP = 10;
export const AUTO_BACKUP_INTERVAL = 30 * 60 * 1000;
export const BACKUP_MAX_MIB = 512;
export const BACKUP_MAX_BYTES = BACKUP_MAX_MIB * 1024 * 1024;
export function corePackageSizeError(bytes: number): string {
    return `核心包大小 ${(bytes / 1024 / 1024).toFixed(2)} MiB（${bytes} 字节），超过 ${BACKUP_MAX_MIB} MiB 上限`;
}
const OWNER = 'mnemosyne-core-backup-v1';
const KEY = /^(auto|manual|pinned|before-restore|before-deletion|before-archive-deletion|after-archive-deletion)-v1-(\d{13})-([a-f0-9]{16})-([a-f0-9-]{36})\.json$/;
export type BackupGuard = () => boolean | Promise<boolean>;
export type BackupSaveKind = 'auto' | 'manual' | 'before-restore';
type Kind = 'auto' | 'manual' | 'pinned' | 'before-restore' | 'before-deletion' | 'before-archive-deletion' | 'after-archive-deletion';
export interface BackupSettings { schema: 1; enabled: boolean; keep: typeof AUTO_BACKUP_KEEP }
export interface BackupFile {
    format: typeof OWNER;
    kind: Kind;
    savedAt: number;
    sourceLibrary: string;
    dataDigest: string;
    pack: CorePackage;
    checksum: string;
}
export interface BackupPreview {
    archive?: ArchivePackage['archive'];
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
    }).map(({ key, kind, savedAt, snapshotAt, sourceLibrary, bytes, counts, checksum, archive }) =>
        ({ key, kind, savedAt, snapshotAt, sourceLibrary, bytes, counts, checksum,
            ...(archive && typeof archive.branch === 'string' && typeof archive.label === 'string' &&
                typeof archive.story === 'string' && Array.isArray(archive.scopes) && archive.scopes.every(s => typeof s === 'string')
                ? { archive } : {}) }));
}
export type BackupOutcome = { state: 'saved'; entry: BackupPreview; warning?: string } | { state: 'unchanged'; entry?: BackupPreview; warning?: string } | { state: 'too-soon' | 'empty' };
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
    check(v && v.schema === 1 && typeof v.enabled === 'boolean' && [5, 10, 20].includes(v.keep), '磁盘备份设置损坏，已停止自动备份');
    // Keep the enabled flag, migrate every old setting to ten automatic copies per archive.
    return { schema: 1, enabled: v.enabled, keep: AUTO_BACKUP_KEEP };
}

export async function validatePackage(value: unknown): Promise<CorePackage> {
    if (archivePackage(value)) return validateArchive(value);
    const pack = value as Package;
    await validateCurrentData(pack);
    const { checksum, ...base } = pack;
    check(typeof checksum === 'string' && await fingerprint(base) === checksum, '核心包校验和不匹配');
    check(Number.isSafeInteger(pack.created) && pack.created > 0, '核心包日期无效');
    return pack;
}

function assertNonempty(value: CorePackage) {
    const pack = packageData(value);
    check(pack.counts.stories > 0 && pack.counts.branches > 0 &&
        pack.counts.source_messages + pack.counts.memories + pack.counts.event_chains + pack.counts.custom_table_rows > 0,
    '当前核心库为空，停止备份和轮换；请先从已有备份恢复');
}

// Evidence lives for one save only. Re-read the named file before using it: neither
// a filename nor preview metadata proves that another writer left its bytes intact.
type FileWitness = { bytes: number; digest: string };
type PreparedBackup = { key: string; blob: Blob; checksum: string };
async function blobDigest(blob: Blob): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
        byte => byte.toString(16).padStart(2, '0')).join('');
}

async function parseBackupBlob(blob: Blob): Promise<BackupFile> {
    // End the text/decoder frame before validation allocates checksum buffers.
    return parseStrictJson(await blob.text(), BACKUP_MAX_BYTES) as BackupFile;
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

    async read(key: string, witnesses?: Map<string, FileWitness>): Promise<{ file: BackupFile; entry: BackupPreview }> {
        check(KEY.test(key), '不是本功能管理的备份文件');
        const blob = await this.disk.read(key);
        const result = await this.decode(key, blob);
        if (witnesses) witnesses.set(key, { bytes: blob.size, digest: await blobDigest(blob) });
        return result;
    }

    private async decode(key: string, blob: Blob): Promise<{ file: BackupFile; entry: BackupPreview }> {
        const match = KEY.exec(key);
        check(match, '不是本功能管理的备份文件');
        check(blob instanceof Blob && blob.size > 0, '备份文件为空或无效');
        check(blob.size <= BACKUP_MAX_BYTES, `${corePackageSizeError(blob.size)}；未恢复或更改当前库`);
        const value = await parseBackupBlob(blob);
        check(value && Object.keys(value).sort().join() === ['format', 'kind', 'savedAt', 'sourceLibrary', 'dataDigest', 'pack', 'checksum'].sort().join(), '备份封装字段不完整');
        check(value.format === OWNER && value.kind === match[1] && value.savedAt === Number(match[2]) &&
            typeof value.sourceLibrary === 'string' && value.sourceLibrary.startsWith(DB_PREFIX), '备份归属或日期不匹配');
        check((await fingerprint(backupBankKey(value.sourceLibrary, archivePackage(value.pack) ? value.pack.archive.branch : undefined))).slice(0, 16) === match[3], '备份档案分组不匹配');
        const { checksum, ...base } = value;
        check(typeof checksum === 'string' && await fingerprint(base) === checksum, '磁盘备份校验和不匹配');
        await validatePackage(value.pack);
        const pack = packageData(value.pack);
        check(value.dataDigest === await fingerprint(pack.data), '备份数据摘要不匹配');
        assertNonempty(value.pack);
        const entry = { key, kind: value.kind, savedAt: value.savedAt, snapshotAt: pack.created,
            sourceLibrary: value.sourceLibrary, bytes: blob.size, counts: pack.counts, checksum,
            ...(archivePackage(value.pack) ? { archive: value.pack.archive } : {}) };
        this.previews.set(key, entry);
        return { file: value, entry };
    }

    private async verifyRetained(key: string, witnesses: Map<string, FileWitness>): Promise<void> {
        const known = witnesses.get(key);
        if (!known) { await this.read(key); return; }
        const blob = await this.disk.read(key);
        if (blob instanceof Blob && blob.size === known.bytes && await blobDigest(blob) === known.digest) return;
        await this.decode(key, blob);
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

    /** Display hint only; never reused as proof for pin, restore, or rotation. */
    cachePreview(entry: BackupPreview): void { this.previews.set(entry.key, entry); }

    async rememberPreview(entry: BackupPreview): Promise<void> {
        this.cachePreview(entry);
        if (!this.disk.writePreviews) return;
        // Best effort only. A missing/corrupt hint cache must not invalidate a backup.
        let previous: BackupPreview[] = [];
        try { previous = await this.previewHints(); } catch { /* Rebuild hints, not backups. */ }
        const entries = [entry, ...previous.filter(e => e.key !== entry.key)]
            .sort((a, b) => b.savedAt - a.savedAt).slice(0, PREVIEW_LIMIT);
        try { await this.disk.writePreviews({ schema: 1, entries }); } catch { /* Filename-only fallback remains available. */ }
    }

    save(lib: Library, kind: BackupSaveKind, keep: typeof AUTO_BACKUP_KEEP = AUTO_BACKUP_KEEP, isCurrent: BackupGuard = () => true,
        onVerified?: (entry: BackupPreview, unchanged?: true) => void, branch?: string): Promise<BackupOutcome> {
        return this.serial(async () => {
            check(keep === AUTO_BACKUP_KEEP, '每个档案固定保留最近 10 份自动备份');
            const keys = await this.keys();
            const bank = (await fingerprint(backupBankKey(lib.db.name, branch))).slice(0, 16);
            const bankKeys = keys.filter(k => KEY.exec(k)![3] === bank);
            const autos = bankKeys.filter(k => k.startsWith('auto-'));
            if (kind === 'auto' && autos.length && this.now() - Number(KEY.exec(autos[0])![2]) < AUTO_BACKUP_INTERVAL)
                return { state: 'too-soon' };
            // A failed/unreadable latest baseline blocks writes, not just deletion.
            const baseline = kind === 'auto' ? latestBaseline(bankKeys) : undefined;
            const witnesses = new Map<string, FileWitness>();
            // Release the parsed previous package before preparing another full snapshot.
            const previous = baseline ? await this.read(baseline, witnesses)
                .then(({ file, entry }) => ({ digest: file.dataDigest, entry })) : undefined;
            const previousDigest = previous?.digest;
            // The preparation frame owns the full snapshot. Only a Blob and small
            // metadata survive into publication, which parses a separate readback.
            const prepared = await this.prepareLibrary(lib, kind, previousDigest, keys, isCurrent, branch);
            if ('state' in prepared) {
                if (prepared.state === 'empty' || !previous) return prepared;
                // A prior publication may have succeeded before rotation was interrupted.
                // Unchanged data still validates that baseline and resumes its pending cleanup.
                onVerified?.(previous.entry, true);
                const warning = await this.rotate(lib, bank, keep, previous.entry.key, witnesses, isCurrent, branch);
                return { state: 'unchanged', entry: previous.entry, ...(warning ? { warning } : {}) };
            }
            const entry = await this.publish(prepared, isCurrent, kind === 'auto' ? witnesses : undefined, onVerified);
            if (kind !== 'auto') return { state: 'saved', entry };
            const warning = await this.rotate(lib, bank, keep, entry.key, witnesses, isCurrent, branch);
            return { state: 'saved', entry, ...(warning ? { warning } : {}) };
        });
    }

    private async rotate(lib: Library, bank: string, keep: number, published: string,
        witnesses: Map<string, FileWitness>, isCurrent: BackupGuard, branch?: string): Promise<string | undefined> {
        try {
            const automatic = (await this.keys()).filter(k => k.startsWith('auto-') && KEY.exec(k)![3] === bank);
            if (automatic.length > keep) {
                for (const retained of automatic.slice(0, keep)) {
                    check(await isCurrent(), '档案状态改变，保留新备份并暂停轮换');
                    await this.verifyRetained(retained, witnesses);
                }
            }
            for (const key of automatic.slice(keep)) {
                if (key === published) continue;
                check(await isCurrent(), '档案状态改变，保留新备份并暂停轮换');
                const old = await this.read(key);
                check(old.file.kind === 'auto' && old.file.sourceLibrary === lib.db.name && old.entry.archive?.branch === branch, '轮换文件归属不匹配');
                check(await isCurrent(), '档案状态改变，保留新备份并暂停轮换');
                await this.disk.remove(key);
                this.previews.delete(key);
            }
        } catch (error) {
            return `备份已验证；旧备份清理未完成，可能暂时超过 ${keep} 份：${errorText(error)}`;
        }
    }

    pin(key: string, checksum: string, isCurrent: BackupGuard = () => true): Promise<BackupPreview> {
        return this.serial(async () => {
            const prepared = await this.preparePinned(key, checksum, isCurrent);
            return this.publish(prepared, isCurrent);
        });
    }

    private async prepareLibrary(lib: Library, kind: BackupSaveKind, previousDigest: string | undefined,
        keys: string[], isCurrent: BackupGuard, branch?: string): Promise<PreparedBackup | { state: 'empty' | 'unchanged' }> {
        const pack = branch ? await exportArchive(lib, branch) : await exportLibrary(lib);
        const data = packageData(pack);
        if (kind === 'before-restore' && data.counts.stories === 0 && data.counts.branches === 0)
            return { state: 'empty' };
        assertNonempty(pack);
        check(await isCurrent(), '档案仍在变化，本次备份已取消');
        const digest = await fingerprint(data.data);
        if (previousDigest === digest) return { state: 'unchanged' };
        return this.prepareFile(pack, lib.db.name, kind, digest, keys);
    }

    private async preparePinned(key: string, checksum: string, isCurrent: BackupGuard): Promise<PreparedBackup> {
        const source = await this.read(key);
        check(source.entry.checksum === checksum && await isCurrent(), '所选备份已改变，请重新预览');
        return this.prepareFile(source.file.pack, source.file.sourceLibrary, 'pinned', source.file.dataDigest, await this.keys());
    }

    /** Worker restore prepares and verifies a fresh database; only the UI may activate it. */
    prepareRestore(key: string, checksum: string, isCurrent: BackupGuard = () => true): Promise<Library> {
        return this.serial(() => this.restoreCopy(key, checksum, isCurrent));
    }

    private async restoreCopy(key: string, checksum: string, isCurrent: BackupGuard): Promise<Library> {
        const selected = await this.read(key);
        check(selected.entry.checksum === checksum && await isCurrent(), '所选备份或页面已改变，请重新预览');
        check(!archivePackage(selected.file.pack), '单档案备份必须恢复到对应档案，不能切换整个数据库');
        const lib = await restoreLibrary(selected.file.pack, false);
        try {
            check(await isCurrent(), '恢复页面已改变，已验证的新库未启用，原库保留');
            return lib;
        } catch (error) { lib.close(); throw error; }
    }

    async restore(key: string, checksum: string, isCurrent = () => true): Promise<Library> {
        return this.serial(async () => {
            // The caller must obtain explicit confirmation. No automatic import path.
            const lib = await this.restoreCopy(key, checksum, isCurrent);
            try {
                check(isCurrent(), '恢复页面已改变，已验证的新库未启用，原库保留');
                await activateLibrary(lib, isCurrent);
                return lib;
            } catch (error) { lib.close(); throw error; }
        });
    }

    private async prepareFile(pack: CorePackage, sourceLibrary: string, kind: BackupSaveKind | 'pinned', dataDigest: string,
        keys: string[]): Promise<PreparedBackup> {
        const savedAt = this.now();
        const bank = (await fingerprint(backupBankKey(sourceLibrary, archivePackage(pack) ? pack.archive.branch : undefined))).slice(0, 16);
        const suffix = `${this.uuid()}.json`;
        const key = `${kind}-v1-${savedAt}-${bank}-${suffix}`;
        check(KEY.test(key) && !keys.includes(key), '备份文件名冲突，已停止以免覆盖旧文件');
        const base = { format: OWNER as typeof OWNER, kind, savedAt, sourceLibrary, dataDigest, pack };
        const file: BackupFile = { ...base, checksum: await fingerprint(base) };
        const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
        check(blob.size <= BACKUP_MAX_BYTES, `${corePackageSizeError(blob.size)}；未写入或轮换备份。可手动导出保留副本，但超限文件不能在本版本导入`);
        return { key, blob, checksum: file.checksum };
    }

    private async publish({ key, blob, checksum }: PreparedBackup, isCurrent: BackupGuard,
        witnesses?: Map<string, FileWitness>, onVerified?: (entry: BackupPreview) => void): Promise<BackupPreview> {
        check((await isCurrent()), '档案仍在变化，本次备份已取消');
        await this.disk.write(key, blob); // TT stages and atomically publishes this unique file.
        const { entry } = await this.read(key, witnesses);
        check(entry.checksum === checksum && entry.bytes === blob.size, '新备份读回不一致，旧备份保留');
        onVerified?.(entry); // Durable readback is success, independently of later metadata/rotation.
        await this.rememberPreview(entry);
        return entry;
    }
}
