import { coreFormatVersion, prefixEncoded } from './stored-source-prefix';
import { Library, request, type Transaction } from './db';
import { STORES, check, equal, fingerprint, type Binding, type Branch, type Row, type Store, type Snapshot, type Block } from './model';
import { validateCurrentData, type Package } from './migration';
import { SHARED_FIELDS, SHARED_META, payloadReader, sharedStore, type Payload } from './shared-payloads';
import { recordLinks, markRecords, type RecordLink } from './archive-graph';
import { RETENTION_CONTROL_STORE } from './retention-roots';
import { unreferencedStorage } from './shared-garbage';

export interface ArchivePackage {
    format: 'mnemosyne-archive'; version: 1;
    archive: { branch: string; story: string; scopes: string[]; label: string };
    pack: Package; checksum: string;
}
export const archivePackage = (value: unknown): value is ArchivePackage =>
    !!value && (value as ArchivePackage).format === 'mnemosyne-archive';
export type CorePackage = Package | ArchivePackage;
export const packageData = (value: CorePackage) => archivePackage(value) ? value.pack : value;
export const backupBankKey = (library: string, branch?: string) => branch ? `${library}\narchive:${branch}` : library;
const blank = () => Object.fromEntries(STORES.map(s => [s, []])) as unknown as Package['data'];
const label = (scope: string) => { try { return String(JSON.parse(scope)[1] || scope); } catch { return scope; } };

function packageContents(data: Package['data']) {
    return { format: 'mnemosyne-daily' as const, version: coreFormatVersion(data), schema: 1 as const, created: Date.now(),
        excluded: ['host-chat-files', 'chat-state-delta', 'knowledge-files-and-vectors', 'vector-indexes', 'api-secrets'],
        counts: Object.fromEntries(STORES.map(s => [s, data[s].length])) as Package['counts'], data };
}

export async function sealPackage(data: Package['data']): Promise<Package> {
    const base = packageContents(data);
    await validateCurrentData(base);
    return { ...base, checksum: await fingerprint(base) };
}

function payloadLinks(store: Store, row: Row): RecordLink[] {
    const result: RecordLink[] = [];
    for (const field of (SHARED_FIELDS as any)[store] ?? []) {
        const id = (row as any)[field]?.shared;
        if (typeof id === 'string') result.push(['memory_payloads', id]);
    }
    if (store === 'memory_payloads' && (row as Payload).kind === 'node')
        for (const id of (row as Payload).value) result.push(['memory_payloads', id]);
    return result;
}

/** Indexed reads of one archive plus its exact dependency closure. No all-library getAll,
 * no source bodies belonging only to parent/sibling chats, and no global settings. */
