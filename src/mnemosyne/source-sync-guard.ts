import type { Library } from './db';
import type { HostObservation } from './canonical';
import { check, type Binding, type Branch, type Snapshot, type Block, type Mapping } from './model';

/** Validate source identity and capture a CAS token, independently of disk backups. */
export async function sourceSyncBaseline(lib: Library, input: HostObservation): Promise<{ branch: Branch; binding: Binding } | undefined> {
    return lib.transaction(['host_bindings', 'branches', 'history_snapshots', 'manifest_blocks', 'message_mappings'], 'readonly', async tx => {
        const binding = (await tx.all<Binding>('host_bindings')).find(b => !b.detached && b.scope === input.scope);
        if (!binding) return;
        const branch = await tx.get<Branch>('branches', binding.branch);
        check(branch, '归档校验：绑定分支缺失');
        const snapshot = await tx.get<Snapshot>('history_snapshots', branch.head);
        check(snapshot, '归档校验：当前快照缺失');
        const refs = (await Promise.all(snapshot.blocks.map(id => tx.get<Block>('manifest_blocks', id))))
            .flatMap(block => { check(block, '归档校验：来源块缺失'); return block.entries; });
        const mappings = new Map((await tx.all<Mapping>('message_mappings', 'owner', binding.id)).map(m => [m.message, m.hostKey]));
        const incoming = new Map(input.messages.map(m => [m.key, m]));
        let loss = false, survivors = 0;
        for (const ref of refs) {
            const key = mappings.get(ref.message); check(key, '归档校验：当前消息映射缺失');
            if (incoming.has(key)) survivors++; else loss = true;
        }
        if (!loss) return { branch, binding };
        check(input.messages.length > 0 && survivors > 0,
            '当前聊天为空或全部消息身份已改变，无法确认正常删除；保留原档案，请核对来源后重试');
        return { branch, binding };
    });
}
