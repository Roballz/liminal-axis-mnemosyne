import type { BackupDisk } from '@/st/native-backups';
import { exportLibrary, restoreLibrary, validateCurrentData, type Package } from './migration';
import { type Library, DB_PREFIX, activateLibrary } from './db';
import { check, fingerprint, type Store, type Branch, type Snapshot, type Block } from './model';
import { parseStrictJson } from './json';

export const AUTO_BACKUP_INTERVAL = 30 * 60 * 1000;
export const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const OWNER = 'mnemosyne-core-backup-v1';
const KEY = /^(auto|manual|pinned|before-restore)-v1-(\d{13})-([a-f0-9]{16})-([a-f0-9-]{36})\.json$/;
type Kind = 'auto' | 'manual' | 'pinned' | 'before-restore';
export interface BackupSettings { schema: 1; enabled: boolean; keep: 5 | 10 }
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
export interface BackupInventory { entries: BackupPreview[]; invalid: { key: string; error: string }[] }
export type BackupOutcome = { state: 'saved'; entry: BackupPreview; warning?: string } | { state: 'unchanged' | 'too-soon' | 'empty' };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function backupFailure(e: unknown): string {
    const text = errorText(e);
    if (text.startsWith('本次会话已暂停；')) return text; // Preserve uncertain-settings/restart warning.
    return /quota|enospc|no space|disk.*full|空间不足/i.test(text)
        ? '本机空间不足，磁盘备份未完成；没有删除旧备份。请先腾出空间，再重试'
        : text;
}

export function backupSettings(value: unknown): BackupSettings {
    if (value === undefined) return { schema: 1, enabled: false, keep: 10 };
    const v = value as BackupSettings;
    check(v && v.schema === 1 && typeof v.enabled === 'boolean' && [5, 10].includes(v.keep), '磁盘备份设置损坏，已停止自动备份');
    return { schema: 1, enabled: v.enabled, keep: v.keep };
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

function assertNoLoss(previous: BackupFile, pack: Package, library: string) {
    check(previous.sourceLibrary === library, '活动库已更换，自动备份已暂停；请先核对或恢复，也可手动保存当前库并明确设为新起点');
    // These identity stores cannot legitimately shrink during current-body replacement.
    // Explicit archive deletion also pauses rotation until the user chooses a new baseline.
    const stable: Store[] = ['stories', 'branches', 'source_messages', 'memories', 'event_chains', 'custom_table_defs'];
    for (const store of stable) {
        const current = new Set(pack.data[store].map(row => row.id));
        check(previous.pack.data[store].every(row => current.has(row.id)),
            '发现档案数量或身份减少，自动备份已暂停，旧备份保留；请先核对或恢复，再手动保存并设为新起点');
    }
    const heads = (value: Package) => {
        const snapshots = new Map((value.data.history_snapshots as Snapshot[]).map(row => [row.id, row]));
        const blocks = new Map((value.data.manifest_blocks as Block[]).map(row => [row.id, row]));
        return new Map((value.data.branches as Branch[]).map(branch => [branch.id,
            new Set(snapshots.get(branch.head)!.blocks.flatMap(id => blocks.get(id)!.entries.map(ref => ref.message)))]));
    };
    const nextHeads = heads(pack);
    for (const [branch, messages] of heads(previous.pack)) {
        check([...messages].every(id => nextHeads.get(branch)?.has(id)),
            '当前分支正文变短或消息消失，自动备份已暂停，完整旧备份保留；核对后可手动保存并设为新起点');
    }
}

export class CoreBackups {
    private running: Promise<unknown> = Promise.resolve();
    private previews = new Map<string, BackupPreview>();
    constructor(readonly disk: BackupDisk, private now = () => Date.now(), private uuid = () => crypto.randomUUID()) {}

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
        const result: BackupInventory = { entries: [], invalid: [] };
        for (const key of await this.keys()) {
            // Cached entries are only display hints. Selection, pin and restore always
            // re-read and validate the selected file; no persisted index is authoritative.
            try { result.entries.push(this.previews.get(key) ?? (await this.read(key)).entry); }
            catch (e) { result.invalid.push({ key, error: errorText(e) }); }
        }
        return result;
    }

    save(lib: Library, kind: 'auto' | 'manual' | 'before-restore', keep: 5 | 10 = 10, isCurrent = () => true): Promise<BackupOutcome> {
        return this.serial(async () => {
            check([5, 10].includes(keep), '仅支持保留最近 5 或 10 份自动备份');
            const keys = await this.keys();
            const bank = (await fingerprint(lib.db.name)).slice(0, 16);
            const bankKeys = keys.filter(k => KEY.exec(k)![3] === bank);
            const autos = bankKeys.filter(k => k.startsWith('auto-'));
            if (kind === 'auto' && autos.length && this.now() - Number(KEY.exec(autos[0])![2]) < AUTO_BACKUP_INTERVAL)
                return { state: 'too-soon' };
            // A failed/unreadable latest baseline blocks writes, not just deletion.
            const baseline = kind === 'auto' ? bankKeys.find(k => /^(auto|manual)-/.test(k)) : undefined;
            const previous = baseline ? (await this.read(baseline)).file : undefined;
            const pack = await exportLibrary(lib); // one consistent readonly transaction
            if (kind === 'before-restore' && pack.counts.stories === 0 && pack.counts.branches === 0)
                return { state: 'empty' };
            assertNonempty(pack);
            check(isCurrent(), '档案仍在变化，本次备份已取消');
            if (previous) assertNoLoss(previous, pack, lib.db.name);
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
                    check(isCurrent(), '档案状态改变，保留新备份并暂停轮换');
                    // Only valid, exact-owner automatic files may be retired. Unknown or
                    // damaged files stay untouched even if this exceeds the retention cap.
                    const old = await this.read(key);
                    check(old.file.kind === 'auto' && old.file.sourceLibrary === lib.db.name, '轮换文件归属不匹配');
                    check(isCurrent(), '档案状态改变，保留新备份并暂停轮换');
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
                await activateLibrary(lib);
                return lib;
            } catch (error) { lib.close(); throw error; }
        });
    }

    private async publish(pack: Package, sourceLibrary: string, kind: Kind, dataDigest: string, keys: string[], isCurrent = () => true): Promise<BackupPreview> {
        const savedAt = this.now();
        const bank = (await fingerprint(sourceLibrary)).slice(0, 16);
        const key = `${kind}-v1-${savedAt}-${bank}-${this.uuid()}.json`;
        check(KEY.test(key) && !keys.includes(key), '备份文件名冲突，已停止以免覆盖旧文件');
        const base = { format: OWNER as typeof OWNER, kind, savedAt, sourceLibrary, dataDigest, pack };
        const file: BackupFile = { ...base, checksum: await fingerprint(base) };
        const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
        check(blob.size <= BACKUP_MAX_BYTES, '核心包超过 64 MiB 安全读取上限；未写入或轮换备份，请手动导出');
        check(isCurrent(), '档案仍在变化，本次备份已取消');
        await this.disk.write(key, blob); // TT stages and atomically publishes this unique file.
        const persisted = await this.read(key);
        check(persisted.entry.checksum === file.checksum && persisted.entry.bytes === blob.size, '新备份读回不一致，旧备份保留');
        return persisted.entry;
    }
}
