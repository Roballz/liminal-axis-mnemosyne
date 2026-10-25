import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { capture, confirmRecoveredSummaries, forkBranch, synchronize } from './canonical';
import { fixture, observation } from './fixtures';
import { exportLibrary, restoreLibrary, validateData, type Package } from './migration';
import { publishMemoryView } from './memory-selections';
import { STORES, fingerprint, row, type Branch, type CompactMemoryView, type MemorySelectionNode, type MemoryView } from './model';

test('1000 incremental views store shared nodes instead of 500500 complete selection entries', async () => {
    const { lib, branch, view } = await fixture(1000);
    try {
        const entries = Object.entries(view.selection.selections), saved: MemoryView[] = [];
        await lib.transaction(['branches', 'memory_views'], 'readwrite', async tx => {
            let previous: MemoryView | undefined;
            const selections: Record<string, string> = {};
            for (const [family, revision] of entries) {
                selections[family] = revision;
                const next: MemoryView = { ...row('mv'), branch: branch.id, selections: { ...selections } };
                await publishMemoryView(tx, next, previous);
                saved.push(next); previous = next;
            }
            await tx.put('branches', { ...branch, view: previous!.id, epoch: branch.epoch + 1 } as Branch);
        });
        const pack = await exportLibrary(lib);
        const raw = pack.data.memory_views as CompactMemoryView[], nodes = pack.data.memory_selection_nodes as MemorySelectionNode[];
        expect(raw.every(record => record.selectionSchema === 2 && !('selections' in record))).toBe(true);
        const storedEntries = nodes.reduce((count, node) => count + node.entries.length + Object.keys(node.children).length, 0);
        expect(storedEntries).toBeLessThan(100_000);
        expect(nodes.length).toBeLessThan(4_000);
        for (const index of [0, 63, 64, 299, 999]) {
            const restored = await lib.get<MemoryView>('memory_views', saved[index].id);
            expect(restored).toEqual(saved[index]);
            expect(Object.entries(restored!.selections)).toEqual(entries.slice(0, index + 1));
        }
        const imported = await restoreLibrary(pack, false);
        try {
            expect((await capture(imported, branch.id)).selection).toEqual(saved[999]);
            expect((await exportLibrary(imported)).data).toEqual(pack.data);
        } finally { imported.close(); }
    } finally { lib.close(); }
}, 15000);

test('edit, removal, reordering, recovery confirmation and fork preserve exact selections and old identities', async () => {
    const { lib, input, branch, view } = await fixture(70);
    try {
        const original = await lib.get<MemoryView>('memory_views', view.selection.id);
        input.memories[12].content += ' 修订'; input.memories.splice(3, 1); input.memories.reverse();
        await synchronize(lib, input);
        const changed = await capture(lib, branch.id);
        expect(await lib.get('memory_views', original!.id)).toEqual(original);
        expect(changed.memories.map(memory => memory.hostId)).toEqual(input.memories.map(memory => memory.hostId));
        const confirmation = await confirmRecoveredSummaries(lib, changed, [changed.memories[0].id]);
        const confirmed = await capture(lib, branch.id);
        expect(confirmed.selection.selections[confirmation[0].owner]).toBe(confirmation[0].id);
        const child = await forkBranch(lib, confirmed, 'synthetic-fork');
        const childView = await capture(lib, child.id);
        expect(childView.memories.map(memory => memory.content)).toEqual(confirmed.memories.map(memory => memory.content));
        await exportLibrary(lib);
    } finally { lib.close(); }
});

test('legacy full-map rows remain unchanged while later views use compact storage', async () => {
    const { lib, input, branch, view } = await fixture(2);
    try {
        const legacy: MemoryView = { ...row('legacy-view'), branch: branch.id, selections: { ...view.selection.selections } };
        await lib.transaction(['branches', 'memory_views'], 'readwrite', async tx => {
            await tx.add('memory_views', legacy);
            await tx.put('branches', { ...branch, view: legacy.id } as Branch);
        });
        input.memories[0].content += ' 新内容'; await synchronize(lib, input);
        expect(await lib.transaction(['memory_views'], 'readonly', tx => tx.rawGet('memory_views', legacy.id))).toEqual(legacy);
        const current = await capture(lib, branch.id);
        expect((await lib.transaction(['memory_views'], 'readonly', tx => tx.rawGet<CompactMemoryView>('memory_views', current.selection.id)))?.selectionSchema).toBe(2);
        expect(current.memories[0].content).toBe(input.memories[0].content);
        await exportLibrary(lib);
    } finally { lib.close(); }
});

