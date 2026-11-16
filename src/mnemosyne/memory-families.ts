import type { Library, Transaction } from './db';
import { sameNarrativeRevision, statusesInTransaction, type HostMemory } from './canonical';
import { check, type Branch, type Snapshot, type SourceRef, type Memory, type MemoryRevision,
    type MemoryView, type Membership, type EventRevision } from './model';

// Disposable read-work memo only. A repair itself publishes an ordinary durable MemoryView.
// Remember only after the outer write commits; an aborted transaction must retry the repair.
const checked = new WeakMap<Library, Map<string, string>>();
export async function resolveMemoryFamilies(lib: Library, tx: Transaction, branch: Branch, snapshot: Snapshot,
    refs: SourceRef[], families: Memory[], previous: MemoryView | undefined, selected: Map<string, MemoryRevision>,
    hosts: HostMemory[], hashes: string[]) {
    const groups = new Map<string, Memory[]>(), byHost = new Map<string, Memory>();
    for (const family of families) {
        const group = groups.get(family.hostId) ?? [];
        group.push(family); groups.set(family.hostId, group);
    }
    for (const [host, group] of groups) {
        const current = group.filter(family => selected.has(family.id));
        check(current.length <= 1, '同一摘要存在多个当前身份，请核对档案');
        // A historical table-only family is not allowed to displace a selected summary.
        // If no selection disambiguates duplicate history, create a fresh current family.
        if (current.length || group.length === 1) byHost.set(host, current[0] ?? group[0]);
    }
    const duplicates = [...groups].filter(([, group]) => group.length > 1);
    if (!branch.fork || !previous || !duplicates.length) return { families: byHost };
    const hostById = new Map(hosts.map(host => [host.hostId, host]));
    const hostHashes = new Map(hosts.map((host, i) => [host.hostId, hashes[i]]));
    const signature = JSON.stringify([duplicates.map(([host, group]) =>
        [host, hostHashes.get(host), group.map(family => [family.id, selected.get(family.id)?.id])])]);
    const remember = () => {
        let cache = checked.get(lib);
        if (!cache) { cache = new Map(); checked.set(lib, cache); }
        cache.delete(branch.id); cache.set(branch.id, signature);
        if (cache.size > 12) cache.delete(cache.keys().next().value!);
    };
    if (checked.get(lib)?.get(branch.id) === signature) return { families: byHost };
    // Only current summary/event references can identify a displaced inherited identity.
    // Table history deliberately does not nominate current summaries.
    const references = new Set([...selected.values()].flatMap(memory => memory.dependencies));
    const [memberships, revisions] = await Promise.all([
        tx.all<Membership>('event_memberships', 'branch', branch.id),
        tx.all<EventRevision>('event_revisions', 'branch', branch.id),
    ]);
    const latest = <T extends { id: string; epoch: number; cutoff: number }>(rows: T[], key: (row: T) => string) => {
        const result = new Map<string, T>();
        for (const row of rows) {
            if (row.cutoff > refs.length) continue;
            const prior = result.get(key(row));
            if (!prior || row.epoch > prior.epoch || row.epoch === prior.epoch && row.id > prior.id) result.set(key(row), row);
        }
        return [...result.values()];
    };
    for (const member of latest(memberships, m => JSON.stringify([m.owner, m.memory])))
        if (member.active) references.add(member.memory);
    for (const revision of latest(revisions, r => r.owner)) {
        for (const id of [...revision.refs, ...(revision.summarized ?? [])]) references.add(id);
        if (revision.latestProgress) references.add(revision.latestProgress.memory);
    }
    const familyById = new Map(families.map(family => [family.id, family]));
    const nominated = new Map<string, Map<string, MemoryRevision>>();
    const selectedIds = new Map([...selected.values()].map(memory => [memory.id, memory]));
    // Read each referenced row once; never scan the branch's entire revision history.
    for (const id of references) {
        const memory = selectedIds.get(id) ?? await tx.get<MemoryRevision>('memory_revisions', id);
        if (!memory || memory.branch !== branch.id || memory.story !== branch.story ||
            !familyById.has(memory.owner) || (groups.get(memory.hostId)?.length ?? 0) < 2 ||
            memory.fingerprint !== hostHashes.get(memory.hostId) || memory.content !== hostById.get(memory.hostId)?.content ||
            memory.level !== hostById.get(memory.hostId)?.level) continue;
        const candidates = nominated.get(memory.hostId) ?? new Map();
        candidates.set(memory.id, memory); nominated.set(memory.hostId, candidates);
    }
    const proposed = new Map<string, MemoryRevision>();
    for (const [host, candidates] of nominated) {
        // Conflicting references are not permission to guess which history is authoritative.
        const values = [...candidates.values()], memory = values[0];
        if (values.some(other => !sameNarrativeRevision(memory, other))) continue;
        const currentFamily = byHost.get(host);
        const current = currentFamily && selected.get(currentFamily.id);
        if (!current || current.owner === memory.owner || current.fingerprint !== hostHashes.get(host) || current.content !== hostById.get(host)?.content) continue;
        proposed.set(host, memory);
    }
    if (proposed.size) {
        const projected = [...selected.values()].map(memory => proposed.get(memory.hostId) ?? memory);
        const validity = await statusesInTransaction(tx, { branch, snapshot, refs, cutoff: refs.length, memories: projected });
        for (const [host, memory] of proposed) {
            if (validity.get(memory.id) !== 'valid') continue;
            selected.delete(byHost.get(host)!.id);
            selected.set(memory.owner, memory);
            byHost.set(host, familyById.get(memory.owner)!);
        }
    }
    return { families: byHost, remember };
}
