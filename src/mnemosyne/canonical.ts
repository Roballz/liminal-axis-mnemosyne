import { Library, Transaction } from './db';
import { STORES, row, check, equal, fingerprint, type Branch, type Binding, type Mapping, type SourceRef, type Revision, type Snapshot, type Block, type Memory, type MemoryRevision, type MemoryView, type Review, type CapturedView } from './model';
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
    basisSnapshot?: string; generationKey?:number;
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
    if (prior && equal(old, refs))
        return prior.id;
    const blocks: string[] = [];
    // Reuse unchanged 128-reference blocks; appends do not copy entire histories.
    for (let offset = 0; offset < refs.length; offset += 128) {
        const entries = refs.slice(offset, offset + 128);
        if (prior && equal(entries, old.slice(offset, offset + 128)))
            blocks.push(prior.blocks[offset / 128]);
        else {
            const block: Block = { ...row('hm'), entries };
            await tx.add('manifest_blocks', block);
            blocks.push(block.id);
        }
    }
    const snapshot: Snapshot = { ...row('hs'), story: branch.story, branch: branch.id,
        previous: prior?.id ?? null, blocks, length: refs.length, created: Date.now() };
    await tx.add('history_snapshots', snapshot);
    return snapshot.id;
}
export async function synchronize(lib: Library, observation: HostObservation): Promise<Branch> {
    check(observation.scope && new Set(observation.messages.map(m => m.key)).size === observation.messages.length, '消息映射身份重复，需要人工核对');
    const hashes = await Promise.all(observation.messages.map(m => fingerprint([m.role, m.content])));
    const memoryHashes = await Promise.all(observation.memories.map(m => fingerprint(m)));
    return lib.transaction(STORES, 'readwrite', async (tx) => {
        const bindings = await tx.all<Binding>('host_bindings');
        let binding = bindings.find(b => b.scope === observation.scope);
        let branch: Branch;
        if (!binding) {
            const story = { ...row('st'), created: Date.now() };
            branch = { ...row('br'), story: story.id, head: '', view: '', epoch: 0, fork: null };
            binding = { ...row('hb'), story: story.id, branch: branch.id, scope: observation.scope, generation: 1, intent: 'new_story' };
            await tx.add('stories', story);
            await tx.add('host_bindings', binding);
        }
        else {
            const existing = await tx.get<Branch>('branches', binding.branch);
            check(existing, '绑定分支丢失');
            branch = existing;
        }
        const maps = await tx.all<Mapping>('message_mappings', 'owner', binding.id);
        const refs: SourceRef[] = [];
        const byHost = new Map<string, SourceRef>();
        for (let i = 0; i < observation.messages.length; i++) {
            const host = observation.messages[i];
            let mapping = maps.find(m => m.hostKey === host.key);
            if (!mapping) {
                const message = { ...row('msg'), story: branch.story };
                await tx.add('source_messages', message);
                mapping = { ...row('map'), owner: binding.id, message: message.id, hostKey: host.key };
                await tx.add('message_mappings', mapping);
            }
            const history = await tx.all<Revision>('source_revisions', 'owner', mapping.message);
            let revision = history.find(r => r.fingerprint === hashes[i] && r.content === host.content && r.role === host.role);
            if (!revision) {
                revision = { ...row('rev'), story: branch.story, owner: mapping.message, role: host.role,
                    content: host.content, fingerprint: hashes[i], provenance: { binding: binding.id, hostKey: host.key, index: i, swipe: host.swipe } };
                await tx.add('source_revisions', revision);
            }
            const ref = { message: mapping.message, revision: revision.id };
            refs.push(ref);
            byHost.set(host.key, ref);
        }
        const oldHead = branch.head;
        branch.head = await publishSnapshot(tx, branch, refs);
        const families = await tx.all<Memory>('memories', 'owner', binding.id);
        const selections: Record<string, string> = {};
        const hostRevisions = new Map<string, string>();
        const newRevisions: {
            revision: MemoryRevision;
            host: HostMemory;
        }[] = [];
        for (const [i, host] of observation.memories.entries()) {
            let family = families.find(m => m.hostId === host.hostId);
            if (!family) {
                family = { ...row('mem'), story: branch.story, owner: binding.id, hostId: host.hostId };
                await tx.add('memories', family);
                families.push(family);
            }
            const revisions = await tx.all<MemoryRevision>('memory_revisions', 'owner', family.id);
            let revision = revisions.find(r => r.fingerprint === memoryHashes[i]);
            if (!revision) {
                const dependencies = host.children.map(c => hostRevisions.get(c)).filter((c): c is string => !!c);
                const anchor = host.anchorKey ? byHost.get(host.anchorKey)?.message ?? null : null;
                revision = { ...row('mr'), story: branch.story, branch: branch.id, owner: family.id,
                    content: host.content, fingerprint: memoryHashes[i], basis: host.basisSnapshot ?? branch.head,
                    inputRefs: host.inputRefs ?? [], coverage: host.coverage ?? [], dependencies,
                    declaration: host.declaration ?? '柏宝书兼容摘要：生成输入未经完整记录；基线前缀仅为适用性声明，不是生成来源。',
                    level: host.level, anchor, storyTime: host.storyTime, recall: host.enabled,
                    visibility: host.private ? 'private' : 'public', seed: host.seed, hostId: host.hostId };
                newRevisions.push({ revision, host });
            }
            if (host.generatedSidecar && host.inputRefs?.some(ref => !refs.some(r => equal(r, ref))) &&
                host.inputRefs.every(ref => ref.message === revision!.anchor || refs.some(r => equal(r, ref)))) {
                const reviews = await tx.all<Review>('reviews', 'owner', revision.id);
                if (!reviews.some(r => r.snapshot === branch.head))
                    await tx.add('reviews', {
                        ...row('review'), story: branch.story, branch: branch.id, owner: revision.id, snapshot: branch.head,
                        decision: 'compatible', origin: 'generated_sidecar', created: Date.now(),
                    } as Review);
            }
            selections[family.id] = revision.id;
            hostRevisions.set(host.hostId, revision.id);
        }
        for (const { revision, host } of newRevisions) {
            revision.dependencies = host.children.map(key => hostRevisions.get(key)).filter((key): key is string => !!key);
            if (revision.dependencies.length !== host.children.length)
                revision.recall = false;
            await tx.add('memory_revisions', revision);
        }
        const previous = branch.view ? await tx.get<MemoryView>('memory_views', branch.view) : undefined;
        if (!previous || !equal(previous.selections, selections)) {
            const view: MemoryView = { ...row('mv'), branch: branch.id, selections };
            await tx.add('memory_views', view);
            branch.view = view.id;
        }
        if (oldHead !== branch.head || previous?.id !== branch.view)
            branch.epoch++;
        await tx.put('branches', branch);
        return branch;
    });
}
export async function capture(lib: Library, branchId: string, cutoff?: number, snapshotId?: string): Promise<CapturedView> {
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
        const sources = new Map<string, Revision>();
        for (const ref of refs.slice(0, length)) {
            const revision = await tx.get<Revision>('source_revisions', ref.revision);
            check(revision, '正文版本缺失');
            sources.set(ref.revision, revision);
        }
        const memories: MemoryRevision[] = [];
        for (const key of Object.values(selection.selections)) {
            const memory = await tx.get<MemoryRevision>('memory_revisions', key);
            check(memory, '摘要版本缺失');
            memories.push(memory);
        }
        return { branch, snapshot, refs: refs.slice(0, length), selection, sources, memories, cutoff: length };
    });
}
export async function current(lib: Library, view: CapturedView): Promise<boolean> {
    const branch = await lib.get<Branch>('branches', view.branch.id);
    return !!branch && branch.head === view.branch.head && branch.view === view.branch.view && branch.epoch === view.branch.epoch;
}
export type MemoryStatus = 'valid' | 'excluded' | 'needs_review' | 'needs_rebuild' | 'out_of_scope';
export async function statuses(lib: Library, view: CapturedView): Promise<Map<string, MemoryStatus>> {
    return lib.transaction(STORES, 'readonly', async (tx) => {
        const result = new Map<string, MemoryStatus>();
        const active = new Set<string>();
        const evaluate = async (memory: MemoryRevision): Promise<MemoryStatus> => {
            if (result.has(memory.id))
                return result.get(memory.id)!;
            check(!active.has(memory.id), '摘要依赖循环');
            active.add(memory.id);
            let status: MemoryStatus = 'valid';
            if (memory.story !== view.branch.story || memory.branch !== view.branch.id)
                status = 'out_of_scope';
            else if (!memory.recall || memory.visibility !== 'public')
                status = 'excluded';
            else if (memory.anchor && !view.refs.some(r => r.message === memory.anchor))
                status = 'out_of_scope';
            else {
                const basis = await tx.get<Snapshot>('history_snapshots', memory.basis);
                check(basis, '摘要基线缺失');
                const basisRefs = await snapshotRefs(tx, basis);
                // Unknown provenance uses an explicitly declared immutable prefix, never fabricated input refs.
                const required = memory.inputRefs.length ? memory.inputRefs : basisRefs.slice(0, memory.anchor ? basisRefs.findIndex(r => r.message === memory.anchor) + 1 : basisRefs.length);
                const reviews = await tx.all<Review>('reviews', 'owner', memory.id);
                const compatible = reviews.some(r => r.branch === view.branch.id && r.snapshot === view.snapshot.id);
                if (!compatible && (memory.inputRefs.length
                    ? required.some(r => !view.refs.some(v => equal(v, r)))
                    : !equal(required, view.refs.slice(0, required.length))))
                    status = 'needs_review';
                if (memory.coverage.length) {
                    const first = view.refs.findIndex(r => r.message === memory.coverage[0].message);
                    if (first < 0 || !equal(view.refs.slice(first, first + memory.coverage.length), memory.coverage)) {
                        if (!compatible)
                            status = 'needs_review';
                    }
                }
                for (const dependency of memory.dependencies) {
                    const child = view.memories.find(m => m.id === dependency);
                    if (!child) {
                        status = 'needs_rebuild';
                        break;
                    }
                    const childStatus = await evaluate(child);
                    if (childStatus !== 'valid')
                        status = childStatus === 'needs_review' ? 'needs_review' : 'needs_rebuild';
                }
            }
            active.delete(memory.id);
            result.set(memory.id, status);
            return status;
        };
        for (const memory of view.memories)
            await evaluate(memory);
        return result;
    });
}
export async function keepSummary(lib: Library, view: CapturedView, memoryId: string) {
    check(view.memories.some(m => m.id === memoryId), '摘要不在当前视图');
    await lib.transaction(['branches', 'reviews'], 'readwrite', async (tx) => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(branch && branch.epoch === view.branch.epoch, '视图已改变，请刷新');
        const review: Review = { ...row('review'), story: branch.story, branch: branch.id, owner: memoryId,
            snapshot: view.snapshot.id, decision: 'compatible', origin: 'manual', created: Date.now() };
        await tx.add('reviews', review);
        branch.epoch++;
        await tx.put('branches', branch);
    });
}
/** Explicit fixed-parent fork; bindings are never inferred from matching content. */
export async function forkBranch(lib: Library, parent: CapturedView, scope: string): Promise<Branch> {
    return lib.transaction(STORES, 'readwrite', async (tx) => {
        check(!(await tx.all<Binding>('host_bindings')).some(b => b.scope === scope), '目标聊天已绑定');
        const branch: Branch = { ...row('br'), story: parent.branch.story, head: '', view: '', epoch: 1,
            fork: { branch: parent.branch.id, snapshot: parent.snapshot.id, length: parent.cutoff, anchor: parent.refs.at(-1) ?? null } };
        branch.head = await publishSnapshot(tx, branch, parent.refs);
        const selection: MemoryView = { ...row('mv'), branch: branch.id, selections: {} };
        // Unknown-source legacy summaries are branch-scoped; do not silently inherit them.
        await tx.add('memory_views', selection);
        branch.view = selection.id;
        const binding: Binding = { ...row('hb'), story: branch.story, branch: branch.id, scope, generation: 1, intent: 'fork' };
        await tx.add('host_bindings', binding);
        const parentBindings = await tx.all<Binding>('host_bindings', 'branch', parent.branch.id);
        for (const sourceBinding of parentBindings) {
            for (const mapping of await tx.all<Mapping>('message_mappings', 'owner', sourceBinding.id)) {
                if (parent.refs.some(r => r.message === mapping.message))
                    await tx.add('message_mappings', {
                        ...mapping, ...row('map'), owner: binding.id,
                    });
            }
        }
        await tx.add('branches', branch);
        return branch;
    });
}
