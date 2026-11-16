import { SHARED_FIELDS, type Payload } from './shared-payloads';
import { check, type Row, type Store, type CompactMemoryView, type MemorySelectionNode } from './model';

/** Mark from every retained historical record, not just current branch heads.
 * Called inside explicit archive deletion planning; never a background collector.
 */
export function unreferencedStorage(data: Record<Store, Row[]>) {
    const payloads = new Map(data.memory_payloads.map(row => [row.id, row as Payload]));
    const nodes = new Map(data.memory_selection_nodes.map(row => [row.id, row as MemorySelectionNode]));
    const livePayloads = new Set<string>(), liveNodes = new Set<string>();
    const payloadRoots: string[] = [], nodeRoots: string[] = [];
    for (const [store, fields] of Object.entries(SHARED_FIELDS)) {
        for (const row of data[store as Store]) for (const field of fields) {
            const value = (row as any)[field];
            if (value && typeof value === 'object' && typeof value.shared === 'string') payloadRoots.push(value.shared);
        }
    }
    while (payloadRoots.length) {
        const id = payloadRoots.pop()!;
        if (livePayloads.has(id)) continue;
        const row = payloads.get(id); check(row, '保留记录引用的共享内容缺失，停止回收');
        livePayloads.add(id);
        if (row.kind === 'node') for (const child of row.value) payloadRoots.push(child);
    }
    for (const row of data.memory_views) {
        const view = row as CompactMemoryView;
        if (view.selectionSchema === 2 && view.root) nodeRoots.push(view.root);
    }
    while (nodeRoots.length) {
        const id = nodeRoots.pop()!;
        if (liveNodes.has(id)) continue;
        const node = nodes.get(id); check(node, '保留视图引用的选择节点缺失，停止回收');
        liveNodes.add(id);
        for (const child of Object.values(node.children)) nodeRoots.push(child);
    }
    return {
        memory_payloads: [...payloads.keys()].filter(id => !livePayloads.has(id)),
        memory_selection_nodes: [...nodes.keys()].filter(id => !liveNodes.has(id)),
    };
}
