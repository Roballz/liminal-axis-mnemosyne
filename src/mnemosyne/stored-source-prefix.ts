// A physical encoding only. Existing logical readers still see the original ordered
// inputs, even for a real batch whose source list happens to equal a snapshot prefix.
import { check, type Block, type MemoryRevision, type Row, type Snapshot, type SourceRef } from './model';

export const RECOVERED_MANUAL_PREFIX = '人工核对恢复摘要：确认适用于当前楼层及此前正文；旧生成来源仍缺失，原摘要与来源声明保留。';
export const prefixEncoded = (row: Row) => (row as { sharedSchema?: number }).sharedSchema === 2;
export const coreFormatVersion = (data: { memory_revisions: Row[] }) => data.memory_revisions.some(prefixEncoded) ? 19 as const : 18 as const;

export function manualPrefixCandidate(memory: MemoryRevision) {
    return memory.level === 0 && !memory.sourceRecovery && !!memory.anchor && Array.isArray(memory.inputRefs) &&
        memory.inputRefs.length > 1 && memory.inputRefs.at(-1)?.message === memory.anchor &&
        (memory.declaration === '人工修订摘要：以当前来源版本确认内容；原生成版本保留。' ||
         memory.declaration === RECOVERED_MANUAL_PREFIX);
}
export async function matchesStoredPrefix(memory: MemoryRevision, basis: Snapshot | undefined,
    getBlock: (id: string) => Promise<Block | undefined>) {
    const refs = memory.inputRefs;
    if (!refs.length || !basis || basis.id !== memory.basis || basis.story !== memory.story || refs.length > basis.length) return false;
    let index = 0;
    for (const id of basis.blocks) {
        const block = await getBlock(id);
        if (!block) return false;
        for (const ref of block.entries) {
            if (refs[index].message !== ref.message || refs[index].revision !== ref.revision) return false;
            if (++index === refs.length) return true;
        }
    }
    return false;
}
function prefixCount(memory: MemoryRevision, basis?: Snapshot) {
    const count = memory.inputRefs as unknown as number;
    check(memory.level === 0 && !memory.sourceRecovery && !!memory.anchor && Number.isSafeInteger(count) && count > 1 &&
        basis && basis.id === memory.basis && basis.story === memory.story && count <= basis.length, '摘要来源前缀或快照非法');
    return count;
}
function append(refs: SourceRef[], block: Block | undefined, count: number) {
    check(block && Array.isArray(block.entries) && block.entries.length > 0, '摘要来源前缀缺少清单块');
    const length = Math.min(count - refs.length, block.entries.length);
    for (let i = 0; i < length; i++) refs.push(block.entries[i]);
}
function finish(memory: MemoryRevision, refs: SourceRef[], count: number) {
    check(refs.length === count && refs.at(-1)?.message === memory.anchor, '摘要来源前缀与楼层不符');
    return refs;
}
export async function readStoredPrefix(memory: MemoryRevision, basis: Snapshot | undefined,
    getBlock: (id: string) => Promise<Block | undefined>) {
    const count = prefixCount(memory, basis), refs: SourceRef[] = [];
    for (const id of basis!.blocks) {
        append(refs, await getBlock(id), count);
        if (refs.length === count) break;
    }
    // Keep transactional snapshot blocks immutable if a caller edits its logical row.
    return finish(memory, refs, count).map(ref => ({ ...ref }));
}
export function archivePrefixReader(data: { history_snapshots?: Row[]; manifest_blocks?: Row[] }) {
    let snapshots: Map<string, Snapshot> | undefined, blocks: Map<string, Block> | undefined;
    return (memory: MemoryRevision) => {
        snapshots ??= new Map((data.history_snapshots as Snapshot[] ?? []).map(s => [s.id, s]));
        blocks ??= new Map((data.manifest_blocks as Block[] ?? []).map(b => [b.id, b]));
        const basis = snapshots.get(memory.basis), count = prefixCount(memory, basis), refs: SourceRef[] = [];
        for (const id of basis!.blocks) {
            append(refs, blocks.get(id), count);
            if (refs.length === count) break;
        }
        return finish(memory, refs, count);
    };
}
