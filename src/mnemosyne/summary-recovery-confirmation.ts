import { getContext } from '@/st/context';
import { getLeaf, leafValid } from '@/memory/apply';
import { activeLibrary } from './db';
import { confirmRecoveredSummaries, current } from './canonical';
import { invalidateDaily, serializeDailyActivation, syncDaily } from './bridge';
import { check, type CapturedView } from './model';

/** Read-only target list. A display floor alone is not enough to authorize a replacement. */
export function recoveredSummaryTargets(view: CapturedView) {
    const chat = getContext()?.chat ?? [], positions = new Map(view.refs.map((r, i) => [r.message, i]));
    const hostCounts = new Map<string, number>(), anchorCounts = new Map<string, number>();
    for (const memory of view.memories) {
        hostCounts.set(memory.hostId, (hostCounts.get(memory.hostId) ?? 0) + 1);
        if (memory.anchor) anchorCounts.set(memory.anchor, (anchorCounts.get(memory.anchor) ?? 0) + 1);
    }
    return view.memories.filter(memory => {
        if (!memory.sourceRecovery || memory.level !== 0 || !memory.recall || memory.visibility !== 'public' ||
            !memory.content.trim() || memory.dependencies.length || !memory.anchor ||
            hostCounts.get(memory.hostId) !== 1 || anchorCounts.get(memory.anchor) !== 1) return false;
        const floor = positions.get(memory.anchor);
        if (floor === undefined) return false;
        const message = chat[floor], source = view.sources.get(view.refs[floor].revision), leaf = getLeaf(message);
        return source?.role === 'assistant' && !!message && !message.extra?.bbs_omit && leafValid(message) &&
            leaf?.id === memory.hostId && leaf.text === memory.content && source.content === message.mes &&
            source.provenance.hostKey === message.extra?.mnemosyne_message_v1 &&
            (view.snapshot.variants?.[floor] ?? source.provenance.swipe) === (message.swipe_id ?? 0);
    });
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