test.each(['sparse', 'duplicate'].flatMap(ranks => ['append', 'remove', 'reorder'].map(operation => ({ ranks, operation }))))(
    'imported $ranks ranks survive $operation without changing historical selection order', async ({ ranks, operation }) => {
        const { lib, input, branch, view } = await fixture(70);
        let restored: typeof lib | undefined;
        try {
            const pack = await exportLibrary(lib);
            for (const node of pack.data.memory_selection_nodes as MemorySelectionNode[])
                for (const entry of node.entries) entry[2] = ranks === 'sparse' ? (entry[2] + 1) * 3 : 100;
            const { checksum: _, ...base } = pack; pack.checksum = await fingerprint(base);
            restored = await restoreLibrary(pack, false);
            const imported = await capture(restored, branch.id), original = imported.selection;
            const byHost = new Map(input.memories.map(memory => [memory.hostId, memory]));
            input.memories = imported.memories.map(memory => byHost.get(memory.hostId)!);
            if (operation === 'append') {
                const extended = observation(71, input.scope);
                input.messages = extended.messages;
                input.memories.push(extended.memories[70]);
            } else if (operation === 'remove') input.memories.splice(7, 1);
            else [input.memories[12], input.memories[35]] = [input.memories[35], input.memories[12]];
            await synchronize(restored, input);
            const current = await capture(restored, branch.id);
            expect(current.memories.map(memory => memory.hostId)).toEqual(input.memories.map(memory => memory.hostId));
            const historical = await restored.get<MemoryView>('memory_views', view.selection.id);
            expect(historical).toEqual(original);
            expect(Object.entries(historical!.selections)).toEqual(Object.entries(original.selections));
            const updated = await exportLibrary(restored);
            expect(updated.data.memory_views.find(row => row.id === original.id))
                .toEqual(pack.data.memory_views.find(row => row.id === original.id));
            const nodes = new Map(updated.data.memory_selection_nodes.map(node => [node.id, node]));
            for (const node of pack.data.memory_selection_nodes) expect(nodes.get(node.id)).toEqual(node);
        } finally { restored?.close(); lib.close(); }
    },
);

test('aborted view publication leaves no nodes or view, and another connection reads committed versions', async () => {
    const { lib, branch, view } = await fixture(70);
    const { Library } = await import('./db'), other = await Library.open(lib.db.name);
    try {
        const before = await exportLibrary(lib);
        const next: MemoryView = { ...row('mv'), branch: branch.id, selections: Object.fromEntries(Object.entries(view.selection.selections).slice(1)) };
        await expect(lib.transaction(['memory_views'], 'readwrite', async tx => {
            await publishMemoryView(tx, next, view.selection); throw Error('synthetic abort');
        })).rejects.toThrow('synthetic abort');
        expect((await exportLibrary(lib)).data).toEqual(before.data);
        await lib.transaction(['memory_views'], 'readwrite', tx => publishMemoryView(tx, next, view.selection));
        expect(await other.get('memory_views', next.id)).toEqual(next);
        expect(await other.get('memory_views', view.selection.id)).toEqual(view.selection);
    } finally { other.close(); lib.close(); }
});

test('compact export validates roots, routes, counts, family identity and orphan nodes without weakening old formats', async () => {
    const { lib, view } = await fixture(100);
    try {
        const pack = await exportLibrary(lib);
        const mutations: ((copy: Package) => void)[] = [
            copy => { (copy.data.memory_views.find(row => row.id === view.selection.id) as CompactMemoryView).root = 'missing'; },
            copy => { (copy.data.memory_views.find(row => row.id === view.selection.id) as CompactMemoryView).count++; },
            copy => { const node = (copy.data.memory_selection_nodes as MemorySelectionNode[]).find(node => node.entries.length)!; node.entries[0][0] = 'different-family'; },
            copy => { const root = (copy.data.memory_selection_nodes as MemorySelectionNode[]).find(node => Object.keys(node.children).length)!; root.children[Object.keys(root.children)[0]] = root.id; },
            copy => { const node = structuredClone(copy.data.memory_selection_nodes[0]); node.id = 'orphan'; copy.data.memory_selection_nodes.push(node); copy.counts.memory_selection_nodes++; },
            copy => { const node = (copy.data.memory_selection_nodes as MemorySelectionNode[]).find(node => node.entries.length)!; node.entries[0][2] = -1; },
            copy => { copy.version = 14; },
        ];
        for (const mutate of mutations) {
            const copy = structuredClone(pack); mutate(copy);
            expect(() => validateData(copy)).toThrow();
        }
        const restored = await restoreLibrary(pack, false);
        try { expect((await capture(restored, view.branch.id)).selection).toEqual(view.selection); }
        finally { restored.close(); }
        expect(STORES).toContain('memory_selection_nodes');
    } finally { lib.close(); }
});
