import type { MemSummary } from '@/memory/types';
import type { HostMemory, MemoryStatus } from './canonical';
import type { Transaction } from './db';
import { check, fingerprint, row, type Binding, type CapturedView, type Memory,
    type MemoryRevision } from './model';

export function higherHostMemory(s: MemSummary): HostMemory {
    return { hostId: s.id, content: s.text, level: s.level, anchorKey: null, children: s.childIds,
        generationKey: s.createdAt, storyTime: s.timeStart || s.timeLabel || '', seed: false, enabled: true };
}

/** Follow host child IDs upwards, including parents retired from the archive selection. */
export function relatedHigherSummaries(summaries: readonly MemSummary[], sources: readonly string[]) {
    const parents = new Map<string, MemSummary[]>();
    for (const summary of summaries) for (const child of summary.childIds) {
        const group = parents.get(child);
        if (group) group.push(summary);
        else parents.set(child, [summary]);
    }
    const related = new Map<string, MemSummary>(), queue = [...new Set(sources)];
    for (let i = 0; i < queue.length; i++) for (const parent of parents.get(queue[i]) ?? []) {
        if (related.has(parent.id)) continue;
        related.set(parent.id, parent);
        queue.push(parent.id);
    }
    return related;
}

/** A merge may confirm stale higher nodes in the chosen subtrees only. */
export function higherMergePlan(view: CapturedView, validity: ReadonlyMap<string, MemoryStatus>,
    summaries: readonly MemSummary[], requested: readonly string[]) {
    const byHost = new Map(view.memories.map(m => [m.hostId, m]));
    const bySummary = new Map(summaries.map(s => [s.id, s]));
    check(byHost.size === view.memories.length && bySummary.size === summaries.length, '摘要身份重复，请核对');
    const visited = new Set<string>(), ids: string[] = [], retired: HostMemory[] = [];
    function visit(id: string, parentLevel = Infinity) {
        const memory = byHost.get(id), summary = bySummary.get(id), level = memory?.level ?? summary?.level;
        check(level !== undefined && level < parentLevel, '下级摘要缺失或层级不符，请核对来源');
        if (memory && validity.get(memory.id) === 'valid' || visited.has(id)) return;
        check(summary && summary.level === level && level > 0 && !summary.imported &&
            summary.text.trim() && summary.childIds.length && new Set(summary.childIds).size === summary.childIds.length,
            '下级摘要缺失、仍待审核或没有可核对的下级来源，请先处理该摘要');
        if (memory) check(memory.content === summary.text &&
            ['needs_review', 'needs_rebuild'].includes(validity.get(memory.id) ?? ''), '这条总结的来源不能按当前下级确认');
        for (const child of summary.childIds) visit(child, level);
        visited.add(id);
        if (memory) ids.push(memory.id);
        else retired.push(higherHostMemory(summary));
    }
    requested.forEach(id => visit(id));
    return { ids, retired };
}

export async function retiredHigherHashes(hosts: readonly HostMemory[]) {
    return Promise.all(hosts.map(async host => ({ host, hash: await fingerprint(host) })));
}

/** Stage manual revisions for retired parents in the same transaction as the L0 reviews.
 * Caller validates the combined dependency graph before publishing the branch selection. */
export async function restoreRetiredHigher(tx: Transaction, view: CapturedView, scope: string,
    targets: Awaited<ReturnType<typeof retiredHigherHashes>>) {
    const bindings = (await tx.all<Binding>('host_bindings', 'branch', view.branch.id)).filter(b => !b.detached && b.scope === scope);
    check(bindings.length === 1 && bindings[0].story === view.branch.story, '聊天绑定已改变，请重新核对');
    const families = new Map<string, Memory | null>(), wanted = new Set(targets.map(t => t.host.hostId));
    check(wanted.size === targets.length, '总结身份重复，请核对');
    for (const family of await tx.all<Memory>('memories', 'owner', bindings[0].id)) {
        if (wanted.has(family.hostId)) families.set(family.hostId, families.has(family.hostId) ? null : family);
    }
    const byHost = new Map(view.memories.map(m => [m.hostId, m]));
    check(byHost.size === view.memories.length, '当前分支有重复摘要身份，请核对');
    const revisions: MemoryRevision[] = [];
    for (const { host, hash } of targets.sort((a,b) => a.host.level - b.host.level)) {
        const prior = families.get(host.hostId);
        check(prior && prior.story === view.branch.story && !view.selection.selections[prior.id] && !byHost.has(host.hostId) &&
            prior.retiredFingerprint === hash, '未找到与当前总结完全匹配的旧档案记录，请核对并手动修订该总结');
        check(host.level > 0 && host.enabled && !host.private && host.content.trim() && host.children.length &&
            new Set(host.children).size === host.children.length, '这条总结缺少可核对的下级来源');
        const children = host.children.map(id => byHost.get(id));
        check(children.every((m): m is MemoryRevision => !!m && m.level < host.level &&
            m.branch === view.branch.id && m.story === view.branch.story), '下级摘要缺失或归属已改变，请核对来源');
        const { retiredFingerprint, retiredGenerationFingerprint, ...family } = prior;
        const revision: MemoryRevision = { ...row('mr'), owner: family.id, branch: view.branch.id, story: view.branch.story,
            hostId: host.hostId, content: host.content, level: host.level, storyTime: host.storyTime, fingerprint: hash,
            basis: view.branch.head, inputRefs: [], coverage: [], dependencies: children.map(m => m.id), anchor: null, seed: false,
            visibility: 'public', recall: true, declaration: '人工确认：现有总结适用于本次确认的下级摘要版本。' };
        await tx.put('memories', family);
        await tx.add('memory_revisions', revision);
        byHost.set(host.hostId, revision);
        revisions.push(revision);
    }
    return revisions;
}
