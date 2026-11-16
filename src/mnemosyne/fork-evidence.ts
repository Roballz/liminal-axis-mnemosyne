import type { Transaction } from './db';
import { equal, type MemoryRevision } from './model';
import { payloadKey } from './shared-payloads';

// Only an exact duplicate of generation evidence can share a child evidence row.
// Do not use text equality or host ID alone. Parent records are never changed.
function evidence(memory: MemoryRevision) {
    const { id, owner, branch, ...value } = memory;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
export class ForkEvidenceIndex {
    private buckets = new Map<string, string[]>();
    constructor(private tx: Transaction) {}
    private key(memory: MemoryRevision) { return payloadKey(JSON.stringify(evidence(memory))); }
    remember(memory: MemoryRevision) {
        const key = this.key(memory), ids = this.buckets.get(key) ?? [];
        ids.push(memory.id); this.buckets.set(key, ids);
    }
    async equivalent(memory: MemoryRevision): Promise<MemoryRevision | undefined> {
        for (const id of this.buckets.get(this.key(memory)) ?? []) {
            const other = await this.tx.get<MemoryRevision>('memory_revisions', id);
            if (other && other.branch === memory.branch && equal(evidence(other), evidence(memory))) return other;
        }
    }
}
