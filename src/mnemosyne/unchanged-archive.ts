import type { HostObservation } from './canonical';
import { snapshotRefs } from './canonical';
import { readSource, snapshotVariants } from './current-body';
import { request, type Library } from './db';
import { observationHashes } from './observation-hashes';
import { check, equal, type Binding, type Branch, type CapturedView, type Mapping,
    type Memory, type MemoryRevision, type MemoryView, type Snapshot } from './model';

/** Cold-open hydration only. A saved marker is a hint to attempt exact comparison,
 * never proof by itself. Read the current branch once without replaying host saves,
 * canonical writes or retention scans. Any real change takes normal synchronization. */
export async function readUnchangedArchive(lib: Library, input: HostObservation, expected: Binding,
    savedHead: string, guard: () => boolean): Promise<CapturedView | undefined> {
    const { hashes, bodyHashes, memoryHashes } = await observationHashes(lib, input);
    check(guard(), '聊天在读取档案期间改变');
    return lib.transaction(['host_bindings', 'branches', 'message_mappings', 'history_snapshots', 'manifest_blocks',
        'source_revisions', 'source_bodies', 'memories', 'memory_views', 'memory_revisions'], 'readonly', async tx => {
        const binding = await tx.get<Binding>('host_bindings', expected.id);
        if (!binding || !equal(binding, expected) || binding.detached || binding.scope !== input.scope) return;
        const branch = await tx.get<Branch>('branches', binding.branch);
        if (!branch || branch.head !== savedHead || !branch.tableHead) return;
        const snapshot = await tx.get<Snapshot>('history_snapshots', branch.head);
        check(snapshot?.branch === branch.id, '当前档案快照缺失或归属不符');
        if (snapshot.length !== input.messages.length) return;
        const [refs, variants, mappings, selection, families] = await Promise.all([
            snapshotRefs(tx, snapshot), snapshotVariants(tx, snapshot),
            tx.all<Mapping>('message_mappings', 'owner', binding.id),
            tx.get<MemoryView>('memory_views', branch.view),
            tx.all<Memory>('memories', 'owner', binding.id),
        ]);
        check(selection?.branch === branch.id, '当前摘要视图缺失或归属不符');
        const keys = new Map(mappings.map(m => [m.message, m.hostKey]));
        if (new Set(input.messages.map(m => m.key)).size !== input.messages.length ||
            refs.some((ref, i) => keys.get(ref.message) !== input.messages[i].key || variants[i] !== input.messages[i].swipe)) return;
        const ids = Object.values(selection.selections);
        if (ids.length !== input.memories.length) return;
        const memories = await Promise.all(ids.map(id => tx.get<MemoryRevision>('memory_revisions', id)));
        check(memories.every((m): m is MemoryRevision => !!m), '当前摘要版本缺失');
        const byHost = new Map(memories.map(m => [m.hostId, m]));
        const familyByHost = new Map(families.map(m => [m.hostId, m]));
        // Legacy duplicate-family repair and missing-source recovery still need
        // the canonical writer, even when a host fingerprint happens to match.
        if (familyByHost.size !== families.length || byHost.size !== memories.length ||
            new Set(input.memories.map(m => m.hostId)).size !== input.memories.length ||
            input.memories.some((host, i) => {
                const memory = byHost.get(host.hostId), family = familyByHost.get(host.hostId);
                if (!memory || memory.sourceRecovery || host.basisSnapshot && host.basisSnapshot !== memory.basis ||
                    memory.branch !== branch.id || memory.story !== branch.story ||
                    memory.owner !== family?.id || selection.selections[memory.owner] !== memory.id || memory.fingerprint !== memoryHashes[i]) return true;
                check(memory.content === host.content, '当前摘要内容与版本校验不一致');
                return false;
            })) return;
        // Old restores can leave a matching summary without its missing-basis
        // declaration. Only the canonical writer may repair that host evidence
        // and its matching history. Probe distinct keys, not historical payloads.
        const bases = [...new Set(input.memories.flatMap(memory =>
            memory.basisSnapshot && memory.basisSnapshot !== snapshot.id ? [memory.basisSnapshot] : []))];
        const basisKeys = await Promise.all(bases.map(key => request(tx.native.objectStore('history_snapshots').getKey(key))));
        if (basisKeys.some(key => key === undefined)) return;
        const sources = await Promise.all(refs.map(ref => readSource(tx, ref.revision)));
        check(sources.every(Boolean), '当前正文版本缺失');
        for (const [i, source] of sources.entries()) {
            const host = input.messages[i];
            check(source!.story === branch.story && source!.owner === refs[i].message, '当前正文与来源身份不一致');
            if (source!.fingerprint !== hashes[i] || source!.role !== host.role) return;
            // A matching descriptor must never hide a missing/corrupted payload.
            check(source!.content === host.content && (source!.bodySchema !== 1 || source!.bodyHash === bodyHashes[i]),
                '当前正文内容与来源校验不一致');
        }
        check(guard(), '聊天在读取档案期间改变');
        return { branch, snapshot: { ...snapshot, variants }, refs, selection, memories,
            sources: new Map(sources.map(source => [source!.id, source!])), cutoff: refs.length };
    });
}
