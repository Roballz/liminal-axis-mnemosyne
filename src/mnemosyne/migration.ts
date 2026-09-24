import { Library, freshLibraryName, activateLibrary } from './db';
import { STORES, check, fingerprint, type Store, type Row } from './model';
import { validateColumns } from './tables';
export interface Package {
    format: 'mnemosyne-daily';
    version: 1 | 2 | 3 | 4;
    schema: 1;
    created: number;
    excluded: string[];
    counts: Record<Store, number>;
    data: Record<Store, Row[]>;
    checksum: string;
}
const EXCLUDED = ['host-chat-files', 'chat-state-delta', 'knowledge-files-and-vectors', 'vector-indexes', 'api-secrets'];
export async function exportLibrary(lib: Library): Promise<Package> {
    const data = await lib.transaction(STORES, 'readonly', async (tx) => {
        const result = {} as Record<Store, Row[]>;
        for (const store of STORES)
            result[store] = await tx.all(store);
        return result;
    });
    // library_meta is restricted to non-secret daily feature settings, not upstream API configuration.
    const base = { format: 'mnemosyne-daily' as const, version: 4 as const, schema: 1 as const, created: Date.now(),
        excluded: EXCLUDED, counts: Object.fromEntries(STORES.map(s => [s, data[s].length])) as Record<Store, number>, data };
    validateData(base);
    return { ...base, checksum: await fingerprint(base) };
}
const FIELDS: Record<Store, string[]> = {
    stories: ['created'], branches: ['head', 'view', 'epoch', 'fork'], source_messages: [],
    source_revisions: ['role', 'content', 'fingerprint', 'provenance'], history_snapshots: ['previous', 'blocks', 'length', 'created'],
    manifest_blocks: ['entries'], host_bindings: ['scope', 'generation', 'intent'], message_mappings: ['message', 'hostKey'],
    memories: ['hostId'], memory_revisions: ['content', 'fingerprint', 'basis', 'inputRefs', 'coverage', 'dependencies', 'declaration', 'level', 'anchor', 'storyTime', 'recall', 'visibility', 'seed', 'hostId'],
    memory_views: ['selections'], reviews: ['snapshot', 'decision', 'origin', 'created'], event_chains: ['created'],
    event_revisions: ['title', 'status', 'keywords', 'snapshot', 'cutoff', 'epoch', 'created', 'refs'],
    event_memberships: ['memory', 'kind', 'origin', 'locked', 'active', 'epoch', 'snapshot', 'cutoff'],
    event_progress: ['text', 'memories', 'snapshot', 'cutoff', 'operation', 'epoch'],
    event_processing_receipts: ['snapshot', 'cutoff', 'view', 'fingerprint', 'memories', 'result', 'output', 'created'],
    custom_table_defs: ['name', 'description', 'columns', 'ai', 'version', 'created', 'updated', 'deleted'],
    custom_table_rows: ['values', 'version', 'deleted', 'sources'], table_receipts: ['sources', 'snapshot', 'result', 'count', 'fingerprint'],
    library_meta: ['value'],
};
export function validateData(pack: Omit<Package, 'checksum'>) {
    check(pack && pack.format === 'mnemosyne-daily' && [1, 2, 3, 4].includes(pack.version) && pack.schema === 1, '不支持的迁移包版本');
    check(pack.data && Object.keys(pack.data).length === STORES.length, '迁移模块不完整');
    const maps = {} as Record<Store, Map<string, any>>;
    for (const store of STORES) {
        const rows = pack.data[store];
        check(Array.isArray(rows) && rows.length === pack.counts[store], `计数错误 ${store}`);
        maps[store] = new Map();
        for (const r of rows) {
            check(r && r.schema === 1 && typeof r.id === 'string' && r.id && !maps[store].has(r.id), `非法或重复ID ${store}`);
            const optional = pack.version === 1 ? [] : store === 'custom_table_defs' ? ['tableSchema', 'dataVersion'] : store === 'custom_table_rows' ? ['hidden'] : [];
            if (pack.version >= 3) optional.push(...(store === 'event_revisions' ? ['eventSchema', 'overview', 'summarized'] : store === 'custom_table_rows' ? ['bodySources'] : store === 'table_receipts' ? ['backfillSchema', 'bodySources', 'start', 'end'] : []));
            if (pack.version >= 4 && store === 'event_chains') optional.push('archiveSchema', 'archived');
            const fields = ['id', 'schema', 'story', 'branch', 'owner', ...FIELDS[store], ...optional];
            check(Object.keys(r).every(k => fields.includes(k)) && FIELDS[store].every(k => k in r), `字段不合法 ${store}`);
            maps[store].set(r.id, r);
        }
    }
    const get = (store: Store, key: string) => { const r = maps[store].get(key); check(r, `引用缺失 ${store}/${key}`); return r; };
    const ref = (r: any, story?: string) => {
        check(r && Object.keys(r).length === 2, 'SourceRef格式错误');
        const m = get('source_messages', r.message), v = get('source_revisions', r.revision);
        check(v.owner === m.id && v.story === m.story && (!story || m.story === story), '来源跨身份/故事');
    };
    const refs = (snapshot: any): any[] => snapshot.blocks.flatMap((b: string) => get('manifest_blocks', b).entries);
    for (const store of STORES)
        for (const r of maps[store].values()) {
            if (r.story)
                get('stories', r.story);
            if (r.branch) {
                const b = get('branches', r.branch);
                check(!r.story || b.story === r.story, '跨故事分支');
            }
        }
    for (const r of maps.source_revisions.values()) {
        check(['user', 'assistant', 'system'].includes(r.role) && typeof r.content === 'string', '正文结构无效');
        check(get('source_messages', r.owner).story === r.story, '正文身份跨故事');
        get('host_bindings', r.provenance.binding);
    }
    for (const r of maps.manifest_blocks.values()) {
        check(Array.isArray(r.entries) && r.entries.length <= 128, '历史块过大');
        for (const v of r.entries)
            ref(v);
    }
    for (const s of maps.history_snapshots.values()) {
        check(Array.isArray(s.blocks) && Number.isSafeInteger(s.length) && s.length >= 0, '快照结构非法');
        const all = refs(s);
        check(all.length === s.length && new Set(all.map(r => r.message)).size === all.length, '快照计数/消息重复');
        for (const r of all)
            ref(r, s.story);
        if (s.previous)
            check(get('history_snapshots', s.previous).branch === s.branch, '快照前驱跨分支');
        const seen = new Set();
        let cursor = s;
        while (cursor) {
            check(!seen.has(cursor.id), '快照循环');
            seen.add(cursor.id);
            cursor = cursor.previous ? get('history_snapshots', cursor.previous) : null;
        }
    }
    for (const b of maps.branches.values()) {
        check(get('history_snapshots', b.head).branch === b.id && get('memory_views', b.view).branch === b.id, 'Head/视图不属于分支');
        check(Number.isSafeInteger(b.epoch) && b.epoch >= 0, '分支版本非法');
        const reachable = new Set<string>();
        let cursor = get('history_snapshots', b.head);
        while (cursor) {
            reachable.add(cursor.id);
            cursor = cursor.previous ? get('history_snapshots', cursor.previous) : null;
        }
        check([...maps.history_snapshots.values()].filter(s => s.branch === b.id).every(s => reachable.has(s.id)), '未提交孤立快照');
        if (b.fork) {
            const source = get('history_snapshots', b.fork.snapshot);
            check(source.branch === b.fork.branch && source.story === b.story && b.fork.length <= source.length, 'fork范围非法');
            const prefix = refs(source).slice(0, b.fork.length);
            check(JSON.stringify(prefix.at(-1) ?? null) === JSON.stringify(b.fork.anchor), 'fork锚错误');
        }
    }
    for (const binding of maps.host_bindings.values())
        check(get('branches', binding.branch).story === binding.story, '绑定跨故事');
    const scopes = [...maps.host_bindings.values()].map(b => b.scope);
    check(new Set(scopes).size === scopes.length, '重复宿主绑定');
    const mappingKeys = new Set();
    for (const m of maps.message_mappings.values()) {
        check(get('host_bindings', m.owner).story === get('source_messages', m.message).story, '宿主映射跨故事');
        const key = JSON.stringify([m.owner, m.hostKey]);
        check(!mappingKeys.has(key), '映射歧义');
        mappingKeys.add(key);
    }
    for (const m of maps.memories.values())
        check(get('host_bindings', m.owner).story === m.story, '摘要身份跨故事');
    for (const m of maps.memory_revisions.values()) {
        check(get('memories', m.owner).story === m.story && get('history_snapshots', m.basis).story === m.story, '摘要跨故事');
        check(typeof m.content === 'string' && typeof m.recall === 'boolean' && ['public', 'private'].includes(m.visibility), '摘要结构非法');
        const basisRefs = refs(get('history_snapshots', m.basis));
        for (const r of [...m.inputRefs, ...m.coverage]) {
            ref(r, m.story);
            check(basisRefs.some(v => v.message === r.message && v.revision === r.revision), '生成来源不属于基线快照');
        }
        if (m.anchor)
            check(get('source_messages', m.anchor).story === m.story, '摘要锚跨故事');
        for (const dep of m.dependencies)
            check(get('memory_revisions', dep).story === m.story, '摘要依赖跨故事');
        const walk = (key: string, path: Set<string>) => { check(!path.has(key), '摘要依赖循环'); const next = new Set(path).add(key); for (const d of get('memory_revisions', key).dependencies)
            walk(d, next); };
        walk(m.id, new Set());
    }
    for (const v of maps.memory_views.values())
        for (const [family, key] of Object.entries(v.selections)) {
            const m = get('memory_revisions', key as string);
            check(m.owner === family && m.branch === v.branch, '摘要选择错误');
        }
    for (const chain of maps.event_chains.values()) {
        check(chain.story === get('branches', chain.branch).story, '事件链跨故事');
        if (chain.archiveSchema !== undefined || chain.archived !== undefined)
            check(chain.archiveSchema === 1 && typeof chain.archived === 'boolean', '事件归档标记非法');
    }
    const memoryRefs = (r: any, ids: string[]) => { check(Array.isArray(ids), '摘要引用列表缺失'); for (const key of ids)
        check(get('memory_revisions', key).branch === r.branch, '摘要引用跨分支'); };
    for (const store of ['event_revisions', 'event_memberships', 'event_progress'] as Store[])
        for (const r of maps[store].values()) {
            const chain = get('event_chains', r.owner);
            check(chain.branch === r.branch, '事件跨分支');
            const snapshot = get('history_snapshots', r.snapshot);
            check(snapshot.branch === r.branch && Number.isSafeInteger(r.cutoff) && r.cutoff >= 0 && r.cutoff <= snapshot.length, '事件范围非法');
            check(Number.isSafeInteger(r.epoch) && r.epoch > 0 && r.epoch <= get('branches', r.branch).epoch, '事件版本无效');
            if (store === 'event_revisions')
                check(typeof r.title === 'string' && typeof r.status === 'string' && Array.isArray(r.keywords), '事件元信息非法');
            if (store === 'event_memberships')
                check(['progress', 'reference'].includes(r.kind) && ['ai', 'manual'].includes(r.origin) && typeof r.active === 'boolean' && typeof r.locked === 'boolean', '关联字段非法');
            if (store === 'event_progress')
                check(typeof r.text === 'string' && r.text.trim(), '追加概述缺失');
            if (store === 'event_revisions' && r.eventSchema !== undefined) {
                check(r.eventSchema === 2 && typeof r.overview === 'string' && Array.isArray(r.summarized), '事件概要版本非法');
                memoryRefs(r, r.summarized);
            }
            memoryRefs(r, store === 'event_memberships' ? [r.memory] : store === 'event_progress' ? r.memories : r.refs);
        }
    for (const r of maps.reviews.values()) {
        memoryRefs(r, [r.owner]);
        check(get('history_snapshots', r.snapshot).branch === r.branch, '审核跨分支');
    }
    for (const r of maps.event_processing_receipts.values()) {
        memoryRefs(r, r.memories);
        check(get('history_snapshots', r.snapshot).branch === r.branch && get('memory_views', r.view).branch === r.branch, '回执范围错误');
        check(['success', 'needs_review'].includes(r.result), '回执状态非法');
    }
    for (const d of maps.custom_table_defs.values()) {
        validateColumns(d.columns);
        if (pack.version === 1) check(d.columns.every((c: any) => c.prompt === undefined && c.mode !== 'lock'), 'v1 包不允许 v2 字段策略');
        check(d.tableSchema === undefined || d.tableSchema === 2, '表定义版本错误');
        check(d.dataVersion === undefined || (Number.isSafeInteger(d.dataVersion) && d.dataVersion >= 0), '表数据版本错误');
    }
    for (const r of maps.custom_table_rows.values()) {
        check(get('custom_table_defs', r.owner).branch === r.branch, '表行跨范围');
        check(r.hidden === undefined || typeof r.hidden === 'boolean', '隐藏行标记错误');
        memoryRefs(r, r.sources);
        if (r.bodySources !== undefined) { check(Array.isArray(r.bodySources), '表格正文来源非法'); for (const source of r.bodySources) ref(source, r.story); }
    }
    for (const r of maps.table_receipts.values()) {
        check(get('custom_table_defs', r.owner).branch === r.branch, '表回执跨范围');
        memoryRefs(r, r.sources);
        const snapshot = get('history_snapshots', r.snapshot);
        check(snapshot.branch === r.branch, '补表回执跨分支');
        if (r.backfillSchema !== undefined || r.bodySources !== undefined) {
            check(r.backfillSchema === 1 && Array.isArray(r.bodySources) && Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end >= r.start && r.end < snapshot.length, '补表回执范围非法');
            check(JSON.stringify(r.bodySources) === JSON.stringify(refs(snapshot).slice(r.start, r.end + 1)), '补表回执正文不匹配');
        }
    }
    for (const r of maps.library_meta.values()) {
        check(r.id === 'daily-settings' && r.value && typeof r.value === 'object', '不允许导出任意设置或密钥');
        const keys = ['eventsEnabled', 'interval', 'delay', 'batchSize', 'maxChars', 'chains', 'excerptChars', 'totalChars', 'extra'];
        check(Object.keys(r.value).every(k => keys.includes(k)) && Object.values(r.value).every(v => typeof v === 'number' || typeof v === 'boolean'), '设置白名单拒绝');
    }
}
export async function restoreLibrary(value: unknown, activate = true): Promise<Library> {
    const pack = value as Package;
    validateData(pack);
    const { checksum, ...base } = pack;
    check(typeof checksum === 'string' && await fingerprint(base) === checksum, '迁移包校验和错误');
    const lib = await Library.open(freshLibraryName());
    try {
        await lib.transaction(STORES, 'readwrite', async (tx) => {
            for (const store of STORES)
                for (const record of pack.data[store])
                    await tx.add(store, record);
        });
        // Verify the persisted round-trip before changing the active selector.
        const restored = await exportLibrary(lib);
        check(await fingerprint(restored.data) === await fingerprint(pack.data), '恢复后对象不一致');
        if (activate)
            await activateLibrary(lib);
        return lib;
    }
    catch (error) {
        lib.close();
        throw error;
    } // no overwrite or automatic purge
}
