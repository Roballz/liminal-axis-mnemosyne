import type { Library } from './db';
import { snapshotRefs, type HostMessage } from './canonical';
import { STORES, check, equal, type Binding, type Branch, type Mapping, type MemoryView, type Revision, type Snapshot } from './model';

export interface ReconnectPlan {
    scope: string;
    binding: Binding;
    branch: Branch;
    displaced?: { binding: Binding; branch: Branch };
    messages: number;
    summaries: number;
    events: number;
    tables: number;
    displacedEvents: number;
}
/** Read-only preview. A rename is a human declaration; copied content never implies inheritance. */
export async function previewReconnect(lib: Library, branchId: string, scope: string, messages: HostMessage[]): Promise<ReconnectPlan> {
    return lib.transaction(STORES, 'readonly', async tx => {
        const bindings = await tx.all<Binding>('host_bindings');
        const sources = bindings.filter(b => b.branch === branchId);
        check(sources.length === 1, '原档案绑定缺失或有歧义，不能直接接回');
        const binding = sources[0];
        const owner = (value: string) => { try { const p = JSON.parse(value); return Array.isArray(p) && p.length === 2 ? p[0] : null; } catch { return null; } };
        check(owner(scope) && owner(scope) === owner(binding.scope), '不能接回其他角色或群组的档案');
        const branch = await tx.get<Branch>('branches', branchId);
        check(branch, '原分支不存在');
        const snapshot = await tx.get<Snapshot>('history_snapshots', branch.head);
        check(snapshot, '原档案快照缺失');
        const refs = await snapshotRefs(tx, snapshot);
        check(refs.length > 0 && refs.length <= messages.length, '当前聊天比原档案短或原档案为空，不能作为改名接回');
        check(new Set(messages.map(m => m.key)).size === messages.length && messages.every(m => m.key), '当前聊天缺少唯一消息身份，不能只按文字接回');
        const mappings = new Map((await tx.all<Mapping>('message_mappings', 'owner', binding.id)).map(m => [m.hostKey, m.message]));
        const revisions = await Promise.all(refs.map(ref => tx.get<Revision>('source_revisions', ref.revision)));
        for (let i = 0; i < refs.length; i++) {
            const identityMatches = mappings.get(messages[i].key) === refs[i].message;
            const bodyMatches = revisions[i]?.content === messages[i].content;
            const difference = [!identityMatches && '消息身份不同或缺失', !bodyMatches && '正文不同'].filter(Boolean).join('、');
            check(identityMatches && bodyMatches,
                `#${i} 消息身份或正文与原档案不一致：${difference}；前 ${i} 条已匹配，未接回；不能凭相同楼数猜测`);
        }
        const active = bindings.find(b => !b.detached && b.scope === scope);
        check(active?.id !== binding.id, '当前聊天已经连接这个档案');
        const displacedBranch = active ? await tx.get<Branch>('branches', active.branch) : undefined;
        check(!active || displacedBranch, '当前绑定分支缺失');
        const selection = await tx.get<MemoryView>('memory_views', branch.view);
        check(selection, '原档案摘要视图缺失');
        return { scope, binding, branch, messages: refs.length,
            summaries: Object.keys(selection.selections).length,
            events: (await tx.all('event_chains', 'branch', branchId)).length,
            tables: (await tx.all('custom_table_defs', 'branch', branchId)).length,
            displaced: active && displacedBranch ? { binding: active, branch: displacedBranch } : undefined,
            displacedEvents: active ? (await tx.all('event_chains', 'branch', active.branch)).length : 0 };
    });
}
/** Only binding ownership changes; both archives and every original record remain intact. */
export async function commitReconnect(lib: Library, plan: ReconnectPlan, guard: () => boolean) {
    await lib.transaction(['host_bindings', 'branches'], 'readwrite', async tx => {
        const bindings = await tx.all<Binding>('host_bindings');
        const source = bindings.find(b => b.id === plan.binding.id);
        const branch = await tx.get<Branch>('branches', plan.branch.id);
        const active = bindings.find(b => !b.detached && b.scope === plan.scope);
        check(guard() && equal(source, plan.binding) && equal(branch, plan.branch) && equal(active, plan.displaced?.binding), '聊天或档案已改变，请重新预览接回');
        if (plan.displaced) {
            const displaced = await tx.get<Branch>('branches', plan.displaced.branch.id);
            check(equal(displaced, plan.displaced.branch), '当前档案已改变，请重新预览接回');
            const detached: Binding = { ...plan.displaced.binding, rebindSchema: 1, detached: true, generation: plan.displaced.binding.generation + 1 };
            await tx.put('host_bindings', detached);
            await tx.put('branches', { ...displaced!, epoch: displaced!.epoch + 1 } as Branch);
        }
        const connected: Binding = { ...source!, scope: plan.scope, rebindSchema: 1, detached: false, generation: source!.generation + 1, intent: 'carryover' };
        await tx.put('host_bindings', connected);
        await tx.put('branches', { ...branch!, epoch: branch!.epoch + 1 } as Branch);
        check(guard(), '聊天已改变，本次接回已撤销');
    });
}
