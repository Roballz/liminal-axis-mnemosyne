// Shared synthetic fixtures, also exercises fixture invariants.
import 'fake-indexeddb/auto';
import { Library, freshLibraryName } from './db';
import { capture, synchronize, type HostObservation } from './canonical';
import { prepareEventBatch, type EventOutput, type EventBatch } from './events';
export function observation(count = 5, scope = 'synthetic-chat'): HostObservation {
    return { scope, messages: Array.from({ length: count * 2 }, (_, i) => ({ key: `host-${i}`, role: i % 2 ? 'assistant' : 'user',
            content: i % 2 ? `合成剧情 ${i} 借出玉佩，约定归还。` : `合成问题 ${i}`, swipe: 0 })),
        memories: Array.from({ length: count }, (_, i) => ({ hostId: `leaf-${i}`, content: `第${i}次玉佩进展`, level: 0,
            anchorKey: `host-${i * 2 + 1}`, children: [], storyTime: '', seed: false, enabled: true })) };
}
export async function fixture(count = 5) {
    const lib = await Library.open(freshLibraryName());
    const input = observation(count);
    const branch = await synchronize(lib, input);
    const view = await capture(lib, branch.id);
    return { lib, input, branch, view };
}
export function output(batch: EventBatch, event_id: string | null = null): EventOutput {
    return { decisions: batch.memories.map(m => ({ memory: m.id, result: 'linked' })), events: [{ event_id, title: '玉佩归还', status: 'open', keywords: ['玉佩'],
                members: batch.memories.map(m => ({ memory: m.id, kind: 'progress' })), progress: '本批玉佩交接有了新进展。' }] };
}
export async function batchFixture(count = 5) {
    const data = await fixture(count);
    const batch = (await prepareEventBatch(data.lib, data.view, 20, 48000))!;
    return { ...data, batch };
}

/** Remove only fields unavailable in pre-table-history package fixtures. */
export function withoutTableHistory(pack: import('./migration').Package) {
    delete (pack.data as Partial<typeof pack.data>).table_history;
    delete (pack.counts as Partial<typeof pack.counts>).table_history;
    for (const branch of pack.data.branches as import('./model').Branch[]) {
        delete branch.tableHead; delete branch.tableHistoryGap;
    }
    for (const snapshot of pack.data.history_snapshots as import('./model').Snapshot[]) delete snapshot.variants;
    return pack;
}
