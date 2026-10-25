import { readSource, snapshotVariants, retireCurrentBodies } from './current-body';
import { ensureTableHistory, reconcileTableHistory, inheritTableHistory } from './table-history';
import { eventView } from './events';
import { unlinkDeletedEventSources, eventSourcesChecked } from './event-source-sync';
import { inheritForkMemory } from './fork-memory';
import type { SummaryTags } from '@/memory/contextTags';
import { sourceRefMatches, sourceRefsMatch } from './source-equivalence';
import { sourcePrefixes } from './source-prefixes';
import { observationHashes } from './observation-hashes';
import { publishMemoryView } from './memory-selections';
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
    type CurrentRevision,
    type SourceBody,
} from './model';
export interface HostMessage {
    key: string;
    role: Revision['role'];
    content: string;
    swipe: number;
    excluded?: boolean;
}
export interface HostMemory {
    tags?: SummaryTags;
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
/** Metadata edits do not change a narrative dependency. Source/version fields must all match. */
export function sameNarrativeRevision(a: MemoryRevision, b: MemoryRevision): boolean {
    const narrative = ({ id, fingerprint, tags, ...rest }: MemoryRevision) => rest;
    return equal(narrative(a), narrative(b));
}
/** A high summary with recorded children depends on those children, not the entire chat tail. */
export const dependencyOnly = (m: MemoryRevision) => m.level > 0 && !m.anchor && !m.inputRefs.length && !!m.dependencies.length;
export async function summarySources(tx: Transaction, memory: MemoryRevision): Promise<SourceRef[]> {
    check(!memory.sourceRecovery, '旧核心包缺少这条摘要的生成来源；请核对当前正文后手动确认或重新生成，不可直接保留');
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
/** Hash before the write transaction: exact tag-only host edits retain all selected provenance. */
async function tagOnlyRevisions(lib: Library, observation: HostObservation) {
    const selected = await lib.transaction(['host_bindings', 'branches', 'memory_views', 'memory_revisions'], 'readonly', async tx => {
        const binding = (await tx.all<Binding>('host_bindings')).find(b => !b.detached && b.scope === observation.scope);
        const branch = binding && await tx.get<Branch>('branches', binding.branch);
        const selection = branch?.view && await tx.get<MemoryView>('memory_views', branch.view);
        return selection ? await Promise.all(Object.values(selection.selections).map(id => tx.get<MemoryRevision>('memory_revisions', id))) : [];
    });
    const byHost = new Map(selected.filter((m): m is MemoryRevision => !!m).map(m => [m.hostId, m]));
    const matches = await Promise.all(observation.memories.map(async host => {
        const prior = byHost.get(host.hostId);
        if (!prior || prior.level !== 0 || prior.dependencies.length || equal(prior.tags, host.tags)) return null;
        // Production observations place optional tags after content. Preserve an existing slot,
        // and support caller-built observations that placed that optional property at the end.
        const entries = Object.entries(host).filter(([key]) => key !== 'tags');
        const at = Object.keys(host).indexOf('tags');
        const positions = at >= 0 ? [at] : [entries.findIndex(([key]) => key === 'content') + 1, entries.length];
        const candidates = prior.tags === undefined ? [Object.fromEntries(entries)] : positions.map(position => {
            const restored = entries.slice(); restored.splice(position, 0, ['tags', prior.tags]);
            return Object.fromEntries(restored);
        });
        return (await Promise.all(candidates.map(fingerprint))).includes(prior.fingerprint) ? prior : null;
    }));
    return new Map(matches.filter((m): m is MemoryRevision => !!m).map(m => [m.hostId, m]));
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
async function publishSnapshot(tx: Transaction, branch: Branch, refs: SourceRef[], variants?: number[], before?: {
    snapshot?: Snapshot; refs: SourceRef[]; variants: number[];
}): Promise<Snapshot> {
    const prior = before ? before.snapshot : branch.head ? await tx.get<Snapshot>('history_snapshots', branch.head) : undefined;
    const old = before ? before.refs : prior ? await snapshotRefs(tx, prior) : [];
    const oldVariants = before ? before.variants : prior ? await snapshotVariants(tx, prior) : [];
    const nextVariants = variants ?? Array(refs.length).fill(0);
    if (prior && equal(old, refs) && equal(oldVariants, nextVariants)) return prior;
    if (prior && prior.snapshotSchema !== 2 && !branch.legacyHead) branch.legacyHead = prior.id;
    const blocks: string[] = [];
    // Reuse unchanged 128-reference blocks; appends do not copy entire histories.
    for (let offset = 0; offset < refs.length; offset += 128) {
        const entries = refs.slice(offset, offset + 128);
        if (prior?.snapshotSchema === 2 && equal(entries, old.slice(offset, offset + 128)) &&
            equal(nextVariants.slice(offset, offset + 128), oldVariants.slice(offset, offset + 128))) blocks.push(prior.blocks[offset / 128]);
        else {
            const block: Block = { ...row('hm'), story: branch.story, owner: `current:${branch.id}`, entries, variants: nextVariants.slice(offset, offset + 128) };
            await tx.add('manifest_blocks', block);
            blocks.push(block.id);
        }
    }
    const snapshot: Snapshot = {
        ...row('hs'),
        story: branch.story,
        branch: branch.id,
        snapshotSchema: 2,
        owner: `current:${branch.id}`,
        previous: null,
        blocks,
        length: refs.length,
        created: Date.now(),

    };
    await tx.add('history_snapshots', snapshot);
    return snapshot;
}
export async function synchronize(lib: Library, observation: HostObservation, baseline?: { branch?: Branch; binding?: Binding; isCurrent(): boolean },
    onCaptured?: (view: CapturedView) => void): Promise<Branch> {
    check(
        observation.scope && new Set(observation.messages.map((m) => m.key)).size === observation.messages.length,
        '消息映射身份重复，需要人工核对',
    );
    const { hashes, bodyHashes, memoryHashes } = await observationHashes(lib, observation);
    const tagUpdates = await tagOnlyRevisions(lib, observation);
    let removedEventSources = new Set<string>();
    let captured: CapturedView | undefined;
    const synchronized = await lib.transaction(STORES, 'readwrite', async (tx) => {
        if (baseline?.branch) {
            const live = await tx.get<Branch>('branches', baseline.branch.id);
            check(live && live.head === baseline.branch.head && live.view === baseline.branch.view &&
                live.epoch === baseline.branch.epoch && baseline.isCurrent(), '归档校验后档案或聊天已变化，请重试');
        }
        const bindings = await tx.all<Binding>('host_bindings');
        let binding = bindings.find((b) => !b.detached && b.scope === observation.scope);
        if (baseline) check(JSON.stringify(binding) === JSON.stringify(baseline.binding),
            '归档校验后绑定已变化，未应用删除');
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
        const priorVariants = priorSnapshot ? await snapshotVariants(tx, priorSnapshot) : [];
        const priorSources = new Map(
            (await Promise.all(priorRefs.map((r) => tx.get<Revision>('source_revisions', r.revision))))
                .filter((r): r is Revision => !!r)
                .map((r) => [r.owner, r]),
        );
        const refs: SourceRef[] = [];
        const byHost = new Map<string, SourceRef>();
        const captureRevisions = onCaptured ? new Map<string, Revision>() : undefined;
        const writtenBodies = onCaptured ? new Map<string, string>() : undefined;
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
                (revision.bodySchema === 1 ? revision.bodyHash !== bodyHashes[i] || revision.bodyLength !== host.content.length : revision.content !== host.content) ||
                revision.role !== host.role
            ) {
                const history = await tx.all<Revision>('source_revisions', 'owner', mapping.message);
                revision = history.find(
                    (r) => r.story === branch.story && r.owner === mapping.message && r.provenance.hostKey === host.key &&
                        r.fingerprint === hashes[i] && r.role === host.role && (r.bodySchema === 1
                            ? r.bodyHash === bodyHashes[i] && r.bodyLength === host.content.length : r.content === host.content),
                );
            }
            if (!revision) {
                revision = {
                    ...row('rev'),
                    story: branch.story,
                    owner: mapping.message,
                    role: host.role,
                    bodySchema: 1,
                    bodyHash: bodyHashes[i],
                    bodyLength: host.content.length,
                    fingerprint: hashes[i],
                    provenance: { binding: binding.id, hostKey: host.key, index: i, swipe: host.swipe },
                };
                await tx.add('source_revisions', revision);
            }
            if (revision.bodySchema === 1 && priorSources.get(mapping.message)?.id !== revision.id) {
                await tx.put('source_bodies', { id: revision.id, schema: 1,
                    story: branch.story, owner: mapping.message, content: host.content } as SourceBody);
                writtenBodies?.set(revision.id, host.content);
            }
            captureRevisions?.set(revision.id, revision);
            const ref = { message: mapping.message, revision: revision.id };
            refs.push(ref);
            byHost.set(host.key, ref);
        }
        const oldHead = branch.head;
        if (oldHead) await ensureTableHistory(tx, branch);
        const variants = observation.messages.map(m => m.swipe);
        const snapshot = await publishSnapshot(tx, branch, refs, variants,
            { snapshot: priorSnapshot, refs: priorRefs, variants: priorVariants });
        branch.head = snapshot.id;
        if (!oldHead) await ensureTableHistory(tx, branch);
        else if (oldHead !== branch.head) await reconcileTableHistory(tx, branch, refs, variants);
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
        const selectionRevisions = new Map<string, MemoryRevision>();
        const hostRevisions = new Map<string, string>();
        const newRevisions: {
            revision: MemoryRevision;
            host: HostMemory;
        }[] = [];
        const sidecars: { revision: MemoryRevision; host: HostMemory }[] = [];
        let recovered = false;
        const bases = new Map<string, Snapshot | undefined>();
        const readBasis = async (id: string) => {
            if (!bases.has(id)) bases.set(id, await tx.get<Snapshot>('history_snapshots', id));
            return bases.get(id);
        };
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
            if (revision && revision.fingerprint !== memoryHashes[i] && tagUpdates.get(host.hostId)?.id === revision.id) {
                // Prefer the exact selected provenance over an older same-host-fingerprint row.
                // Retagging back must not randomly select the original quarantined revision.
                revision = undefined;
            } else if (!revision || revision.fingerprint !== memoryHashes[i]) {
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
                    ...(host.tags ? { tags: host.tags } : {}),
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
                if (prior && tagUpdates.get(host.hostId)?.id === prior.id) {
                    const { tags, ...original } = prior;
                    revision = { ...original, id: revision.id, fingerprint: memoryHashes[i],
                        ...(host.tags ? { tags: host.tags } : {}) };
                }
                else if (host.manualEdit && prior && !host.inputRefs) {
                    // A manual save explicitly confirms applicability to the currently displayed
                    // prefix. It does not recreate the lost generation evidence on the old revision.
                    const sources = prior.sourceRecovery
                        ? refs.slice(0, anchor ? refs.findIndex(r => r.message === anchor) + 1 : refs.length)
                        : await summarySources(tx, prior);
                    const updated = sources.map(r => refs.find(v => v.message === r.message));
                    if (updated.every((r): r is SourceRef => !!r)) {
                        revision.inputRefs = updated;
                        revision.coverage = prior.sourceRecovery ? [] : prior.coverage.map(r => refs.find(v => v.message === r.message)!).filter(Boolean);
                        revision.declaration = prior.sourceRecovery
                            ? '人工核对恢复摘要：确认适用于当前楼层及此前正文；旧生成来源仍缺失，原摘要与来源声明保留。'
                            : '人工修订摘要：以当前来源版本确认内容；原生成版本保留。';
                        // Preserve recorded dependency identities, selecting their current version below.
                        if (!host.children.length) host = { ...host, children: await Promise.all(prior.dependencies.map(async id => {
                            const dependency = await tx.get<MemoryRevision>('memory_revisions', id);
                            check(dependency, '原摘要依赖缺失');
                            return dependency.hostId;
                        })) };
                    }
                }
                // Editing tags must not silently approve a changed source or renew an old basis.
                if (prior && !equal(prior.tags, revision.tags) && sameNarrativeRevision(prior, { ...revision, basis: prior.basis }))
                    revision.basis = prior.basis;
                newRevisions.push({ revision, host });
            }
            if (host.basisSnapshot === revision.basis && !revision.sourceRecovery &&
                !(await readBasis(revision.basis))) {
                revision = { ...revision, sourceRecovery: { version: 1, reason: 'missing_basis', snapshot: branch.head } };
                // Newly built revisions are inserted below; existing poisoned identities are
                // repaired in place so events and historical selections keep their references.
                const pending = newRevisions.find(item => item.revision.id === revision!.id);
                if (pending) pending.revision = revision;
                else { await tx.put('memory_revisions', revision); recovered = true; }
            }
            if (!revision.sourceRecovery && host.generatedSidecar && host.inputRefs?.some(ref => !refs.some(r => equal(r, ref))) &&
                host.inputRefs.every(ref => ref.message === revision!.anchor || refs.some(r => equal(r, ref))))
                sidecars.push({ revision, host });
            selections[family.id] = revision.id;
            selectionRevisions.set(revision.id, revision);
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
        // Current-source eligibility must hold on every reconciliation: otherwise
        // host higher summaries could resurrect a deleted floor on the next append.
        // Check message identities only, never revision equality (swipes keep their
        // historical review semantics). All immutable rows/sibling views survive.
        const currentMessages = new Set(refs.map(ref => ref.message));
        // Mapping identities survive ordinary source deletion. Only their absence
        // from the head proves removal from THIS binding; declared missing-basis
        // recovery refs may never have existed locally and must remain reviewable.
        const observedMessages = new Set(maps.map(mapping => mapping.message));
        const removedMessage = (message: string) => observedMessages.has(message) && !currentMessages.has(message);
        const affected = new Map<string, boolean>();
        const visiting = new Set<string>();
        const hasMissingSource = async (id: string): Promise<boolean> => {
            if (affected.has(id)) return affected.get(id)!;
            check(!visiting.has(id), '摘要依赖存在循环，删除归档已停止');
            visiting.add(id);
            const revision = selectionRevisions.get(id) ?? await tx.get<MemoryRevision>('memory_revisions', id);
            check(revision, '删除归档的摘要依赖缺失');
            let removed = !!revision.anchor && removedMessage(revision.anchor) ||
                [...revision.inputRefs, ...revision.coverage].some(ref => removedMessage(ref.message));
            if (!removed) for (const dependency of revision.dependencies) {
                if (await hasMissingSource(dependency)) { removed = true; break; }
            }
            visiting.delete(id); affected.set(id, removed); return removed;
        };
        for (const [family, id] of Object.entries(selections)) if (await hasMissingSource(id)) delete selections[family];
        removedEventSources = new Set([...observedMessages].filter(removedMessage));
        const eventsChanged = await unlinkDeletedEventSources(lib, tx, branch, removedEventSources, refs.length);
        let selection = previous;
        if (!previous || !equal(previous.selections, selections)) {
            const view: MemoryView = { ...row('mv'), branch: branch.id, selections };
            await publishMemoryView(tx, view, previous);
            branch.view = view.id;
            selection = view;
        }
        // Repair only this branch's summary metadata, including previously committed unselected
        // revisions. No source text is scanned, and no missing historical record is invented.
        const hostProofs = new Map<string, HostMemory[]>();
        for (const host of observation.memories) if (host.basisSnapshot) {
            // A present basis cannot require missing-basis repair. Check the small
            // snapshot record first, before looking at any historical summary rows.
            if (!(await readBasis(host.basisSnapshot))) hostProofs.set(host.hostId, [...(hostProofs.get(host.hostId) ?? []), host]);
        }
        // The physical index is exact and stays current across connections/imports.
        // No cached "repair complete" flag can hide a newly arrived old revision.
        const history = (await Promise.all([...hostProofs.keys()].map(hostId =>
            tx.all<MemoryRevision>('memory_revisions', 'branch_host', [branch.id, hostId])))).flat();
        for (const memory of history) {
            if (memory.sourceRecovery) continue;
            if (!hostProofs.get(memory.hostId)?.some(host => host.basisSnapshot === memory.basis &&
                equal(host.inputRefs ?? [], memory.inputRefs) && equal(host.coverage ?? [], memory.coverage))) continue;
            if (!bases.has(memory.basis)) bases.set(memory.basis, await tx.get<Snapshot>('history_snapshots', memory.basis));
            if (bases.get(memory.basis)) continue;
            const repaired = { ...memory,
                sourceRecovery: { version: 1, reason: 'missing_basis', snapshot: branch.head } } as MemoryRevision;
            await tx.put('memory_revisions', repaired);
            if (selectionRevisions.has(memory.id)) selectionRevisions.set(memory.id, repaired);
            recovered = true;
        }
        if (oldHead !== branch.head || previous?.id !== branch.view || recovered || eventsChanged) branch.epoch++;
        await tx.put('branches', branch);
        if (oldHead !== branch.head) await retireCurrentBodies(tx, branch, priorRefs, {
            refs, memories: [...selectionRevisions.values()],
        });
        if (onCaptured) {
            // Reuse descriptors and selected revisions already read in this transaction.
            // Existing bodies are still read and validated once: host observation text
            // is not evidence that its stored payload exists or has the right identity.
            const sources = await Promise.all(refs.map(async ref => {
                const source = captureRevisions!.get(ref.revision)!;
                if (source.bodySchema !== 1) {
                    check(typeof source.content === 'string', '当前正文版本缺失');
                    return source as CurrentRevision;
                }
                if (writtenBodies!.has(source.id)) return { ...source, content: writtenBodies!.get(source.id)! };
                const body = await tx.get<SourceBody>('source_bodies', source.id);
                check(body, '当前正文版本缺失');
                check(body.owner === source.owner && body.story === source.story && body.content.length === source.bodyLength,
                    '当前正文与来源身份不一致');
                return { ...source, content: body.content };
            }));
            check(selection, '摘要视图缺失');
            captured = { branch, snapshot: { ...snapshot, variants }, refs, selection,
                sources: new Map(sources.map(source => [source.id, source])),
                memories: Object.values(selection.selections).map(id => selectionRevisions.get(id)!), cutoff: refs.length };
        }
        if (baseline) check(baseline.isCurrent(), '删除归档期间聊天已变化，本次事务回滚');
        return branch;
    });
    eventSourcesChecked(lib, synchronized, removedEventSources);
    if (captured) onCaptured!(captured);
    return synchronized;
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
            Promise.all(refs.slice(0, length).map((ref) => readSource(tx, ref.revision))),
            Promise.all(
                Object.values(selection.selections).map((key) => tx.get<MemoryRevision>('memory_revisions', key)),
            ),
        ]);
        check(sourceRows.every(Boolean), snapshot.id === branch.head ? '当前正文版本缺失' : '此历史版本的正文未保留；请选择当前分支正文');
        check(memoryRows.every(Boolean), '摘要版本缺失');
        const sources = new Map(sourceRows.map((r) => [r!.id, r!]));
        const memories = memoryRows as MemoryRevision[];
        return { branch, snapshot: { ...snapshot, variants: await snapshotVariants(tx, snapshot) }, refs: refs.slice(0, length), selection, sources, memories, cutoff: length };
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
    return lib.transaction(['history_snapshots', 'manifest_blocks', 'reviews', 'memory_revisions'], 'readonly', async (tx) => {
        const snapshots = await Promise.all(
            [...new Set(view.memories.filter(m => !m.sourceRecovery).map((m) => m.basis))].map((key) => tx.get<Snapshot>('history_snapshots', key)),
        );
        check(snapshots.every(Boolean), '摘要基线缺失');
        const unknownBases = new Set(view.memories.filter((m) => !m.sourceRecovery && !m.inputRefs.length && !dependencyOnly(m)).map((m) => m.basis));
        const legacySnapshots = snapshots.filter((s) => unknownBases.has(s!.id));
        const blocks = await Promise.all(
            [...new Set(legacySnapshots.flatMap((s) => s!.blocks))].map((key) => tx.get<Block>('manifest_blocks', key)),
        );
        check(blocks.every(Boolean), '缺少历史清单块');
        const positions = new Map(view.refs.map((r, i) => [r.message, i]));
        const refByMessage = new Map(view.refs.map((r) => [r.message, r]));
        const bases = sourcePrefixes(view.branch, view.refs, legacySnapshots as Snapshot[], blocks as Block[]);
        const reviews = await tx.all<Review>('reviews', 'branch', view.branch.id);
        const compatible = new Map<string, Review>();
        const selectedById = new Map(view.memories.map(m => [m.id, m]));
        const selectedByOwner = new Map(view.memories.map(m => [m.owner, m]));
        const equivalent = new Map<string, MemoryRevision | undefined>();
        const resolveSelected = async (id: string) => {
            if (equivalent.has(id)) return equivalent.get(id);
            let memory = selectedById.get(id);
            if (!memory) {
                const prior = await tx.get<MemoryRevision>('memory_revisions', id);
                const selected = prior && selectedByOwner.get(prior.owner);
                if (prior && selected && sameNarrativeRevision(prior, selected)) memory = selected;
            }
            equivalent.set(id, memory);
            return memory;
        };
        for (const review of reviews.sort((a,b) => a.created - b.created)) {
            const memory = await resolveSelected(review.owner);
            if (!memory) continue;
            if (review.reviewSchema !== 2) {
                if (view.cutoff === view.snapshot.length && review.snapshot === view.snapshot.id) compatible.set(memory.id, review);
                continue;
            }
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
            compatible.set(memory.id, review);
        }
        const byId = new Map(selectedById);
        const deps = new Set(view.memories.flatMap(m => compatible.get(m.id)?.dependencies ?? m.dependencies));
        for (const id of deps) {
            if (byId.has(id)) continue;
            const selected = await resolveSelected(id);
            if (selected) byId.set(id, selected);
        }
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
            else if (memory.sourceRecovery) status = 'needs_review';
            else {
                const basis = bases.get(memory.basis)!;
                const requiredLength = memory.inputRefs.length || dependencyOnly(memory)
                    ? 0
                    : memory.anchor
                      ? basis.through(memory.anchor)
                      : basis.length;
                if (
                    !compatible.has(memory.id) &&
                    (memory.inputRefs.length
                        ? memory.inputRefs.some((r) => !sourceRefMatches(view.branch, r, refByMessage.get(r.message)))
                        : !dependencyOnly(memory) && basis.prefix < requiredLength)
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
/** A new human applicability decision for current L0 summaries; original evidence stays immutable. */
export async function confirmRecoveredSummaries(lib: Library, view: CapturedView, memoryIds: string[], guard: () => boolean = () => true) {
    check(view.snapshot.id === view.branch.head && view.cutoff === view.snapshot.length, '只能确认当前完整档案');
    const requested = new Set(memoryIds), byId = new Map(view.memories.map(m => [m.id, m]));
    const positions = new Map(view.refs.map((r, i) => [r.message, i]));
    check(requested.size && requested.size === memoryIds.length, '请选择不重复的摘要');
    const memories = memoryIds.map(id => byId.get(id));
    check(memories.every((m): m is MemoryRevision => !!m && m.level === 0 &&
        m.recall && m.visibility === 'public' && !!m.content.trim() &&
        !!m.anchor && positions.has(m.anchor) &&
        view.sources.get(view.refs[positions.get(m.anchor)!].revision)?.role === 'assistant'),
    '只能人工确认当前已映射、可用的 L0 摘要；其他摘要需分别处理');
    check(new Set(memories.map(m => m.owner)).size === memories.length &&
        new Set(memories.map(m => m.anchor)).size === memories.length, '摘要映射重复，请先核对');
    return lib.transaction(STORES, 'readwrite', async tx => {
        const branch = await tx.get<Branch>('branches', view.branch.id);
        check(guard() && branch && branch.epoch === view.branch.epoch && branch.head === view.snapshot.id &&
            branch.view === view.selection.id, '视图已改变，请刷新后重新确认');
        const [snapshot, selection, stored] = await Promise.all([
            tx.get<Snapshot>('history_snapshots', branch.head),
            tx.get<MemoryView>('memory_views', branch.view),
            Promise.all(memories.map(m => tx.get<MemoryRevision>('memory_revisions', m.id))),
        ]);
        check(snapshot && selection && equal(await snapshotRefs(tx, snapshot), view.refs) &&
            stored.every((m, i) => equal(m, memories[i]) && selection.selections[memories[i].owner] === m!.id),
        '摘要或正文已改变，请刷新后重新确认');
        const revisions = memories.map(memory => {
            const { sourceRecovery, ...original } = memory;
            return { ...original, ...row('mr'), basis: snapshot.id,
                // The shared fixed snapshot plus this anchor is the exact manual applicability
                // prefix. Human confirmation uses current bodies independently of the old
                // generated summary dependencies, which remain intact on the old revision.
                inputRefs: [], coverage: [], dependencies: [],
                declaration: sourceRecovery
                    ? `人工核对恢复摘要：仅以当前楼层及此前正文为人工确认依据；旧生成来源仍缺失，原摘要、摘要依赖与来源声明保留（${memory.id}）。`
                    : `人工核对现有摘要：仅以当前楼层及此前正文为人工确认依据；原摘要、生成基线与来源声明保留，旧摘要依赖保留（${memory.id}）。`,
            } satisfies MemoryRevision;
        });
        // Retain the unchanged host fingerprint. A subsequent host observation must prefer this
        // selected manual revision, without rewriting the host text, sidecar or original evidence.
        const next: MemoryView = { ...row('mv'), branch: branch.id, selections: { ...selection.selections } };
        for (const revision of revisions) next.selections[revision.owner] = revision.id;
        await Promise.all(revisions.map(revision => tx.add('memory_revisions', revision)));
        await publishMemoryView(tx, next, selection);
        branch.view = next.id;
        branch.epoch++;
        await tx.put('branches', branch);
        // One final live-host check for the whole batch, still inside the abortable transaction.
        check(guard(), '视图已改变，未保存本次确认；请刷新后重新确认');
        return revisions;
    });
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
    const events = await eventView(lib, parent, true);
    return lib.transaction(STORES, 'readwrite', async (tx) => {
        const liveParent = await tx.get<Branch>('branches', parent.branch.id);
        check(equal(liveParent, parent.branch), '父分支已改变，请重新选择分支');
        const [sources, chains] = await Promise.all([
            Promise.all(parent.refs.map(async ref => !!await readSource(tx, ref.revision))),
            Promise.all(events.cards.map(card => tx.get('event_chains', card.chain.id))),
        ]);
        check(sources.every(Boolean), '分叉来源正文已不再保留，请重新选择当前分支');
        check(chains.every((chain, index) => equal(chain, events.cards[index].chain)), '父事件已改变，请重新选择分支');
        check(guard(), '聊天已改变，请重新选择分支');
        check(!(await tx.all<Binding>('host_bindings')).some((b) => !b.detached && b.scope === scope), '目标聊天已绑定');
        const branch: Branch = {
            ...row('br'),
            story: parent.branch.story,
            head: '',
            view: '',
            // Inherited event history retains its ordering; later child edits follow it.
            epoch: parent.branch.epoch + 1,
            fork: {
                branch: parent.branch.id,
                snapshot: parent.snapshot.id,
                length: parent.cutoff,
                anchor: parent.refs.at(-1) ?? null,
            },
        };
        branch.head = (await publishSnapshot(tx, branch, parent.refs, parent.snapshot.variants?.slice(0, parent.cutoff))).id;
        const selection: MemoryView = { ...row('mv'), branch: branch.id, selections: {} };

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
        const parentMessages = new Set(parent.refs.map(ref => ref.message));
        for (const sourceBinding of parentBindings) {
            for (const mapping of await tx.all<Mapping>('message_mappings', 'owner', sourceBinding.id)) {
                if (parentMessages.has(mapping.message))
                    await tx.add('message_mappings', {
                        ...mapping,
                        ...row('map'),
                        owner: binding.id,
                    });
            }
        }
        const mapMemory = await inheritForkMemory(tx, parent, branch, binding, selection, events);
        await inheritTableHistory(tx, liveParent!, branch, parent.refs, parent.snapshot.variants?.slice(0, parent.cutoff), mapMemory);
        await publishMemoryView(tx, selection);
        await tx.add('branches', branch);
        check(guard(), '聊天已改变，本次分叉已撤销');
        return branch;
    });
}