export async function exportArchive(lib: Library, branchId: string): Promise<ArchivePackage> {
    const { data, branch, bindings } = await lib.transaction(STORES, 'readonly', async tx => {
        const branch = await tx.get<Branch>('branches', branchId);
        check(branch && !branch.archiveSupport, '当前聊天没有可备份的档案');
        const bindings = await tx.all<Binding>('host_bindings', 'branch', branchId);
        check(bindings.length, '当前档案缺少聊天绑定');
        const data = blank(), seen = new Map(STORES.map(s => [s, new Set<string>()]));
        const pending: RecordLink[] = [['branches', branchId]];
        const synthetic = new Map<string, Row>();
        const origins = await tx.get<Row>('library_meta', 'retired-source-bindings');
        const retired = new Map<string, Binding>(((origins as any)?.value.bindings ?? []).map((b: Binding) => [b.id, b]));
        const put = (store: Store, row: Row) => {
            if (seen.get(store)!.has(row.id)) return;
            seen.get(store)!.add(row.id); data[store].push(row);
        };
        // Branch-local history remains part of this archive; the retention collector
        // removes superseded records separately, never while preparing a readonly backup.
        for (const store of STORES) {
            if (['branches', 'stories', 'source_messages', 'source_revisions', 'source_bodies', 'manifest_blocks',
                'memory_payloads', 'memory_selection_nodes', 'message_mappings', 'memories', 'library_meta', 'history_snapshots'].includes(store)) continue;
            for (const row of await tx.rawAll(store, 'branch', branchId)) pending.push([store, row.id]);
        }
        for (const binding of bindings) for (const store of ['message_mappings', 'memories'] as const)
            for (const row of await tx.rawAll(store, 'owner', binding.id)) pending.push([store, row.id]);
        // Heads, predecessors, fork points and explicit evidence enter through recordLinks.
        // A parent snapshot pinned solely by another chat's fork does not belong in this export.
        // Role repairs also have implicit witnesses, which the integrity validator checks.
        if (branch.sourceRoleRepairs?.length) {
            const revisions = new Set(branch.sourceRoleRepairs.flatMap(pair => [pair.before.revision, pair.after.revision]));
            const witnesses = new Map<string, boolean>();
            for (const snapshot of await tx.rawAll<Snapshot>('history_snapshots', 'branch', branchId)) {
                if (snapshot.snapshotSchema !== 2) continue;
                for (const key of snapshot.blocks) {
                    if (!witnesses.has(key)) {
                        const block = await tx.rawGet<Block>('manifest_blocks', key);
                        check(block, '角色修复来源清单缺失');
                        witnesses.set(key, block.entries.some(ref => revisions.has(ref.revision)));
                    }
                    if (witnesses.get(key)) { pending.push(['history_snapshots', snapshot.id]); break; }
                }
            }
        }
        const head = await tx.get<Snapshot>('history_snapshots', branch.head); check(head, '当前档案正文快照缺失');
        for (const key of head.blocks) {
            const block = await tx.get<Block>('manifest_blocks', key); check(block, '当前档案正文索引缺失');
            for (const ref of block.entries) {
                const body = await tx.rawGet('source_bodies', ref.revision);
                if (body) put('source_bodies', body);
            }
        }
        while (pending.length) {
            const [store, id] = pending.pop()!;
            if (seen.get(store)!.has(id)) continue;
            let physical = synthetic.get(`${store}:${id}`) ?? await tx.rawGet(store, id);
            if (store === 'host_bindings' && !physical) physical = retired.get(id);
            if (store === 'branches' && id !== branchId) {
                const origin = [...retired.values()].find(b => b.branch === id);
                check(physical || origin, '单档案缺少父来源身份');
                const story = physical?.story ?? origin!.story, headId = `archive-support-head:${id}`, viewId = `archive-support-view:${id}`;
                physical = { id, schema: 1, story, head: headId, view: viewId, epoch: 0,
                    fork: null, archiveSupport: 1 } as Branch;
                synthetic.set(`history_snapshots:${headId}`, { id: headId, schema: 1, story, branch: id, owner: `current:${id}`,
                    snapshotSchema: 2, previous: null, blocks: [], length: 0, created: 0 } as Snapshot);
                synthetic.set(`memory_views:${viewId}`, { id: viewId, schema: 1, branch: id, selections: {} } as Row);
            }
            check(physical, `单档案依赖缺失 ${store}/${id}`);
            if (store === 'host_bindings' && physical.branch !== branchId)
                physical = { ...physical, rebindSchema: 1, detached: true } as Binding;
            put(store, physical);
            const logical = sharedStore(store)
                ? await tx.get(store, id) : physical;
            check(logical, '单档案共享记录缺失');
            pending.push(...recordLinks(store, logical), ...payloadLinks(store, physical));
        }
        if (data.memory_payloads.length) put('library_meta', { id: SHARED_META, schema: 1, value: { version: 1 } } as Row);
        for (const rows of Object.values(data)) rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        return { data, branch, bindings };
    });
    const pack = await sealPackage(data);
    const scopes = bindings.filter(b => !b.detached).map(b => b.scope);
    if (!scopes.length) scopes.push(...bindings.map(b => b.scope));
    const base = { format: 'mnemosyne-archive' as const, version: 1 as const,
        archive: { branch: branch.id, story: branch.story, scopes, label: scopes.map(label).join(' / ') }, pack };
    return { ...base, checksum: await fingerprint(base) };
}

