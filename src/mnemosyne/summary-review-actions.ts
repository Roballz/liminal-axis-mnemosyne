import { activeLibrary } from './db';
import { statuses } from './canonical';
import { syncDaily, hostScope } from './bridge';
import { check, type MemoryRevision } from './model';
import { regenerateFloor, regenerateHigherSummary } from '@/memory/engine';

/** Shared by the in-book review panel and the external edit prompt. */
export async function rebuildSummaryOwners(owners: string[], branchId: string, guard: () => boolean,
    advance: (done: number) => void, stopped: () => boolean = () => false) {
    const targets = new Set(owners), lib = await activeLibrary(), scope = hostScope();
    let done = 0;
    while (targets.size && !stopped()) {
        check(guard(), '聊天改变，已停止；完成的摘要已保留');
        const captured = await syncDaily(), validity = await statuses(lib, captured);
        check(captured.branch.id === branchId && scope === hostScope() && lib === await activeLibrary() && guard(), '聊天或档案改变，已停止更新');
        const currentByOwner = new Map(captured.memories.map(m => [m.owner, m]));
        let next: MemoryRevision | undefined;
        for (const owner of targets) {
            const memory = currentByOwner.get(owner);
            check(memory, '摘要已删除，停止更新');
            if (validity.get(memory.id) === 'valid') { targets.delete(owner); continue; }
            const dependencies = await Promise.all(memory.dependencies.map(id => lib.get<MemoryRevision>('memory_revisions', id)));
            if (dependencies.every(m => m && validity.get(currentByOwner.get(m.owner)?.id ?? '') === 'valid')) { next = memory; break; }
        }
        if (!targets.size) break;
        check(next, '请先修复缺失的来源或依赖摘要；已完成部分保留');
        if (next.level) await regenerateHigherSummary(next.hostId);
        else {
            const floor = captured.refs.findIndex(r => r.message === next!.anchor);
            check(floor >= 0 && await regenerateFloor(floor), '本楼无法重新生成，请手改或检查摘要 API 配置');
        }
        const updated = await syncDaily(), validityAfter = await statuses(lib, updated);
        check(updated.branch.id === branchId && scope === hostScope() && lib === await activeLibrary(), '聊天或档案改变，已停止更新');
        const result = updated.memories.find(m => m.owner === next!.owner);
        check(result && validityAfter.get(result.id) === 'valid', '生成结果仍需审核，请检查来源；完成部分已保存');
        targets.delete(next.owner); advance(++done);
    }
    return done;
}
