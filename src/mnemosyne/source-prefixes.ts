import { check, type Block, type Branch, type Snapshot, type SourceRef } from './model';
import { sourceRefMatches } from './source-equivalence';

interface IndexedBlock {
    entries: SourceRef[];
    positions: Map<string, number>;
    prefixes: Map<number, number>;
}
export interface SourcePrefix {
    length: number;
    prefix: number;
    /** Existing legacy applicability includes every ref through the last anchor. */
    through(anchor: string): number;
}

/** A status read shares immutable block work across historical bases. Do not
 * materialize each growing full prefix, or copy its complete message index. */
export function sourcePrefixes(branch: Branch, current: SourceRef[], snapshots: Snapshot[], blocks: Block[]): Map<string, SourcePrefix> {
    const indexed = new Map<string, IndexedBlock>();
    for (const block of blocks) {
        const entries = block.entries;
        indexed.set(block.id, { entries,
            positions: new Map(entries.map((ref, index) => [ref.message, index])), prefixes: new Map() });
    }
    const result = new Map<string, SourcePrefix>();
    for (const snapshot of snapshots) {
        let length = 0, prefix = 0, matching = true;
        const spans: { block: IndexedBlock; offset: number }[] = [];
        for (const id of snapshot.blocks) {
            const block = indexed.get(id); check(block, '缺少历史清单块');
            spans.push({ block, offset: length });
            if (matching) {
                let local = block.prefixes.get(length);
                if (local === undefined) {
                    local = 0;
                    while (local < block.entries.length && sourceRefMatches(branch, block.entries[local], current[length + local])) local++;
                    block.prefixes.set(length, local);
                }
                prefix += local;
                matching = local === block.entries.length;
            }
            length += block.entries.length;
        }
        check(length === snapshot.length, '历史清单计数错误');
        result.set(snapshot.id, { length, prefix, through(anchor) {
            let position = -1;
            for (const span of spans) {
                const found = span.block.positions.get(anchor);
                if (found !== undefined) position = span.offset + found;
            }
            return position + 1;
        } });
    }
    return result;
}
