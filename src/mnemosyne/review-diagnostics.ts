import type { Library } from './db';
import { snapshotRefs } from './canonical';
import { check, equal, type CapturedView, type Revision, type Snapshot } from './model';

export interface ReviewDifference {
    kind: 'identity' | 'role' | 'text' | 'coverage' | 'dependency' | 'unknown';
    explanation: string;
    floor?: number;
    before?: { role: Revision['role']; length: number; excerpt: string };
    after?: { role: Revision['role']; length: number; excerpt: string };
}

/** Local, read-only evidence. Matching text never establishes message identity or compatibility. */
export async function reviewDifference(lib: Library, view: CapturedView, memoryId: string): Promise<ReviewDifference> {
    const memory = view.memories.find(m => m.id === memoryId);
    check(memory, '摘要已不在当前视图，请重新加载');
    if (memory.dependencies.length)
        return { kind: 'dependency', explanation: '这条高层摘要还依赖下级摘要版本。请先查看待审核的 L0 摘要；下级被替换或失效也会使上级待审核或需要重建。' };
    return lib.transaction(['history_snapshots', 'manifest_blocks', 'source_revisions'], 'readonly', async tx => {
        const basis = await tx.get<Snapshot>('history_snapshots', memory.basis);
        check(basis, '原摘要的来源快照缺失');
        const refs = await snapshotRefs(tx, basis);
        const explicit = memory.inputRefs.length > 0;
        const required = explicit ? memory.inputRefs : refs.slice(0, memory.anchor ? refs.findIndex(r => r.message === memory.anchor) + 1 : refs.length);
        const positions = new Map(view.refs.map((r, i) => [r.message, i]));
        for (const [index, oldRef] of required.entries()) {
            const position = explicit ? positions.get(oldRef.message) : index;
            const nextRef = position === undefined ? undefined : view.refs[position];
            if (equal(oldRef, nextRef)) continue;
            const before = await tx.get<Revision>('source_revisions', oldRef.revision);
            check(before, '原正文版本缺失');
            const after = nextRef ? view.sources.get(nextRef.revision) : undefined;
            const kind = oldRef.message !== nextRef?.message ? 'identity' : before.role !== after?.role ? 'role' : 'text';
            const oldChars = Array.from(before.content), newChars = Array.from(after?.content ?? '');
            let offset = 0;
            while (offset < oldChars.length && offset < newChars.length && oldChars[offset] === newChars[offset]) offset++;
            const start = before.content === after?.content ? 0 : Math.max(0, offset - 24);
            const preview = (source: Revision) => ({ role: source.role, length: Array.from(source.content).length,
                excerpt: JSON.stringify(Array.from(source.content).slice(start, start + 100).join('')) });
            const reason = kind === 'identity'
                ? '来源消息身份或顺序不一致（也可能被删除）。即使文字相同也不能自动视为同一条消息；下方当前片段仅用于对照。'
                : kind === 'role' ? '同一条消息的角色分类发生变化。' : '同一条消息的正文版本发生变化，片段从首个文字差异附近展示。';
            return { kind, floor: refs.findIndex(r => r.message === oldRef.message),
                explanation: reason + (explicit ? ' 此摘要记录了具体输入来源。' : ' 此旧摘要未记录精确输入范围，按生成时的历史前缀校验；前面一楼变化就可能使后面很多摘要同时待审核。'),
                before: preview(before), after: after ? preview(after) : undefined };
        }
        if (memory.coverage.length) {
            const first = positions.get(memory.coverage[0].message) ?? -1;
            if (first < 0 || !equal(view.refs.slice(first, first + memory.coverage.length), memory.coverage))
                return { kind: 'coverage', explanation: '原摘要覆盖的连续消息范围已改变，可能插入、删除或重排了消息。不能仅凭摘要文字自动放行。' };
        }
        return { kind: 'unknown', explanation: '未找到直接正文差异。仍需核对摘要依赖和来源声明；本次检查不会修改审核状态或事件。' };
    });
}
