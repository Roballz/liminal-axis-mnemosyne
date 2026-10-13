import { getContext } from '@/st/context';
import { getLeaf, leafValid } from '@/memory/apply';
import { activeLibrary } from './db';
import { confirmRecoveredSummaries, current } from './canonical';
import { invalidateDaily, serializeDailyActivation, syncDaily } from './bridge';
import { check, type CapturedView, type MemoryRevision } from './model';

/** Read-only current L0 targets, including ordinary source-review rows in a mixed queue.
 * A display floor alone is not enough to authorize a replacement. */
export function summaryConfirmationPlan(view: CapturedView, requested?: ReadonlySet<string>) {
    const chat = getContext()?.chat ?? [], positions = new Map(view.refs.map((r, i) => [r.message, i]));
    const hostCounts = new Map<string, number>(), anchorCounts = new Map<string, number>();
    for (const memory of view.memories) {
        hostCounts.set(memory.hostId, (hostCounts.get(memory.hostId) ?? 0) + 1);
        if (memory.anchor) anchorCounts.set(memory.anchor, (anchorCounts.get(memory.anchor) ?? 0) + 1);
    }
    const reason = (memory: MemoryRevision): string | null => {
        if (memory.level !== 0) return '上层摘要';
        if (!memory.recall || memory.visibility !== 'public') return '摘要停用或非公开';
        if (!memory.content.trim()) return '摘要正文为空';
        if (!memory.anchor) return '缺少来源锚点';
        if (hostCounts.get(memory.hostId) !== 1) return '摘要身份重复';
        if (anchorCounts.get(memory.anchor) !== 1) return '来源锚点重复';
        const floor = positions.get(memory.anchor);
        if (floor === undefined) return '锚点不在当前正文';
        const message = chat[floor], source = view.sources.get(view.refs[floor].revision), leaf = getLeaf(message);
        if (!source) return '当前来源记录缺失';
        if (source.role !== 'assistant') return '来源不是助手回复';
        if (!message) return '宿主楼层不存在';
        if (message.extra?.bbs_omit) return '宿主楼层已停用';
        if (!leafValid(message)) return '叶摘要或回复版本无效';
        if (leaf?.id !== memory.hostId) return '宿主摘要身份不一致';
        if (leaf.text !== memory.content) return '宿主摘要正文不一致';
        if (source.content !== message.mes) return '来源正文不一致';
        if (source.provenance.hostKey !== message.extra?.mnemosyne_message_v1) return '来源消息身份不一致';
        if ((view.snapshot.variants?.[floor] ?? source.provenance.swipe) !== (message.swipe_id ?? 0)) return '当前回复版本不一致';
        return null;
    };
    const targets: MemoryRevision[] = [], exclusions = new Map<string, number>();
    for (const memory of view.memories) {
        if (requested && !requested.has(memory.id)) continue;
        const blocked = reason(memory);
        if (blocked) exclusions.set(blocked, (exclusions.get(blocked) ?? 0) + 1);
        else targets.push(memory);
    }
    return { targets, exclusions };
}
export function recoveredSummaryTargets(view: CapturedView) {
    return summaryConfirmationPlan(view).targets;
}

/** All selected rows commit together; no model call, host edit, replay or per-row synchronization. */
export async function retainRecoveredSummaries(view: CapturedView, ids: string[], guard: () => boolean) {
    const revisions = await serializeDailyActivation(async () => {
        const lib = await activeLibrary();
        check(guard() && await current(lib, view), '聊天或摘要已改变，请刷新后重新确认');
        const eligible = new Set(recoveredSummaryTargets(view).map(m => m.id));
        check(ids.length && ids.every(id => eligible.has(id)), '摘要已删除、停用或无法映射；请刷新后重新选择');
        return confirmRecoveredSummaries(lib, view, ids, guard);
    });
    invalidateDaily();
    try {
        const result = await syncDaily();
        check(result.branch.id === view.branch.id && revisions.every(m => result.selection.selections[m.owner] === m.id),
            '当前聊天或摘要已改变，请重新查看最新状态');
        return result;
    } catch (error) {
        throw new Error(`已保存 ${revisions.length} 条人工确认，刷新未完成：${(error as Error).message}`);
    }
}