export async function validateArchive(value: unknown): Promise<ArchivePackage> {
    check(archivePackage(value), '请选择单档案核心包；整库核心包请使用整库恢复入口');
    const { checksum, ...base } = value;
    check(Object.keys(value).sort().join() === ['format', 'version', 'archive', 'pack', 'checksum'].sort().join() &&
        value.version === 1 && value.archive && Object.keys(value.archive).sort().join() === ['branch', 'story', 'scopes', 'label'].sort().join() &&
        typeof value.archive.label === 'string' && Array.isArray(value.archive.scopes) && value.archive.scopes.length > 0 &&
        value.archive.scopes.every(s => typeof s === 'string' && !!s), '单档案包格式无效');
    check(await fingerprint(base) === checksum, '单档案包校验和错误');
    await validateCurrentData(value.pack);
    const { checksum: inner, ...inside } = value.pack;
    check(await fingerprint(inside) === inner, '单档案数据校验和错误');
    const branches = value.pack.data.branches as Branch[], target = branches.find(b => b.id === value.archive.branch);
    check(target && !target.archiveSupport && target.story === value.archive.story &&
        branches.every(b => b.id === target.id || b.archiveSupport === 1), '单档案包混入其他聊天档案');
    check(value.pack.data.library_meta.every(r => r.id === SHARED_META), '单档案包不能覆盖全库设置');
    const bindings = value.pack.data.host_bindings as Binding[];
    check(value.archive.scopes.every(scope => bindings.some(b => b.branch === target.id && b.scope === scope)) &&
        bindings.every(b => b.branch === target.id || b.detached === true), '单档案聊天身份不匹配');
    return value;
}

export async function snapshotWithStamp(lib: Library) {
    return lib.transaction(STORES, 'readonly', async tx => {
        const stamp = (await request<any>(tx.native.objectStore(RETENTION_CONTROL_STORE).get('library-writes')))?.stamp ?? 0;
        const data = blank();
        for (const store of STORES) data[store] = await tx.rawAll(store);
        return { data, stamp };
    });
}
export async function assertWriteStamp(tx: Transaction, stamp: number) {
    await tx.assertWriteStamp(stamp);
}

/** Import the target's records and the dependencies it uses in this destination.
 * Following an already present parent ends at its identity. A fork's actual fixed
 * snapshot still arrives through the separate fork.snapshot edge. */
function incomingRecords(archive: ArchivePackage, existingBranches: ReadonlyMap<string, Row>) {
    const target = archive.archive.branch, data = archive.pack.data;
    if (!data.branches.some(b => b.id !== target && existingBranches.has(b.id))) return;
    const bindings = new Set(data.host_bindings.filter(b => b.branch === target).map(b => b.id));
    const records = new Map(STORES.map(store => [store, new Map(data[store].map(row => [row.id, row]))]));
    const expand = payloadReader(data.memory_payloads, data);
    const roots: RecordLink[] = [['branches', target]];
    for (const store of STORES) for (const row of data[store]) {
        if (row.branch === target || store === 'source_bodies' || store === 'library_meta' ||
            ((store === 'message_mappings' || store === 'memories') && bindings.has(row.owner!))) roots.push([store, row.id]);
    }
    return markRecords(roots, (store, id) => records.get(store)!.get(id), (store, row) => {
        if (store === 'branches' && row.id !== target && existingBranches.has(row.id)) return [];
        return [...recordLinks(store, expand(row, store)), ...payloadLinks(store, row)];
    });
}

