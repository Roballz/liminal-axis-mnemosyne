import type { Library } from './db';
import { exportLibrary, validateData, type Package } from './migration';
import { STORES, check, equal, type Binding, type Branch, type Row, type Store } from './model';

export interface DeletionMarker extends Row { value: { version: 1; scopes: string[] } }
export const DELETIONS_KEY = 'archive-deletions';
export async function archiveWasDeleted(lib: Library, scope: string) {
    return (await lib.get<DeletionMarker>('library_meta', DELETIONS_KEY))?.value.scopes.includes(scope) ?? false;
}
export async function allowArchiveCreation(lib: Library, scope: string) {
    await lib.transaction(['library_meta'], 'readwrite', async tx => {
        const marker = await tx.get<DeletionMarker>('library_meta', DELETIONS_KEY);
        if (marker) await tx.put('library_meta', { ...marker, value: { version: 1, scopes: marker.value.scopes.filter(s => s !== scope) } } as DeletionMarker);
    });
}
export function archiveLabel(scope: string) {
    try { const [owner, name] = JSON.parse(scope); return `${name} · ${owner}`; } catch { return scope; }
}
export async function archiveDeletionChoices(lib: Library) {
    const [branches, bindings] = await Promise.all([lib.all<Branch>('branches'), lib.all<Binding>('host_bindings')]);
    return branches.map(branch => ({ value: branch.id, label: bindings.filter(b => b.branch === branch.id).map(b => archiveLabel(b.scope)).join(' / ') || branch.id }));
}
export interface ArchiveDeletionPlan {
    before: Package;
    remove: Record<Store, string[]>;
    scopes: string[];
    labels: string[];
    branches: string[];
    events: number;
    summaries: number;
    messages: number;
    tables: number;
}
/** Preview exact records; shared parent history is never silently removed. */
export async function previewArchiveDeletion(lib: Library, branchId: string): Promise<ArchiveDeletionPlan> {
    const before = await exportLibrary(lib), data = before.data;
    const branch = data.branches.find(b => b.id === branchId) as Branch | undefined;
    check(branch, '档案已不存在，请刷新列表');
    const branches = new Set([branch.id]);
    check(!data.branches.some(b => !branches.has(b.id) && branches.has((b as Branch).fork?.branch ?? '')),
        '这个档案仍有子分支依赖，不能删除。请先处理不需要的子分支；不会连带删除其他分支。');
    const bindings = data.host_bindings.filter(b => branches.has(b.branch!)) as Binding[];
    const owners = new Set(bindings.map(b => b.id));
    const removedSnapshots = data.history_snapshots.filter(s => branches.has(s.branch!));
    const blocks = new Set(removedSnapshots.flatMap(s => (s as any).blocks as string[]));
    const retainedBlocks = new Set(data.history_snapshots.filter(s => !branches.has(s.branch!)).flatMap(s => (s as any).blocks as string[]));
    const remove = Object.fromEntries(STORES.map(store => [store, data[store].filter(r =>
        branches.has(r.branch!) || (store === 'branches' && branches.has(r.id)) ||
        ((store === 'message_mappings' || store === 'memories') && owners.has(r.owner!)) ||
        (store === 'manifest_blocks' && blocks.has(r.id) && !retainedBlocks.has(r.id)) ||
        (store === 'source_revisions' && owners.has((r as any).provenance.binding))
    ).map(r => r.id)])) as Record<Store, string[]>;
    const remaining = Object.fromEntries(STORES.map(s => [s, data[s].filter(r => !remove[s].includes(r.id))])) as Package['data'];
    // Only reclaim source identities from this story, after retaining all surviving revisions/mappings.
    const usedMessages = new Set([...remaining.source_revisions.map(r => r.owner!), ...remaining.message_mappings.map(r => (r as any).message)]);
    remove.source_messages = data.source_messages.filter(r => r.story === branch.story && !usedMessages.has(r.id)).map(r => r.id);
    remaining.source_messages = data.source_messages.filter(r => !remove.source_messages.includes(r.id));
    if (!remaining.branches.some(b => b.story === branch.story)) {
        remove.stories = [branch.story];
        remaining.stories = data.stories.filter(s => s.id !== branch.story);
    }
    try {
        validateData({ ...before, data: remaining, counts: Object.fromEntries(STORES.map(s => [s, remaining[s].length])) as Package['counts'] });
    } catch {
        throw new Error('这个档案的数据仍被其他分支引用，暂时不能删除；其他分支保持不变。');
    }
    return { before, remove, scopes: bindings.map(b => b.scope).filter(scope => !remaining.host_bindings.some(b => !(b as Binding).detached && (b as Binding).scope === scope)), labels: bindings.map(b => archiveLabel(b.scope)), branches: [...branches],
        events: remove.event_chains.length, summaries: remove.memory_revisions.length, messages: remove.source_revisions.length, tables: remove.custom_table_defs.length };
}
export async function commitArchiveDeletion(lib: Library, plan: ArchiveDeletionPlan, guard: () => boolean) {
    await lib.transaction(STORES, 'readwrite', async tx => {
        check(guard(), '聊天已改变，请重新预览删除');
        for (const store of STORES) check(equal(await tx.all(store), plan.before.data[store]), '档案已改变，请重新预览删除');
        for (const store of STORES) for (const id of plan.remove[store]) await tx.delete(store, id);
        const marker = await tx.get<DeletionMarker>('library_meta', DELETIONS_KEY);
        await tx.put('library_meta', { id: DELETIONS_KEY, schema: 1,
            value: { version: 1, scopes: [...new Set([...(marker?.value.scopes ?? []), ...plan.scopes])] } } as DeletionMarker);
        check(guard(), '聊天已改变，本次删除已撤销');
    });
}
