import type { Library } from './db';
import type { HostObservation } from './canonical';
import { check, type Binding, type Branch, type Snapshot, type Block, type Mapping, type Revision, type CapturedView } from './model';

/** Metadata-only probe; ordinary appends/edits do not export a full package. */
export async function deletionBeforeSync(lib: Library, input: HostObservation, cached?: CapturedView): Promise<{ branch: Branch; binding: Binding; needsProtection: boolean } | undefined> {
    return lib.transaction(['host_bindings', 'branches', 'history_snapshots', 'manifest_blocks', 'message_mappings', 'source_revisions'], 'readonly', async tx => {
        const binding = (await tx.all<Binding>('host_bindings')).find(b => !b.detached && b.scope === input.scope);
        if (!binding) return;
        const branch = await tx.get<Branch>('branches', binding.branch);
        check(branch, '删除保护：绑定分支缺失');
        const snapshot = await tx.get<Snapshot>('history_snapshots', branch.head);
        check(snapshot, '删除保护：当前快照缺失');
        const refs = (await Promise.all(snapshot.blocks.map(id => tx.get<Block>('manifest_blocks', id))))
            .flatMap(block => { check(block, '删除保护：来源块缺失'); return block.entries; });
        const mappings = new Map((await tx.all<Mapping>('message_mappings', 'owner', binding.id)).map(m => [m.message, m.hostKey]));
        const incoming = new Map(input.messages.map(m => [m.key, m]));
        let loss = false, survivors = 0;
        for (const ref of refs) {
            const key = mappings.get(ref.message); check(key, '删除保护：当前消息映射缺失');
            if (incoming.has(key)) survivors++; else loss = true;
        }
        if (!loss) {
            // Reuse immutable source descriptors from the already-validated bridge
            // view only when its head still matches this transaction. Cold starts
            // batch IndexedDB requests rather than await one round trip per floor.
            const cachedSources = cached?.branch.id === branch.id && cached.snapshot.id === branch.head ? cached.sources : undefined;
            const sources = await Promise.all(refs.map(ref => cachedSources?.get(ref.revision) ?? tx.get<Revision>('source_revisions', ref.revision)));
            for (let i = 0; i < refs.length; i++) {
                const source = sources[i]; check(source, '删除保护：当前正文描述缺失');
                const next = incoming.get(mappings.get(refs[i].message)!)!;
                const length = source.bodySchema === 1 ? source.bodyLength! : source.content!.length;
                // A shorter swipe is an alternate version, not a deletion notification.
                if (next.swipe === source.provenance.swipe && next.content.length < length) { loss = true; break; }
            }
        }
        if (!loss) return { branch, binding, needsProtection: false };
        check(input.messages.length > 0 && survivors > 0,
            '当前聊天为空或全部消息身份已改变，无法确认正常删除；保留原档案，请核对来源后重试');
        return { branch, binding, needsProtection: true };
    });
}