export interface ArchiveRestoreResult { branch: string; label: string; records: number; compact: boolean }
/** Replace only the named archive in one atomic transaction. Other archives' roots
 * keep their shared data, including a child fork pointing at the target's former head. */
export async function restoreArchive(lib: Library, value: unknown, guard: () => Promise<boolean>,
    expected?: { branch?: string; scope?: string }): Promise<ArchiveRestoreResult> {
    return restoreVerifiedArchive(lib, await validateArchive(value), guard, expected);
}

/** Only for a package that passed validateArchive in this same restore operation. */
export async function restoreVerifiedArchive(lib: Library, archive: ArchivePackage, guard: () => Promise<boolean>,
    expected?: { branch?: string; scope?: string }): Promise<ArchiveRestoreResult> {
    const target = archive.archive.branch;
    check(!expected || (expected.branch ? expected.branch === target
        : !expected.scope || archive.archive.scopes.includes(expected.scope)), '这个备份不属于当前聊天档案，请切换到对应聊天后恢复');
    check(await guard(), '聊天或页面已改变，未恢复档案');
    const before = await snapshotWithStamp(lib), data = before.data;
    const maps = new Map(STORES.map(s => [s, new Map(data[s].map(r => [r.id, r]))]));
    const expand = payloadReader(data.memory_payloads, data);
    const retired = new Map<string, Binding>(((data.library_meta.find(r => r.id === 'retired-source-bindings') as any)?.value.bindings ?? []).map((b: Binding) => [b.id, b]));
    const get = (s: Store, id: string) => {
        const row = maps.get(s)!.get(id) ?? (s === 'host_bindings' ? retired.get(id) : undefined);
        return row && expand(row, s);
    };
    const targetBindings = new Set(data.host_bindings.filter(r => r.branch === target).map(r => r.id));
    const owned = (s: Store, r: Row) => r.branch === target || s === 'branches' && r.id === target ||
        (s === 'memories' || s === 'message_mappings') && targetBindings.has(r.owner!);
    const oldPayloads = new Set<string>(), payloadQueue: RecordLink[] = [];
    for (const store of STORES) for (const row of data[store]) if (owned(store, row)) payloadQueue.push(...payloadLinks(store, row));
    while (payloadQueue.length) {
        const [store, id] = payloadQueue.pop()!;
        if (oldPayloads.has(id)) continue;
        oldPayloads.add(id);
        const row = maps.get(store)!.get(id); check(row, '目标档案的共享内容缺失');
        payloadQueue.push(...payloadLinks(store, row));
    }
    const roots: RecordLink[] = [];
    for (const store of STORES) for (const row of data[store])
        if (!owned(store, row) && (row.branch || store === 'branches' || store === 'memories' || store === 'message_mappings')) roots.push([store, row.id]);
    // Stop at the target branch's identity: a child requires its fixed fork snapshot,
    // not permission to keep/restore the target's newer head and complete history.
    const retained = markRecords(roots, get, (s, r) => s === 'branches' && r.id === target ? []
        : s === 'host_bindings' && retired.has(r.id) ? [['stories', r.story!]] : recordLinks(s, r));
    const merged = blank();
    for (const store of STORES) merged[store] = data[store].filter(r => !owned(store, r) || retained.get(store)?.has(r.id));
    const destination = new Map(STORES.map(s => [s, new Map(merged[s].map(r => [r.id, r]))]));
    let expandIncoming: ReturnType<typeof payloadReader> | undefined;
    const incoming = incomingRecords(archive, maps.get('branches')!);
    for (const store of STORES) for (const row of archive.pack.data[store]) {
        if (incoming && !incoming.get(store)?.has(row.id)) continue;
        const prior = maps.get(store)!.get(row.id), existing = destination.get(store)!.get(row.id);
        // Dependencies are import-only. A real parent or sibling and its host binding
        // always win over a portable dependency shell.
        if (prior && (store === 'stories' || store === 'branches' && row.id !== target ||
            store === 'host_bindings')) {
            destination.get(store)!.set(prior.id, prior); continue;
        }
        if (existing && !(store === 'branches' && row.id === target) && !equal(existing, row)) {
            if (store === 'memory_revisions' && (prefixEncoded(existing) || prefixEncoded(row))) {
                expandIncoming ??= payloadReader(archive.pack.data.memory_payloads, archive.pack.data);
                if (equal(expand(existing, store), expandIncoming(row, store))) continue;
            }
            throw new Error(`共享记录与现有档案冲突，未恢复 ${store}/${row.id}`);
        }
        destination.get(store)!.set(row.id, row);
    }
    // The target must keep its real current binding after a rename. No other chat
    // may be silently rebound to a matching filename or label.
    for (const row of data.host_bindings.filter(r => r.branch === target)) destination.get('host_bindings')!.set(row.id, row);
    for (const store of STORES) merged[store] = [...destination.get(store)!.values()];
    const revisions = destination.get('source_revisions')!, bodies = new Set<string>();
    for (const branch of merged.branches as Branch[]) {
        const snapshot = destination.get('history_snapshots')!.get(branch.head) as Snapshot;
        check(snapshot, '恢复后的当前正文快照缺失');
        for (const key of snapshot.blocks) {
            const block = destination.get('manifest_blocks')!.get(key) as Block; check(block, '恢复后的正文索引缺失');
            for (const ref of block.entries) { check(revisions.has(ref.revision), '恢复后的当前正文缺失'); bodies.add(ref.revision); }
        }
    }
    merged.source_bodies = merged.source_bodies.filter(r => bodies.has(r.id));
    const orphaned = new Set(unreferencedStorage(merged).memory_payloads);
    merged.memory_payloads = merged.memory_payloads.filter(r => !oldPayloads.has(r.id) || !orphaned.has(r.id));
    // Restoring a deleted archive re-enables only that archive's original scopes.
    merged.library_meta = merged.library_meta.map(r => r.id === 'archive-deletions'
        ? { ...r, value: { version: 1, scopes: (r as any).value.scopes.filter((s: string) => !archive.archive.scopes.includes(s)) } } as Row : r);
    // A formerly deleted origin is now a real binding again.
    merged.library_meta = merged.library_meta.map(r => r.id === 'retired-source-bindings'
        ? { ...r, value: { version: 1, bindings: (r as any).value.bindings.filter((b: Binding) => !destination.get('host_bindings')!.has(b.id)) } } as Row : r);
    try {
        await validateCurrentData(packageContents(merged));
    } catch (error) {
        throw new Error(`单档案合并校验失败，当前档案未改动。${error instanceof Error ? error.message : String(error)}`);
    }
    check(await guard(), '聊天或页面已改变，未恢复档案');
    const put: [Store, Row][] = [], remove: RecordLink[] = [];
    for (const store of STORES) {
        const next = new Map(merged[store].map(r => [r.id, r]));
        for (const row of data[store]) if (!next.has(row.id)) remove.push([store, row.id]);
        for (const row of merged[store]) if (!equal(maps.get(store)!.get(row.id), row)) put.push([store, row]);
    }
    const compact = lib.compactWrites;
    const physical = lib.preservePhysicalWrites;
    lib.compactWrites = false; // Persist the exact already-validated physical representation.
    lib.preservePhysicalWrites = true;
    try {
        await lib.transaction(STORES, 'readwrite', async tx => {
            await assertWriteStamp(tx, before.stamp);
            for (const [store, row] of put) await tx.put(store, row);
            await tx.deleteArchiveRows(remove);
        });
        lib.compactWrites = compact || merged.library_meta.some(r => r.id === SHARED_META);
    } catch (error) { lib.compactWrites = compact; throw error; }
    finally { lib.preservePhysicalWrites = physical; }
    return { branch: target, label: archive.archive.label, records: put.length + remove.length, compact: lib.compactWrites };
}
