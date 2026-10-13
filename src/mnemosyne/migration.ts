import { EVENT_PROGRESS_MAX_CHARS } from '@/memory/limits';
import { validTags } from '@/memory/contextTags';
import { isRoleOnlyPair } from './source-equivalence';
import { Library, freshLibraryName, activateLibrary } from './db';
import { STORES, check, fingerprint, type Store, type Row } from './model';
import { validateColumns } from './tables';
export interface Package {
    format: 'mnemosyne-daily';
    version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
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
    // library_meta allows only non-secret daily settings and versioned deletion/source-origin receipts.
    const base = { format: 'mnemosyne-daily' as const, version: 12 as const, schema: 1 as const, created: Date.now(),
        excluded: EXCLUDED, counts: Object.fromEntries(STORES.map(s => [s, data[s].length])) as Record<Store, number>, data };
    await validateCurrentData(base);
    return { ...base, checksum: await fingerprint(base) };
}
const FIELDS: Record<Store, string[]> = {
    stories: ['created'], branches: ['head', 'view', 'epoch', 'fork'], source_messages: [],
    source_bodies: ['content'],
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
    table_history: ['previous', 'parent', 'snapshot', 'cutoff', 'sequence', 'depth', 'kind', 'operation', 'checkpoint', 'gap', 'defs', 'rows'],
    library_meta: ['value'],
};
export function validateData(pack: Omit<Package, 'checksum'>) {
    validateStructure(pack);
}
export async function validateCurrentData(pack: Omit<Package, 'checksum'>): Promise<void> {
    validateStructure(pack, await validateBodyHashes(pack));
}
function validateStructure(pack: Omit<Package, 'checksum'>, legacyDigests: ReadonlyMap<string, string> = new Map()) {
    check(pack && pack.format === 'mnemosyne-daily' && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(pack.version) && pack.schema === 1, '不支持的迁移包版本');
    const stores: readonly Store[] = STORES.filter(s => !(s === 'table_history' && pack.version < 11) && !(s === 'source_bodies' && pack.version < 12));
    check(pack.data && Object.keys(pack.data).length === stores.length && Object.keys(pack.data).every(s => stores.includes(s as Store)), '迁移模块不完整');
    const maps = {} as Record<Store, Map<string, any>>;
    for (const store of STORES) {
        const omitted = !stores.includes(store);
        const rows = omitted ? [] : pack.data[store];
        check(Array.isArray(rows) && (omitted || rows.length === pack.counts[store]), `计数错误 ${store}`);
        maps[store] = new Map();
        for (const r of rows) {
            check(r && r.schema === 1 && typeof r.id === 'string' && r.id && !maps[store].has(r.id), `非法或重复ID ${store}`);
            const optional = pack.version === 1 ? [] : store === 'custom_table_defs' ? ['tableSchema', 'dataVersion'] : store === 'custom_table_rows' ? ['hidden'] : [];
            if (pack.version >= 3) optional.push(...(store === 'event_revisions' ? ['eventSchema', 'overview', 'summarized'] : store === 'custom_table_rows' ? ['bodySources'] : store === 'table_receipts' ? ['backfillSchema', 'bodySources', 'start', 'end'] : []));
            if (pack.version >= 4 && store === 'event_chains') optional.push('archiveSchema', 'archived');
            if (pack.version >= 5 && store === 'host_bindings') optional.push('rebindSchema', 'detached');
            if (pack.version >= 5 && store === 'branches') optional.push('sourceRoleRepairSchema', 'sourceRoleRepairs');
            if (pack.version >= 6 && store === 'reviews') optional.push('reviewSchema', 'sourceRefs', 'coverage', 'dependencies');
            if (pack.version >= 7 && store === 'memory_revisions') optional.push('tags');
            if (pack.version >= 7 && store === 'event_revisions') optional.push('latestProgress');
            if (pack.version >= 10 && store === 'event_chains') optional.push('inheritance');
            if (pack.version >= 11 && store === 'branches') optional.push('tableHead', 'tableHistoryGap');
            if (pack.version >= 11 && store === 'history_snapshots') optional.push('variants');
            if (pack.version >= 12) optional.push(...(store === 'source_revisions' ? ['bodySchema', 'bodyHash', 'bodyLength'] : store === 'history_snapshots' ? ['snapshotSchema'] : store === 'manifest_blocks' ? ['variants'] : store === 'branches' ? ['legacyHead'] : []));
            const required = store === 'source_revisions' && (r as any).bodySchema === 1 && pack.version >= 12 ? FIELDS[store].filter(k => k !== 'content') : FIELDS[store];
            const fields = ['id', 'schema', 'story', 'branch', 'owner', ...FIELDS[store], ...optional];
            check(Object.keys(r).every(k => fields.includes(k)) && required.every(k => k in r), `字段不合法 ${store}`);
            maps[store].set(r.id, r);
        }
    }
    const get = (store: Store, key: string) => { const r = maps[store].get(key); check(r, `引用缺失 ${store}/${key}`); return r; };
    const ref = (r: any, story?: string) => {
        check(r && Object.keys(r).length === 2, 'SourceRef格式错误');
        const m = get('source_messages', r.message), v = get('source_revisions', r.revision);
        check(v.owner === m.id && v.story === m.story && (!story || m.story === story), '来源跨身份/故事');
    };
    const roleRevision = (id: string) => {
        const revision = get('source_revisions', id);
        const body = maps.source_bodies.get(id);
        if (body) return { ...revision, content: body.content };
        const digest = legacyDigests.get(id);
        return digest ? { ...revision, bodySchema: 1, bodyHash: digest, bodyLength: revision.content.length } : revision;
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
    const retiredBindings = new Map<string, any>();
    const originRecord = maps.library_meta.get('retired-source-bindings');
    if (originRecord) {
        check(pack.version >= 9 && originRecord.value?.version === 1 && Object.keys(originRecord.value).length === 2 &&
            Array.isArray(originRecord.value.bindings), '历史来源绑定格式非法');
        for (const b of originRecord.value.bindings) {
            check(b && b.schema === 1 && typeof b.id === 'string' && b.id && typeof b.branch === 'string' && b.branch &&
                typeof b.story === 'string' && typeof b.scope === 'string' && b.scope && Number.isSafeInteger(b.generation) && b.generation > 0 &&
                ['new_story', 'fork', 'carryover', 'confirmed_mapping'].includes(b.intent) &&
                Object.keys(b).every(k => ['id','schema','story','branch','scope','generation','intent','rebindSchema','detached'].includes(k)) &&
                (b.rebindSchema === undefined && b.detached === undefined || b.rebindSchema === 1 && typeof b.detached === 'boolean') &&
                !retiredBindings.has(b.id) && !maps.host_bindings.has(b.id) && !maps.branches.has(b.branch), '历史来源绑定非法或与活动档案冲突');
            get('stories', b.story);
            check([...maps.source_revisions.values()].some(r => r.provenance.binding === b.id), '历史来源绑定没有引用');
            retiredBindings.set(b.id, b);
        }
    }
    for (const r of maps.source_revisions.values()) {
        check(['user', 'assistant', 'system'].includes(r.role), '正文结构无效');
        if (r.bodySchema !== undefined || r.bodyHash !== undefined || r.bodyLength !== undefined) {
            check(r.bodySchema === 1 && !('content' in r) && typeof r.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(r.fingerprint) && typeof r.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(r.bodyHash) && Number.isSafeInteger(r.bodyLength) && r.bodyLength >= 0, '正文描述符非法');
        } else check(typeof r.content === 'string', '正文结构无效');
        check(get('source_messages', r.owner).story === r.story, '正文身份跨故事');
        const origin = maps.host_bindings.get(r.provenance.binding) ?? retiredBindings.get(r.provenance.binding);
        check(origin && origin.story === r.story, '正文来源绑定缺失或跨故事');
    }
    const currentBodies = new Set<string>();
    for (const branch of maps.branches.values()) for (const source of refs(get('history_snapshots', branch.head))) currentBodies.add(source.revision);
    for (const body of maps.source_bodies.values()) {
        check(currentBodies.has(body.id), '非当前正文载荷不得保留');
        const revision = get('source_revisions', body.id);
        check(Object.keys(body).every(k => ['id', 'schema', 'story', 'owner', 'content'].includes(k)) && revision.bodySchema === 1 && body.owner === revision.owner && body.story === revision.story && typeof body.content === 'string' && body.content.length === revision.bodyLength, '正文载荷非法');
    }
    for (const r of maps.manifest_blocks.values()) {
        check(Array.isArray(r.entries) && r.entries.length <= 128, '历史块过大');
        check(r.variants === undefined || Array.isArray(r.variants) && r.variants.length === r.entries.length && r.variants.every((v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0), '块变体标记非法');
        for (const v of r.entries)
            ref(v);
    }
    for (const s of maps.history_snapshots.values()) {
        check(Array.isArray(s.blocks) && Number.isSafeInteger(s.length) && s.length >= 0, '快照结构非法');
        check(s.variants === undefined || Array.isArray(s.variants) && s.variants.length === s.length && s.variants.every((v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0), '宿主变体标记非法');
        check(s.snapshotSchema === undefined || s.snapshotSchema === 2 && s.owner === `current:${s.branch}` && s.previous === null && s.variants === undefined, '当前快照结构非法');
        if (s.snapshotSchema === 2) {
            check(typeof s.branch === 'string' && get('branches', s.branch).story === s.story, '当前快照分支非法');
            for (const id of s.blocks) {
                const block = get('manifest_blocks', id);
                check(block.owner === s.owner && block.story === s.story, '当前快照块归属非法');
            }
        }
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
        const head = get('history_snapshots', b.head);
        for (const source of refs(head)) {
            const revision = get('source_revisions', source.revision);
            check(revision.bodySchema !== 1 || maps.source_bodies.has(revision.id), '当前正文载荷缺失');
        }
        const roots = [head];
        if (b.legacyHead !== undefined) {
            const legacy = get('history_snapshots', b.legacyHead);
            check(legacy.branch === b.id && legacy.snapshotSchema === undefined, '旧历史基线非法');
            roots.push(legacy);
        }
        const pin = (id: string) => { const s = get('history_snapshots', id); if (s.branch === b.id && s.snapshotSchema === 2) roots.push(s); };
        for (const snapshot of maps.history_snapshots.values()) if (snapshot.branch === b.id && snapshot.snapshotSchema === 2 && b.sourceRoleRepairs?.some((pair: any) => refs(snapshot).some(r => r.revision === pair.before.revision || r.revision === pair.after.revision))) roots.push(snapshot);
        for (const branch of maps.branches.values()) if (branch.fork) pin(branch.fork.snapshot);
        for (const memory of maps.memory_revisions.values()) pin(memory.basis);
        for (const store of ['reviews', 'event_revisions', 'event_memberships', 'event_progress', 'event_processing_receipts', 'table_receipts', 'table_history'] as Store[])
            for (const record of maps[store].values()) pin(record.snapshot);
        for (const root of roots) {
            let cursor = root;
            while (cursor && !reachable.has(cursor.id)) {
                reachable.add(cursor.id);
                cursor = cursor.previous ? get('history_snapshots', cursor.previous) : null;
            }
        }
        check([...maps.history_snapshots.values()].filter(s => s.branch === b.id).every(s => reachable.has(s.id)), '未提交孤立快照');
        if (b.sourceRoleRepairSchema !== undefined || b.sourceRoleRepairs !== undefined) {
            check(b.sourceRoleRepairSchema === 1 && Array.isArray(b.sourceRoleRepairs), '来源角色修复格式非法');
            const historical = new Set([...maps.history_snapshots.values()].filter(s => s.branch === b.id).flatMap(s => refs(s).map(r => r.revision)));
            const pairs = new Set<string>();
            for (const pair of b.sourceRoleRepairs) {
                check(pair && Object.keys(pair).length === 3 && Number.isSafeInteger(pair.confirmedAt) && pair.confirmedAt >= 0, '来源角色修复回执非法');
                ref(pair.before, b.story); ref(pair.after, b.story);
                const key = JSON.stringify([pair.before, pair.after]);
                check(!pairs.has(key) && historical.has(pair.before.revision) && historical.has(pair.after.revision) &&
                    isRoleOnlyPair(roleRevision(pair.before.revision), roleRevision(pair.after.revision)), '来源角色修复跨身份、正文或分支');
                pairs.add(key);
            }
        }
        if (b.fork) {
            const source = get('history_snapshots', b.fork.snapshot);
            check(source.branch === b.fork.branch && source.story === b.story && b.fork.length <= source.length, 'fork范围非法');
            const prefix = refs(source).slice(0, b.fork.length);
            check(JSON.stringify(prefix.at(-1) ?? null) === JSON.stringify(b.fork.anchor), 'fork锚错误');
        }
    }
    for (const binding of maps.host_bindings.values()) {
        check(get('branches', binding.branch).story === binding.story, '绑定跨故事');
        if (binding.rebindSchema !== undefined || binding.detached !== undefined)
            check(binding.rebindSchema === 1 && typeof binding.detached === 'boolean', '重新绑定字段非法');
    }
    const scopes = [...maps.host_bindings.values()].filter(b => !b.detached).map(b => b.scope);
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
        if (m.tags !== undefined) {
            check(validTags(m.tags), '摘要标签版本或字段非法');
        }
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
        if (chain.inheritance !== undefined) {
            const receipt = chain.inheritance, branch = get('branches', chain.branch);
            check(receipt && receipt.version === 1 && Object.keys(receipt).length === 6 &&
                receipt.branch === branch.fork?.branch && typeof receipt.event === 'string' && receipt.event &&
                Number.isSafeInteger(receipt.epoch) && receipt.epoch > 0 && receipt.epoch <= branch.epoch &&
                typeof receipt.archived === 'boolean' && typeof receipt.key === 'string' && /^[a-f0-9]{64}$/.test(receipt.key), '事件继承凭据非法');
        }
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
            if (store === 'event_revisions' && r.latestProgress != null) {
                const p = r.latestProgress;
                check(p.version === 1 && typeof p.text === 'string' && Array.from(p.text).length <= EVENT_PROGRESS_MAX_CHARS && typeof p.time === 'string' && typeof p.memory === 'string', '最新进展格式非法');
                check(get('memory_revisions', p.memory).branch === r.branch, '最新进展来源跨分支');
            }
            if (store === 'event_revisions' && r.eventSchema !== undefined) {
                check(r.eventSchema === 2 && typeof r.overview === 'string' && Array.isArray(r.summarized), '事件概要版本非法');
                memoryRefs(r, r.summarized);
            }
            memoryRefs(r, store === 'event_memberships' ? [r.memory] : store === 'event_progress' ? r.memories : r.refs);
        }
    for (const r of maps.reviews.values()) {
        memoryRefs(r, [r.owner]);
        const snapshot = get('history_snapshots', r.snapshot);
        check(snapshot.branch === r.branch, '审核跨分支');
        check(r.decision === 'compatible' && ['manual', 'generated_sidecar'].includes(r.origin) && Number.isSafeInteger(r.created), '审核结构非法');
        if (['reviewSchema','sourceRefs','coverage','dependencies'].some(k => k in r)) {
            check(r.reviewSchema === 2 && Array.isArray(r.sourceRefs) && Array.isArray(r.coverage) && Array.isArray(r.dependencies), '审核版本非法');
            const memory = get('memory_revisions', r.owner), currentRefs = refs(snapshot);
            const dependencyOnly = memory.level > 0 && !memory.anchor && !memory.inputRefs.length && memory.dependencies.length;
            const basis = refs(get('history_snapshots', memory.basis));
            const original = memory.inputRefs.length ? memory.inputRefs : dependencyOnly ? [] : memory.anchor ? basis.slice(0, basis.findIndex(v => v.message === memory.anchor) + 1) : basis;
            const validateSources = (approved: any[], expected: any[]) => {
                check(JSON.stringify(approved.map(v => v.message)) === JSON.stringify(expected.map(v => v.message)), '审核来源身份不匹配');
                let last = -1;
                for (const v of approved) {
                    ref(v, r.story);
                    const pos = currentRefs.findIndex(c => c.message === v.message && c.revision === v.revision);
                    check(pos > last, '审核来源顺序或版本不匹配'); last = pos;
                }
            };
            validateSources(r.sourceRefs, original);
            validateSources(r.coverage, memory.coverage);
            if (!memory.inputRefs.length && !dependencyOnly) check(JSON.stringify(r.sourceRefs) === JSON.stringify(currentRefs.slice(0, r.sourceRefs.length)), '审核前缀不匹配');
            if (r.coverage.length) {
                const first = currentRefs.findIndex(v => v.message === r.coverage[0].message);
                check(JSON.stringify(r.coverage) === JSON.stringify(currentRefs.slice(first, first + r.coverage.length)), '审核覆盖不连续');
            }
            memoryRefs(r, r.dependencies);
            check(!r.dependencies.includes(r.owner) && r.dependencies.length === memory.dependencies.length && r.dependencies.every((id: string, i: number) =>
                get('memory_revisions', id).owner === get('memory_revisions', memory.dependencies[i]).owner), '审核依赖身份不匹配');
        }
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
    for (const c of maps.table_history.values()) {
        const snapshot = get('history_snapshots', c.snapshot);
        check(snapshot.branch === c.branch && snapshot.story === c.story && Number.isSafeInteger(c.cutoff) && c.cutoff >= 0 && c.cutoff <= snapshot.length, '表格历史范围非法');
        check(Number.isSafeInteger(c.sequence) && c.sequence > 0 && ['baseline', 'write', 'restore', 'inherit'].includes(c.kind) && typeof c.operation === 'string' && typeof c.checkpoint === 'boolean' && typeof c.gap === 'boolean', '表格历史结构非法');
        check(Array.isArray(c.defs) && Array.isArray(c.rows) && new Set(c.defs.map((d: any) => d.id)).size === c.defs.length && new Set(c.rows.map((r: any) => r.id)).size === c.rows.length, '表格历史对象重复');
        for (const key of ['previous', 'parent']) {
            check(c[key] === null || typeof c[key] === 'string', '表格历史前驱非法');
            if (c[key]) { const prior = get('table_history', c[key]); check(prior.branch === c.branch && prior.sequence < c.sequence, '表格历史循环或跨分支'); }
        }
        check(c.parent !== null || c.checkpoint, '表格历史缺少基线');
        check(Number.isSafeInteger(c.depth) && c.depth >= 0 && c.depth <= 64 && (c.checkpoint ? c.depth === 0 : c.parent && c.depth === get('table_history', c.parent).depth + 1), '表格检查点距离非法');
        for (const d of c.defs) {
            const fields = ['id', 'schema', 'story', 'branch', 'owner', ...FIELDS.custom_table_defs, 'tableSchema', 'dataVersion'];
            check(d && d.schema === 1 && d.branch === c.branch && d.story === c.story && typeof d.id === 'string' && Object.keys(d).every(k => fields.includes(k)) && FIELDS.custom_table_defs.every(k => k in d), '历史表定义非法');
            check(get('custom_table_defs', d.id).branch === c.branch, '历史表身份跨分支');
            validateColumns(d.columns);
            check(typeof d.name === 'string' && !!d.name.trim() && typeof d.description === 'string' && typeof d.ai === 'boolean' && typeof d.deleted === 'boolean' && Number.isSafeInteger(d.version) && d.version >= 0 && (d.dataVersion === undefined || Number.isSafeInteger(d.dataVersion) && d.dataVersion >= 0), '历史表字段非法');
        }
        for (const r of c.rows) {
            const fields = ['id', 'schema', 'story', 'branch', 'owner', ...FIELDS.custom_table_rows, 'hidden', 'bodySources'];
            check(r && r.schema === 1 && r.branch === c.branch && r.story === c.story && typeof r.id === 'string' && Object.keys(r).every(k => fields.includes(k)) && FIELDS.custom_table_rows.every(k => k in r), '历史表行非法');
            check(get('custom_table_defs', r.owner).branch === c.branch && get('custom_table_rows', r.id).owner === r.owner, '历史表行身份跨范围');
            check(r.values && typeof r.values === 'object' && !Array.isArray(r.values) && Object.values(r.values).every(v => ['string', 'number', 'boolean'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v))) && typeof r.deleted === 'boolean' && (r.hidden === undefined || typeof r.hidden === 'boolean') && Number.isSafeInteger(r.version) && r.version >= 0, '历史表单元格非法');
            memoryRefs(r, r.sources);
            if (r.bodySources !== undefined) { check(Array.isArray(r.bodySources), '历史表正文引用非法'); for (const source of r.bodySources) ref(source, r.story); }
        }
    }
    for (const b of maps.branches.values()) {
        check(b.tableHistoryGap === undefined || typeof b.tableHistoryGap === 'boolean', '表格历史缺口标记非法');
        const history = [...maps.table_history.values()].filter(c => c.branch === b.id);
        if (!b.tableHead) { check(!history.length && b.tableHistoryGap === undefined, '表格历史缺少采用版本'); continue; }
        const head = get('table_history', b.tableHead);
        check(head.branch === b.id && head.gap === b.tableHistoryGap, '表格采用版本跨分支或缺口不一致');
        const reachable = new Set<string>();
        let cursor = head;
        while (cursor) { reachable.add(cursor.id); cursor = cursor.previous ? get('table_history', cursor.previous) : null; }
        check(history.every(c => reachable.has(c.id)), '未提交孤立表格历史');
        const stateDefs = new Map<string, any>(), stateRows = new Map<string, any>(), chain = [];
        cursor = head;
        while (cursor) { chain.push(cursor); if (cursor.checkpoint) break; cursor = cursor.parent ? get('table_history', cursor.parent) : null; }
        for (const commit of chain.reverse()) {
            for (const def of commit.defs) stateDefs.set(def.id, def);
            for (const record of commit.rows) stateRows.set(record.id, record);
        }
        const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
        const semantic = (value: any, definition: boolean) => stable(Object.fromEntries(Object.entries(value)
            .filter(([key]) => !['version', ...(definition ? ['dataVersion', 'updated'] : [])].includes(key))));
        for (const [store, state, definition] of [['custom_table_defs', stateDefs, true], ['custom_table_rows', stateRows, false]] as const) {
            for (const [id, expected] of state) {
                const actual = get(store, id);
                check(JSON.stringify(semantic(actual, definition)) === JSON.stringify(semantic(expected, definition)), '表格当前值与采用历史不一致');
            }
            for (const actual of maps[store].values()) if (actual.branch === b.id && !state.has(actual.id)) check(actual.deleted === true, '未版本化的当前表值');
        }
    }
    for (const r of maps.library_meta.values()) {
        if (r.id === 'retired-source-bindings' && pack.version >= 9) continue;
        if (pack.version >= 8 && r.id === 'archive-deletions') {
            check(r.value?.version === 1 && Object.keys(r.value).length === 2 && Array.isArray(r.value.scopes) &&
                r.value.scopes.every((s: unknown) => typeof s === 'string' && s.length > 0) &&
                new Set(r.value.scopes).size === r.value.scopes.length, '删除记录格式非法');
            continue;
        }
        check(r.id === 'daily-settings' && r.value && typeof r.value === 'object', '不允许导出任意设置或密钥');
        const keys = ['eventsEnabled', 'interval', 'delay', 'batchSize', 'maxChars', 'chains', 'excerptChars', 'totalChars', 'extra'];
        if (pack.version >= 6) keys.push('backfillBatchSize');
        if (r.value.backfillBatchSize !== undefined) check(Number.isSafeInteger(r.value.backfillBatchSize) && r.value.backfillBatchSize > 0, '补表批量必须为正整数');
        check(Object.keys(r.value).every(k => keys.includes(k)) && Object.values(r.value).every(v => typeof v === 'number' || typeof v === 'boolean'), '设置白名单拒绝');
    }
}
export async function restoreLibrary(value: unknown, activate = true): Promise<Library> {
    const pack = value as Package;
    await validateCurrentData(pack);
    const { checksum, ...base } = pack;
    check(typeof checksum === 'string' && await fingerprint(base) === checksum, '迁移包校验和错误');
    const lib = await Library.open(freshLibraryName());
    try {
        await lib.transaction(STORES, 'readwrite', async (tx) => {
            for (const store of STORES)
                for (const record of pack.data[store] ?? [])
                    await tx.add(store, record);
        });
        // Verify the persisted round-trip before changing the active selector.
        const restored = await exportLibrary(lib);
        check(await fingerprint(restored.data) === await fingerprint(Object.fromEntries(STORES.map(store => [store, pack.data[store] ?? []]))), '恢复后对象不一致');
        if (activate)
            await activateLibrary(lib);
        return lib;
    }
    catch (error) {
        lib.close();
        throw error;
    } // no overwrite or automatic purge
}

/** Hashes are checked outside IDB before restore writes or returning an export. */
async function validateBodyHashes(pack: Omit<Package, 'checksum'>): Promise<Map<string, string>> {
    check(pack?.data && Array.isArray(pack.data.source_revisions) && Array.isArray(pack.data.branches), '迁移模块不完整');
    const revisions = new Map(pack.data.source_revisions.map(r => [r.id, r as any]));
    check(pack.data.source_bodies === undefined || Array.isArray(pack.data.source_bodies), '正文载荷非法');
    for (const body of pack.data.source_bodies ?? []) {
        const revision = revisions.get(body.id);
        check(revision, `引用缺失 source_revisions/${body.id}`);
        check(typeof (body as any).content === 'string', '正文载荷非法');
        check(await fingerprint((body as any).content) === revision.bodyHash, '正文载荷摘要不匹配');
        check(await fingerprint([revision.role, (body as any).content]) === revision.fingerprint, '正文角色摘要不匹配');
    }
    // Legacy text is never rewritten. Only role-repair endpoints need transient digests.
    const legacyDigests = new Map<string, string>();
    for (const branch of pack.data.branches as any[]) {
        if (!Array.isArray(branch.sourceRoleRepairs)) continue;
        for (const pair of branch.sourceRoleRepairs) for (const endpoint of [pair?.before, pair?.after]) {
            const revision = revisions.get(endpoint?.revision);
            if (revision?.bodySchema === undefined && typeof revision?.content === 'string' && !legacyDigests.has(revision.id))
                legacyDigests.set(revision.id, await fingerprint(revision.content));
        }
    }
    return legacyDigests;
}
