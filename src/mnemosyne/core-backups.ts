import { archiveDeletionResult, sameArchiveData, type ArchiveDeletionPlan } from './archive-deletion';
import type { BackupDisk } from '@/st/native-backups';
import { exportLibrary, restoreLibrary, validateCurrentData, type Package } from './migration';
import { type Library, DB_PREFIX, activateLibrary } from './db';
import { check, fingerprint, STORES, equal, type Store, type Branch, type Snapshot, type Block, type Binding } from './model';
import { parseStrictJson } from './json';

export const AUTO_BACKUP_INTERVAL = 30 * 60 * 1000;
export const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const OWNER = 'mnemosyne-core-backup-v1';
const KEY = /^(auto|manual|pinned|before-restore|before-deletion|before-archive-deletion|after-archive-deletion)-v1-(\d{13})-([a-f0-9]{16})-([a-f0-9-]{36})\.json$/;
type Kind = 'auto' | 'manual' | 'pinned' | 'before-restore' | 'before-deletion' | 'before-archive-deletion' | 'after-archive-deletion';
// A content-addressed suffix makes uncertain-write retry O(1) full-file reads,
// independent of how many permanent deletion protections have accumulated.
const protectionSuffix = (digest: string) => {
    const hex = digest.slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.json`;
};
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
export interface ArchiveLossAcceptance {
    previous: BackupPreview;
    currentCounts: Package['counts'];
    currentDigest: string;
}
function latestBaseline(keys: string[]): string | undefined {
    return keys.filter(k => /^(auto|manual|before-deletion|after-archive-deletion)-/.test(k)).sort((a, b) =>
        Number(KEY.exec(b)![2]) - Number(KEY.exec(a)![2]) ||
        Number(a.startsWith('before-deletion-')) - Number(b.startsWith('before-deletion-')) ||
        Number(b.startsWith('after-archive-deletion-')) - Number(a.startsWith('after-archive-deletion-')))[0];
}
function recoveryBaseline(keys: string[]): string | undefined {
    return keys.filter(k => /^(auto|manual|before-deletion|before-archive-deletion|after-archive-deletion)-/.test(k)).sort((a, b) =>
        Number(KEY.exec(b)![2]) - Number(KEY.exec(a)![2]) ||
        Number(b.startsWith('after-archive-deletion-')) - Number(a.startsWith('after-archive-deletion-')) || b.localeCompare(a))[0];
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

function inspectLoss(previous: BackupFile, pack: Package, library: string): boolean {
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
        return new Map((value.data.branches as Branch[]).map(branch => [branch.id, {
            branch, refs: snapshots.get(branch.head)!.blocks.flatMap(id => blocks.get(id)!.entries),
        }]));
    };
    const nextHeads = heads(pack);
    let deletion = false;
    for (const [id, old] of heads(previous.pack)) {
        const next = nextHeads.get(id)!;
        const current = new Set(next.refs.map(ref => ref.message));
        if (old.refs.every(ref => current.has(ref.message))) continue;
        // A validated, forward observation of the same binding is required. Merely
        // selecting a different branch, restoring an old head, or losing a database
        // cannot authorize adoption of a shorter baseline.
        const bindings = (value: Package) => (value.data.host_bindings as Binding[])
            .filter(binding => binding.branch === id && !binding.detached);
        const before = bindings(previous.pack), after = bindings(pack);
        check(before.length === 1 && after.length === 1 && JSON.stringify(before[0]) === JSON.stringify(after[0]) &&
            next.branch.epoch > old.branch.epoch && next.branch.story === old.branch.story &&
            JSON.stringify(next.branch.fork) === JSON.stringify(old.branch.fork),
            '正文减少但绑定或版本证据不足，自动备份暂缓；请核对后手动保存并设为新起点');
        check(next.refs.length > 0, '当前分支正文为空，无法区分删除与来源未就绪；自动备份暂缓，旧备份保留');
        // Limit automatic recovery to an ordered subset with unchanged surviving
        // revisions. Mixed edits/reorders are ambiguous and retain the old guard.
        if (previous.kind === 'before-deletion') {
            check(old.refs.some(ref => current.has(ref.message)), '正文身份全部改变，保留删除保护并暂缓自动备份');
            deletion = true;
            continue;
        }
        let cursor = 0;
        for (const ref of next.refs) {
            while (cursor < old.refs.length && old.refs[cursor].message !== ref.message) cursor++;
            check(cursor < old.refs.length && old.refs[cursor].revision === ref.revision,
                '正文减少同时存在新增、改写或重排，自动备份暂缓；请核对后手动保存并设为新起点');
            cursor++;
        }
        deletion = true;
    }
    return deletion;
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

    save(lib: Library, kind: 'auto' | 'manual' | 'before-restore', keep: 5 | 10 = 10, isCurrent = () => true, onProtected?: (entry: BackupPreview) => void): Promise<BackupOutcome> {
        return this.serial(async () => {
            check([5, 10].includes(keep), '仅支持保留最近 5 或 10 份自动备份');
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
            check(isCurrent(), '档案仍在变化，本次备份已取消');
            const deletion = previous ? inspectLoss(previous, pack, lib.db.name) : false;
            if (deletion && previous) {
                // Reuse a verified protection after an uncertain write or interrupted
                // post-deletion publication. Never export the current pack under this name.
                const protectionKey = bankKeys.find(k => k.startsWith('before-deletion-') && k.endsWith(protectionSuffix(previous.dataDigest)));
                let protectedEntry: BackupPreview | undefined;
                if (previous.kind === 'before-deletion') protectedEntry = baselineRead!.entry;
                else if (protectionKey) {
                    const saved = await this.read(protectionKey);
                    check(saved.file.dataDigest === previous.dataDigest, '删除保护内容身份冲突');
                    protectedEntry = saved.entry;
                }
                if (!protectedEntry) protectedEntry = await this.publish(previous.pack, lib.db.name,
                    'before-deletion', previous.dataDigest, keys, isCurrent);
                check(isCurrent(), '删除前保护已保存；当前档案已改变，暂缓新起点和轮换');
                onProtected?.(protectedEntry);
            }
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

    /** Export the still-current database before destructive reconciliation begins. */
    protectCurrentDeletion(lib: Library, expected: Branch, isCurrent = () => true): Promise<BackupPreview> {
        return this.serial(async () => {
            const pack = await exportLibrary(lib);
            const branch = (pack.data.branches as Branch[]).find(b => b.id === expected.id);
            check(branch && branch.head === expected.head && branch.view === expected.view && branch.epoch === expected.epoch && isCurrent(),
                '删除保护期间档案已变化，请重试；尚未应用删除');
            assertNonempty(pack);
            const digest = await fingerprint(pack.data), keys = await this.keys();
            const bank = (await fingerprint(lib.db.name)).slice(0, 16);
            const existing = keys.find(k => k.startsWith('before-deletion-') && KEY.exec(k)![3] === bank && k.endsWith(protectionSuffix(digest)));
            if (existing) {
                const saved = await this.read(existing);
                check(saved.file.dataDigest === digest && isCurrent(), '删除保护内容或聊天已变化，请重试');
                return saved.entry;
            }
            const entry = await this.publish(pack, lib.db.name, 'before-deletion', digest, keys, isCurrent);
            check(isCurrent(), '删除保护已保存；聊天已变化，尚未应用删除');
            return entry;
        });
    }

    private async protectArchivePack(pack: Package, library: string, keys: string[], isCurrent: () => boolean) {
        const digest = await fingerprint(pack.data), bank = (await fingerprint(library)).slice(0, 16);
        const key = keys.find(k => k.startsWith('before-archive-deletion-') && KEY.exec(k)![3] === bank && k.endsWith(protectionSuffix(digest)));
        if (key) {
            const saved = await this.read(key);
            check(saved.file.dataDigest === digest && isCurrent(), '档案删除保护或当前选择已变化');
            return saved.entry;
        }
        return this.publish(pack, library, 'before-archive-deletion', digest, keys, isCurrent);
    }

    protectArchiveDeletion(lib: Library, plan: ArchiveDeletionPlan, isCurrent: () => boolean): Promise<BackupPreview> {
        return this.serial(async () => {
            // Preview already exported/validated this complete package. Recheck its
            // snapshot in one readonly transaction, avoiding a second full export/hash
            // before native write. The deletion transaction repeats this CAS later.
            await lib.transaction(STORES, 'readonly', async tx => {
                for (const store of STORES) check(equal(await tx.all(store), plan.before.data[store]), '档案已改变，请重新预览删除');
                check(isCurrent(), '删除选择已改变，请重新预览');
            });
            assertNonempty(plan.before);
            const entry = await this.protectArchivePack(plan.before, lib.db.name, await this.keys(), isCurrent);
            check(isCurrent(), '档案删除保护已保存，但选择已变化；尚未删除');
            return entry;
        });
    }

    completeArchiveDeletion(lib: Library, plan: ArchiveDeletionPlan, isCurrent: () => boolean): Promise<BackupOutcome> {
        return this.serial(async () => {
            const pack = await exportLibrary(lib);
            check(sameArchiveData(pack.data, archiveDeletionResult(plan)) && isCurrent(),
                '档案已删除，但当前数据随后改变；请核对后恢复自动备份起点');
            if (pack.counts.stories === 0 && pack.counts.branches === 0) return { state: 'empty' };
            assertNonempty(pack);
            const entry = await this.publish(pack, lib.db.name, 'after-archive-deletion', await fingerprint(pack.data), await this.keys(), isCurrent);
            return { state: 'saved', entry };
        });
    }

    async previewArchiveLoss(lib: Library): Promise<ArchiveLossAcceptance> {
        const keys = await this.keys(), bank = (await fingerprint(lib.db.name)).slice(0, 16);
        const key = recoveryBaseline(keys.filter(k => KEY.exec(k)![3] === bank));
        check(key, '当前库没有可验证的旧备份，不能补造删除前保护包');
        const previous = await this.read(key), current = await exportLibrary(lib);
        assertNonempty(current);
        return { previous: previous.entry, currentCounts: current.counts, currentDigest: await fingerprint(current.data) };
    }

    acceptArchiveLoss(lib: Library, approval: ArchiveLossAcceptance, isCurrent: () => boolean, onProtected?: (entry: BackupPreview) => void): Promise<BackupOutcome> {
        return this.serial(async () => {
            const keys = await this.keys(), bank = (await fingerprint(lib.db.name)).slice(0, 16);
            check(recoveryBaseline(keys.filter(k => KEY.exec(k)![3] === bank)) === approval.previous.key, '旧备份起点已改变，请重新核对');
            const previous = await this.read(approval.previous.key), current = await exportLibrary(lib);
            check(previous.entry.checksum === approval.previous.checksum && previous.file.sourceLibrary === lib.db.name &&
                await fingerprint(current.data) === approval.currentDigest && isCurrent(), '备份或当前档案已改变，请重新核对');
            assertNonempty(current);
            const protection = await this.protectArchivePack(previous.file.pack, lib.db.name, keys, isCurrent);
            onProtected?.(protection);
            const live = await exportLibrary(lib);
            check(await fingerprint(live.data) === approval.currentDigest, '旧包已保护，但当前档案随后改变，请重新核对新起点');
            check(isCurrent(), '旧包已保护，当前选择已变化；尚未接受新起点');
            const entry = await this.publish(current, lib.db.name, 'after-archive-deletion', approval.currentDigest, await this.keys(), isCurrent);
            return { state: 'saved', entry };
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
        const suffix = (kind === 'before-deletion' || kind === 'before-archive-deletion') ? protectionSuffix(dataDigest) : `${this.uuid()}.json`;
        const key = `${kind}-v1-${savedAt}-${bank}-${suffix}`;
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
