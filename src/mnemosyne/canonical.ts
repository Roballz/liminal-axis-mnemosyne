import { sourceRefMatches, sourceRefsMatch } from './source-equivalence';
import { Library, Transaction } from './db';
import {
    STORES,
    row,
    check,
    equal,
    fingerprint,
    type Branch,
    type Binding,
    type Mapping,
    type SourceRef,
    type Revision,
    type Snapshot,
    type Block,
    type Memory,
    type MemoryRevision,
    type MemoryView,
    type Review,
    type CapturedView,
} from './model';
export interface HostMessage {
    key: string;
    role: Revision['role'];
    content: string;
    swipe: number;
    excluded?: boolean;
}
export interface HostMemory {
    hostId: string;
    content: string;
    level: number;
    anchorKey: string | null;
    children: string[];
    storyTime: string;
    seed: boolean;
    enabled: boolean;
    private?: boolean;
    // Only recorded generation evidence may populate these, never guessed from a display floor.
    inputRefs?: SourceRef[];
    coverage?: SourceRef[];
    declaration?: string;
    generatedSidecar?: boolean;
    basisSnapshot?: string;
    generationKey?: number;
    manualEdit?: boolean;
}
/** A high summary with recorded children depends on those children, not the entire chat tail. */
export const dependencyOnly = (m: MemoryRevision) => m.level > 0 && !m.anchor && !m.inputRefs.length && !!m.dependencies.length;
export async function summarySources(tx: Transaction, memory: MemoryRevision): Promise<SourceRef[]> {
    if (memory.inputRefs.length) return memory.inputRefs;
    if (dependencyOnly(memory)) return [];
    const snapshot = await tx.get<Snapshot>('history_snapshots', memory.basis);
    check(snapshot, '摘要基线缺失');
    const refs = await snapshotRefs(tx, snapshot);
    return memory.anchor ? refs.slice(0, refs.findIndex(r => r.message === memory.anchor) + 1) : refs;
}
export interface HostObservation {
    scope: string;
    messages: HostMessage[];
    memories: HostMemory[];
}
export async function snapshotRefs(tx: Transaction, snapshot: Snapshot): Promise<SourceRef[]> {
    const refs: SourceRef[] = [];
    for (const key of snapshot.blocks) {
        const block = await tx.get<Block>('manifest_blocks', key);
        check(block, '缺少历史清单块');
        refs.push(...block.entries);
    }
    check(refs.length === snapshot.length, '历史清单计数错误');
    return refs;
}
async function publishSnapshot(tx: Transaction, branch: Branch, refs: SourceRef[]): Promise<string> {
    const prior = branch.head ? await tx.get<Snapshot>('history_snapshots', branch.head) : undefined;
    const old = prior ? await snapshotRefs(tx, prior) : [];
    if (prior && equal(old, refs)) return prior.id;
    const blocks: string[] = [];
    // Reuse unchanged 128-reference blocks; appends do not copy entire histories.
    for (let offset = 0; offset < refs.length; offset += 128) {
        const entries = refs.slice(offset, offset + 128);
        if (prior && equal(entries, old.slice(offset, offset + 128))) blocks.push(prior.blocks[offset / 128]);
        else {
            const block: Block = { ...row('hm'), entries };
            await tx.add('manifest_blocks', block);
            blocks.push(block.id);
        }
    }
    const snapshot: Snapshot = {
        ...row('hs'),
        story: branch.story,
        branch: branch.id,
        previous: prior?.id ?? null,
        blocks,
        length: refs.length,
        created: Date.now(),
    };
    await tx.add('history_snapshots', snapshot);
    return snapshot.id;
}
export async function synchronize(lib: Library, observation: HostObservation): Promise<Branch> {
    check(
        observation.scope && new Set(observation.messages.map((m) => m.key)).size === observation.messages.length,
        '消息映射身份重复，需要人工核对',
    );
    const hashes = await Promise.all(observation.messages.map((m) => fingerprint([m.role, m.content])));
    const memoryHashes = await Promise.all(observation.memories.map((m) => fingerprint(m)));
    return lib.transaction(STORES, 'readwrite', async (tx) => {
        const bindings = await tx.all<Binding>('host_bindings');
        let binding = bindings.find((b) => !b.detached && b.scope === observation.scope);
        let branch: Branch;
        if (!binding) {
            const story = { ...row('st'), created: Date.now() };
            branch = { ...row('br'), story: story.id, head: '', view: '', epoch: 0, fork: null };
            binding = {
                ...row('hb'),
                story: story.id,
                branch: branch.id,
                scope: observation.scope,
                generation: 1,
                intent: 'new_story',
            };
            await tx.add('stories', story);
            await tx.add('host_bindings', binding);
        } else {
            const existing = await tx.get<Branch>('branches', binding.branch);
            check(existing, '绑定分支丢失');
            branch = existing;
        }
        const maps = await tx.all<Mapping>('message_mappings', 'owner', binding.id);
        const mappings = new Map(maps.map((m) => [m.hostKey, m]));
        const priorSnapshot = branch.head ? await tx.get<Snapshot>('history_snapshots', branch.head) : undefined;
        const priorRefs = priorSnapshot ? await snapshotRefs(tx, priorSnapshot) : [];
        const priorSources = new Map(
            (await Promise.all(priorRefs.map((r) => tx.get<Revision>('source_revisions', r.revision))))
                .filter((r): r is Revision => !!r)
                .map((r) => [r.owner, r]),
        );
        const refs: SourceRef[] = [];
        const byHost = new Map<string, SourceRef>();
        for (let i = 0; i < observation.messages.length; i++) {
            const host = observation.messages[i];
            let mapping = mappings.get(host.key);
            if (!mapping) {
                const message = { ...row('msg'), story: branch.story };
                await tx.add('source_messages', message);
                mapping = { ...row('map'), owner: binding.id, message: message.id, hostKey: host.key };
                await tx.add('message_mappings', mapping);
            }
            let revision = priorSources.get(mapping.message);
            if (
                !revision ||
                revision.fingerprint !== hashes[i] ||
                revision.content !== host.content ||
                revision.role !== host.role
            ) {
                const history = await tx.all<Revision>('source_revisions', 'owner', mapping.message);
                revision = history.find(
                    (r) => r.fingerprint === hashes[i] && r.content === host.content && r.role === host.role,
                );
            }
            if (!revision) {
                revision = {
                    ...row('rev'),
                    story: branch.story,
                    owner: mapping.message,
                    role: host.role,
                    content: host.content,
                    fingerprint: hashes[i],
                    provenance: { binding: binding.id, hostKey: host.key, index: i, swipe: host.swipe },
                };
                await tx.add('source_revisions', revision);
            }
            const ref = { message: mapping.message, revision: revision.id };
            refs.push(ref);
            byHost.set(host.key, ref);
        }
        const oldHead = branch.head;
        branch.head = await publishSnapshot(tx, branch, refs);
        const families = await tx.all<Memory>('memories', 'owner', binding.id);
        const familyByHost = new Map(families.map((m) => [m.hostId, m]));
        const previous = branch.view ? await tx.get<MemoryView>('memory_views', branch.view) : undefined;
        const selectedMemories = new Map(
            (
                await Promise.all(
                    Object.values(previous?.selections ?? {}).map((key) =>
                        tx.get<MemoryRevision>('memory_revisions', key),
                    ),
                )
            )
                .filter((m): m is MemoryRevision => !!m)
                .map((m) => [m.owner, m]),
        );
        const selections: Record<string, string> = {};
        const hostRevisions = new Map<string, string>();
        const newRevisions: {
            revision: MemoryRevision;
            host: HostMemory;
        }[] = [];
        const sidecars: { revision: MemoryRevision; host: HostMemory }[] = [];
        for (const [i, item] of observation.memories.entries()) {
            let host = item;
            let family = familyByHost.get(host.hostId);
            if (!family) {
                family = { ...row('mem'), story: branch.story, owner: binding.id, hostId: host.hostId };
                await tx.add('memories', family);
                families.push(family);
                familyByHost.set(host.hostId, family);
            }
            let revision = selectedMemories.get(family.id);
            if (!revision || revision.fingerprint !== memoryHashes[i]) {
                const revisions = await tx.all<MemoryRevision>('memory_revisions', 'owner', family.id);
                revision = revisions.find((r) => r.fingerprint === memoryHashes[i]);
            }
            if (!revision) {
                const dependencies = host.children.map((c) => hostRevisions.get(c)).filter((c): c is string => !!c);
                const anchor = host.anchorKey ? (byHost.get(host.anchorKey)?.message ?? null) : null;
                revision = {
                    ...row('mr'),
                    story: branch.story,
                    branch: branch.id,
                    owner: family.id,
                    content: host.content,
                    fingerprint: memoryHashes[i],
                    basis: host.basisSnapshot ?? branch.head,
                    inputRefs: host.inputRefs ?? [],
                    coverage: host.coverage ?? [],
                    dependencies,
                    declaration:
                        host.declaration ??
                        '柏宝书兼容摘要：生成输入未经完整记录；基线前缀仅为适用性声明，不是生成来源。',
                    level: host.level,
                    anchor,
                    storyTime: host.storyTime,
                    recall: host.enabled,
                    visibility: host.private ? 'private' : 'public',
                    seed: host.seed,
                    hostId: host.hostId,
                };
                const prior = selectedMemories.get(family.id);
                if (host.manualEdit && prior && !host.inputRefs) {
                    const sources = await summarySources(tx, prior);
                    const updated = sources.map(r => refs.find(v => v.message === r.message));
                    if (updated.every((r): r is SourceRef => !!r)) {
                        revision.inputRefs = updated;
                        revision.coverage = prior.coverage.map(r => refs.find(v => v.message === r.message)!).filter(Boolean);
                        revision.declaration = '人工修订摘要：以当前来源版本确认内容；原生成版本保留。';
                        // Preserve recorded dependency identities, selecting their current version below.
                        if (!host.children.length) host = { ...host, children: await Promise.all(prior.dependencies.map(async id => {
                            const dependency = await tx.get<MemoryRevision>('memory_revisions', id);
                            check(dependency, '原摘要依赖缺失');
                            return dependency.hostId;
                        })) };
                    }
                }
                newRevisions.push({ revision, host });
            }
            if (host.generatedSidecar && host.inputRefs?.some(ref => !refs.some(r => equal(r, ref))) &&
                host.inputRefs.every(ref => ref.message === revision!.anchor || refs.some(r => equal(r, ref))))
                sidecars.push({ revision, host });
            selections[family.id] = revision.id;
            hostRevisions.set(host.hostId, revision.id);
        }
        for (const { revision, host } of newRevisions) {
            revision.dependencies = host.children
                .map((key) => hostRevisions.get(key))
                .filter((key): key is string => !!key);
            if (revision.dependencies.length !== host.children.length) revision.recall = false;
            await tx.add('memory_revisions', revision);
        }
        for (const { revision } of sidecars) {
            const sourceRefs = revision.inputRefs.map(ref => refs.find(r => r.message === ref.message)!);
            const coverage = revision.coverage.map(ref => refs.find(r => r.message === ref.message)!);
            const reviews = await tx.all<Review>('reviews', 'owner', revision.id);
            if (!reviews.some(r => r.reviewSchema === 2 && equal(r.sourceRefs, sourceRefs) && equal(r.dependencies, revision.dependencies)))
                await tx.add('reviews', { ...row('review'), story: branch.story, branch: branch.id, owner: revision.id,
                    snapshot: branch.head, decision: 'compatible', origin: 'generated_sidecar', created: Date.now(),
                    reviewSchema: 2, sourceRefs, coverage, dependencies: revision.dependencies } as Review);
        }
        if (!previous || !equal(previous.selections, selections)) {
            const view: MemoryView = { ...row('mv'), branch: branch.id, selections };
            await tx.add('memory_views', view);
            branch.view = view.id;
        }
        if (oldHead !== branch.head || previous?.id !== branch.view) branch.epoch++;
        await tx.put('branches', branch);
        return branch;
    });
}
export async function capture(
    lib: Library,
    branchId: string,
    cutoff?: number,
    snapshotId?: string,
): Promise<CapturedView> {
    return lib.transaction(STORES, 'readonly', async (tx) => {
        const branch = await tx.get<Branch>('branches', branchId);
        check(branch, '分支不存在');
        const snapshot = await tx.get<Snapshot>('history_snapshots', snapshotId ?? branch.head);
        check(snapshot && snapshot.branch === branch.id, '快照不属于该分支');
        const selection = await tx.get<MemoryView>('memory_views', branch.view);
        check(selection, '摘要视图缺失');
        const refs = await snapshotRefs(tx, snapshot);
        const length = cutoff ?? refs.length;
        check(Number.isInteger(length) && length >= 0 && length <= refs.length, '截止点无效');
        // Queue independent requests together, rather than one native IDB round-trip per record.
        const [sourceRows, memoryRows] = await Promise.all([
            Promise.all(refs.slice(0, length).map((ref) => tx.get<Revision>('source_revisions', ref.revision))),
            Promise.all(
                Object.values(selection.selections).map((key) => tx.get<MemoryRevision>('memory_revisions', key)),
            ),
        ]);
        check(sourceRows.every(Boolean), '正文版本缺失');
        check(memoryRows.every(Boolean), '摘要版本缺失');
        const sources = new Map(sourceRows.map((r) => [r!.id, r!]));
        const memories = memoryRows as MemoryRevision[];
        return { branch, snapshot, refs: refs.slice(0, length), selection, sources, memories, cutoff: length };
    });
}
export async function current(lib: Library, view: CapturedView): Promise<boolean> {
    const branch = await lib.get<Branch>('branches', view.branch.id);
    return (
        !!branch &&
        branch.head === view.branch.head &&
        branch.view === view.branch.view &&
        branch.epoch === view.branch.epoch
    );
}
export type MemoryStatus = 'valid' | 'excluded' | 'needs_review' | 'needs_rebuild' | 'out_of_scope';
export async function statuses(lib: Library, view: CapturedView): Promise<Map<string, MemoryStatus>> {
    return lib.transaction(['history_snapshots', 'manifest_blocks', 'reviews'], 'readonly', async (tx) => {
        const snapshots = await Promise.all(
            [...new Set(view.memories.map((m) => m.basis))].map((key) => tx.get<Snapshot>('history_snapshots', key)),
        );
        check(snapshots.every(Boolean), '摘要基线缺失');
        const unknownBases = new Set(view.memories.filter((m) => !m.inputRefs.length).map((m) => m.basis));
        const legacySnapshots = snapshots.filter((s) => unknownBases.has(s!.id));
        const blocks = await Promise.all(
            [...new Set(legacySnapshots.flatMap((s) => s!.blocks))].map((key) => tx.get<Block>('manifest_blocks', key)),
        );
        check(blocks.every(Boolean), '缺少历史清单块');
        const blockMap = new Map(blocks.map((b) => [b!.id, b!]));
        const positions = new Map(view.refs.map((r, i) => [r.message, i]));
        const refByMessage = new Map(view.refs.map((r) => [r.message, r]));
        const bases = new Map(
            legacySnapshots.map((snapshot) => {
                const refs = snapshot!.blocks.flatMap((key) => blockMap.get(key)!.entries);
                check(refs.length === snapshot!.length, '历史清单计数错误');
                let prefix = 0;
                while (
                    prefix < refs.length &&
                    sourceRefMatches(view.branch, refs[prefix], view.refs[prefix])
                )
                    prefix++;
                return [
                    snapshot!.id,
                    { refs, prefix, positions: new Map(refs.map((r, i) => [r.message, i])) },
                ] as const;
            }),
        );
        const reviews = await tx.all<Review>('reviews', 'branch', view.branch.id);
        const compatible = new Map<string, Review>();
        for (const review of reviews.sort((a,b) => a.created - b.created)) {
            if (review.reviewSchema !== 2) {
                if (review.snapshot === view.snapshot.id) compatible.set(review.owner, review);
                continue;
            }
            const memory = view.memories.find(m => m.id === review.owner);
            if (!memory) continue;
            const approved = review.sourceRefs!;
            const order = approved.map(r => positions.get(r.message) ?? -1);
            if (approved.some(r => !sourceRefMatches(view.branch, r, refByMessage.get(r.message))) ||
                order.some((n, i) => n < 0 || (i > 0 && n <= order[i - 1]))) continue;
            // Legacy applicability remains an entire prefix; never turn it into a sparse guess.
            if (!memory.inputRefs.length && !dependencyOnly(memory) &&
                !sourceRefsMatch(view.branch, approved, view.refs.slice(0, approved.length))) continue;
            const coverage = review.coverage!;
            const start = positions.get(coverage[0]?.message) ?? -1;
            if (coverage.length && (start < 0 || !sourceRefsMatch(view.branch, coverage, view.refs.slice(start, start + coverage.length)))) continue;
            compatible.set(review.owner, review);
        }
        const byId = new Map(view.memories.map((m) => [m.id, m]));
        const result = new Map<string, MemoryStatus>(),
            active = new Set<string>();
        const evaluate = (memory: MemoryRevision): MemoryStatus => {
            if (result.has(memory.id)) return result.get(memory.id)!;
            check(!active.has(memory.id), '摘要依赖循环');
            active.add(memory.id);
            let status: MemoryStatus = 'valid';
            if (memory.story !== view.branch.story || memory.branch !== view.branch.id) status = 'out_of_scope';
            else if (!memory.recall || memory.visibility !== 'public') status = 'excluded';
            else if (memory.anchor && !positions.has(memory.anchor)) status = 'out_of_scope';
            else {
                const basis = bases.get(memory.basis)!;
                const requiredLength = memory.inputRefs.length || dependencyOnly(memory)
                    ? 0
                    : memory.anchor
                      ? (basis.positions.get(memory.anchor) ?? -1) + 1
                      : basis.refs.length;
                if (
                    !compatible.has(memory.id) &&
                    (memory.inputRefs.length
                        ? memory.inputRefs.some((r) => !sourceRefMatches(view.branch, r, refByMessage.get(r.message)))
                        : basis.prefix < requiredLength)
                )
                    status = 'needs_review';
                if (memory.coverage.length && !compatible.has(memory.id)) {
                    const first = positions.get(memory.coverage[0].message) ?? -1;
                    if (first < 0 || !sourceRefsMatch(view.branch, memory.coverage, view.refs.slice(first, first + memory.coverage.length)))
                        status = 'needs_review';
                }
                for (const dependency of compatible.get(memory.id)?.dependencies ?? memory.dependencies) {
                    const child = byId.get(dependency);
                    if (!child) {
                        status = 'needs_rebuild';
                        break;
                    }
                    const childStatus = evaluate(child);
                    if (childStatus !== 'valid')
                        status = childStatus === 'needs_review' ? 'needs_review' : 'needs_rebuild';
                }
            }
            active.delete(memory.id);
            result.set(memory.id, status);
            return status;
        };
        for (const memory of view.memories) evaluate(memory);
        return result;
    });
}
export async function keepSummary(lib: Library, view: CapturedView, memoryId: string, guard: () => boolean = () => true) {
    return keepSummaries(lib, view, [memoryId], guard);
}
/** Explicit approval; immutable generation provenance is never rewritten. */
export async function keepSummaries(lib: Library, view: CapturedView, memoryIds: string[], guard: () => boolean = () => true) {
    check(view.snapshot.id === view.branch.head && view.cutoff === view.snapshot.length, '只能审核当前完整档案');
    const requested = new Set(memoryIds), states = await statuses(lib, view);
    check(requested.size && requested.size === memoryIds.length, '请选择不重复的摘要');
    check([...requested].every(id => view.memories.some(m => m.id === id && m.recall && m.visibility === 'public')), '摘要不在当前有效范围');
    await lib.transaction(STORES, 'readwrite', async tx => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(guard() && branch && branch.epoch === view.branch.epoch && branch.head === view.snapshot.id && branch.view === view.selection.id, '视图已改变，请刷新');
        const positions = new Map(view.refs.map((r,i) => [r.message,i]));
        const currentByOwner = new Map(view.memories.map(m => [m.owner,m]));
        const plans = new Map<string, Review>();
        for (const id of requested) {
            const memory = view.memories.find(m => m.id === id)!;
            const source = await summarySources(tx, memory);
            const order = source.map(r => positions.get(r.message) ?? -1);
            check(order.every((p,i) => p >= 0 && (!i || p > order[i-1])), '来源已删除或重排，不能直接保留；请手改或重新生成摘要');
            const sourceRefs = order.map(i => view.refs[i]);
            if (!memory.inputRefs.length && !dependencyOnly(memory))
                check(equal(sourceRefs, view.refs.slice(0, sourceRefs.length)), '来源前缀身份已改变，请手改或重新生成摘要');
            check(!memory.anchor || positions.has(memory.anchor), '摘要来源楼层已删除');
            const coverage = memory.coverage.map(r => view.refs[positions.get(r.message) ?? -1]);
            check(coverage.every(Boolean) && (!coverage.length || equal(coverage, view.refs.slice(positions.get(coverage[0].message)!, positions.get(coverage[0].message)! + coverage.length))), '摘要覆盖范围已改变');
            const dependencies: string[] = [];
            for (const oldId of memory.dependencies) {
                const prior = await tx.get<MemoryRevision>('memory_revisions', oldId);
                const selected = prior && currentByOwner.get(prior.owner);
                check(selected && selected.id !== memory.id, '依赖摘要已删除或无法匹配，请手改或重新生成摘要');
                dependencies.push(selected.id);
            }
            plans.set(id, { ...row('review'), story: branch.story, branch: branch.id, owner: id,
                snapshot: view.snapshot.id, decision: 'compatible', origin: 'manual', created: Date.now(),
                reviewSchema: 2, sourceRefs, coverage, dependencies });
        }
        const pending = new Map(plans), accepted = new Set<string>();
        while (pending.size) {
            const ready = [...pending.values()].filter(r => r.dependencies!.every(id => accepted.has(id) || (!pending.has(id) && states.get(id) === 'valid')));
            check(ready.length, '请先审核或修复依赖摘要；不存在的来源不能直接保留');
            for (const review of ready) { await tx.add('reviews', review); accepted.add(review.owner); pending.delete(review.owner); }
        }
        check(guard(), '视图已改变，请刷新');
        branch.epoch++;
        await tx.put('branches', branch);
    });
}
/** Explicit fixed-parent fork; bindings are never inferred from matching content. */
export async function forkBranch(lib: Library, parent: CapturedView, scope: string, guard: () => boolean = () => true): Promise<Branch> {
    return lib.transaction(STORES, 'readwrite', async (tx) => {
        check(guard(), '聊天已改变，请重新选择分支');
        check(!(await tx.all<Binding>('host_bindings')).some((b) => !b.detached && b.scope === scope), '目标聊天已绑定');
        const branch: Branch = {
            ...row('br'),
            story: parent.branch.story,
            head: '',
            view: '',
            epoch: 1,
            fork: {
                branch: parent.branch.id,
                snapshot: parent.snapshot.id,
                length: parent.cutoff,
                anchor: parent.refs.at(-1) ?? null,
            },
        };
        branch.head = await publishSnapshot(tx, branch, parent.refs);
        const selection: MemoryView = { ...row('mv'), branch: branch.id, selections: {} };
        // Unknown-source legacy summaries are branch-scoped; do not silently inherit them.
        await tx.add('memory_views', selection);
        branch.view = selection.id;
        const binding: Binding = {
            ...row('hb'),
            story: branch.story,
            branch: branch.id,
            scope,
            generation: 1,
            intent: 'fork',
        };
        await tx.add('host_bindings', binding);
        const parentBindings = await tx.all<Binding>('host_bindings', 'branch', parent.branch.id);
        for (const sourceBinding of parentBindings) {
            for (const mapping of await tx.all<Mapping>('message_mappings', 'owner', sourceBinding.id)) {
                if (parent.refs.some((r) => r.message === mapping.message))
                    await tx.add('message_mappings', {
                        ...mapping,
                        ...row('map'),
                        owner: binding.id,
                    });
            }
        }
        await tx.add('branches', branch);
        check(guard(), '聊天已改变，本次分叉已撤销');
        return branch;
    });
}
