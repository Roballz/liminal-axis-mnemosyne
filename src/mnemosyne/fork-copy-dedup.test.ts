import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { fixture } from './fixtures';
import { capture, forkBranch, keepSummary, statuses, synchronize } from './canonical';
import { exportLibrary } from './migration';
import { applyRows, newTable, saveTable } from './tables';
import { STORES, type Memory, type MemoryRevision, type TableDef, type TableRow } from './model';

/** Two old revisions per layer share both children; the root reaches every node. */
async function sharedHistory(depth = 6) {
    const f = await fixture(depth * 2 + 1);
    for (let layer = 0; layer < depth; layer++) for (let side = 0; side < 2; side++) {
        const memory = f.input.memories[layer * 2 + side];
        memory.content = `historical layer ${layer}, side ${side}`;
        memory.children = layer ? f.input.memories.slice((layer - 1) * 2, layer * 2).map(m => m.hostId) : [];
    }
    const root = f.input.memories.at(-1)!;
    root.content = 'historical root';
    root.children = f.input.memories.slice(-3, -1).map(m => m.hostId);
    await synchronize(f.lib, f.input);
    const before = await capture(f.lib, f.branch.id);
    const originals = new Map(before.memories.map(m => [m.id, m]));
    const rootId = before.memories.find(m => m.hostId === root.hostId)!.id;
    return { ...f, originals, rootId };
}

async function tableEvidence(f: Awaited<ReturnType<typeof sharedHistory>>, sources: string[]) {
    let view = await capture(f.lib, f.branch.id);
    const def = newTable(view, 'Synthetic history');
    def.columns = [{ id: 'key', name: 'Key', type: 'text', description: '', mode: 'replace' }];
    await saveTable(f.lib, view, def);
    view = await capture(f.lib, f.branch.id);
    await applyRows(f.lib, view, (await f.lib.get<TableDef>('custom_table_defs', def.id))!,
        [{ row_id: null, values: { key: 'historical evidence' } }], true, sources);
}

async function approveChangedHistory(f: Awaited<ReturnType<typeof sharedHistory>>, omitFirst = 0) {
    // The current selected revisions are independently valid. The unchanged root
    // retains its original DAG and explicitly approves the selected replacements.
    for (const memory of f.input.memories.slice(0, -1)) {
        memory.content = `current replacement ${memory.hostId}`;
        memory.children = [];
    }
    f.input.memories = f.input.memories.slice(omitFirst);
    await synchronize(f.lib, f.input);
    await keepSummary(f.lib, await capture(f.lib, f.branch.id), f.rootId);
    const parent = await capture(f.lib, f.branch.id);
    expect([...await statuses(f.lib, parent)].every(([, state]) => state === 'valid')).toBe(true);
    return parent;
}

function assertCopiedGraph(rows: MemoryRevision[], originals: Map<string, MemoryRevision>, rootId?: string) {
    const copied = new Map<string, MemoryRevision>();
    for (const [id, original] of originals) {
        if (id === rootId) continue;
        const matches = rows.filter(memory => memory.content === original.content);
        expect(matches).toHaveLength(1);
        const copy = matches[0];
        expect(copy.basis).toBe(original.basis);
        expect(copy.inputRefs).toEqual(original.inputRefs);
        expect(copy.coverage).toEqual(original.coverage);
        copied.set(id, copy);
    }
    for (const [id, copy] of copied) {
        expect(copy.dependencies).toEqual(originals.get(id)!.dependencies.map(dep => copied.get(dep)!.id));
    }
    return copied;
}

test('fork copies a deep shared historical DAG once per source revision and preserves parent evidence', async () => {
    const f = await sharedHistory(8);
    try {
        const parent = await approveChangedHistory(f);
        const before = await f.lib.all<MemoryRevision>('memory_revisions', 'branch', parent.branch.id);
        await exportLibrary(f.lib); // The source graph is a valid production package.
        const child = await forkBranch(f.lib, parent, 'deduplicated-deep-history');
        const rows = await f.lib.all<MemoryRevision>('memory_revisions', 'branch', child.id);
        expect(rows).toHaveLength(parent.memories.length + f.originals.size - 1);
        const copied = assertCopiedGraph(rows, f.originals, f.rootId);
        const view = await capture(f.lib, child.id);
        const root = view.memories.find(m => m.content === 'historical root')!;
        expect(root.dependencies).toEqual(f.originals.get(f.rootId)!.dependencies.map(id => copied.get(id)!.id));
        expect([...await statuses(f.lib, view)].every(([, state]) => state === 'valid')).toBe(true);
        expect(await f.lib.all('memory_revisions', 'branch', parent.branch.id)).toEqual(before);
        expect(await f.lib.get('branches', parent.branch.id)).toEqual(parent.branch);
        await exportLibrary(f.lib);
    } finally { f.lib.close(); }
});

test('table history reuses copied revisions and localizes dependencies from unselected families', async () => {
    const f = await sharedHistory();
    try {
        const sources = f.originals.get(f.rootId)!.dependencies;
        await tableEvidence(f, sources);
        const parent = await approveChangedHistory(f, 2);
        const child = await forkBranch(f.lib, parent, 'shared-summary-and-table-evidence');
        const rows = await f.lib.all<MemoryRevision>('memory_revisions', 'branch', child.id);
        expect(rows).toHaveLength(parent.memories.length + f.originals.size - 1);
        const copied = assertCopiedGraph(rows, f.originals, f.rootId);
        const table = (await f.lib.all<TableRow>('custom_table_rows', 'branch', child.id))[0];
        expect(table.sources).toEqual(sources.map(id => copied.get(id)!.id));
        expect([...await statuses(f.lib, await capture(f.lib, child.id))].every(([, state]) => state === 'valid')).toBe(true);
        await exportLibrary(f.lib);
    } finally { f.lib.close(); }
});

test('concurrent table-only evidence creates each historical revision and family once without selecting it', async () => {
    const f = await sharedHistory();
    try {
        await tableEvidence(f, [f.rootId]);
        f.input.memories = [];
        await synchronize(f.lib, f.input);
        const parent = await capture(f.lib, f.branch.id);
        expect(parent.memories).toEqual([]);
        await exportLibrary(f.lib);
        const before = await f.lib.all<MemoryRevision>('memory_revisions', 'branch', parent.branch.id);
        const child = await forkBranch(f.lib, parent, 'table-only-shared-history');
        const rows = await f.lib.all<MemoryRevision>('memory_revisions', 'branch', child.id);
        expect(rows).toHaveLength(f.originals.size);
        const copied = assertCopiedGraph(rows, f.originals);
        const binding = (await f.lib.all<any>('host_bindings', 'branch', child.id))[0];
        const families = await f.lib.all<Memory>('memories', 'owner', binding.id);
        expect(families).toHaveLength(f.originals.size);
        expect(new Set(families.map(family => family.hostId)).size).toBe(families.length);
        expect(rows.every(memory => families.some(family => family.id === memory.owner))).toBe(true);
        expect((await capture(f.lib, child.id)).memories).toEqual([]);
        expect((await f.lib.all<TableRow>('custom_table_rows', 'branch', child.id))[0].sources)
            .toEqual([copied.get(f.rootId)!.id]);
        expect(await f.lib.all('memory_revisions', 'branch', parent.branch.id)).toEqual(before);
        await exportLibrary(f.lib);
    } finally { f.lib.close(); }
});

test('missing historical table dependencies abort the fork and roll back reserved child identities', async () => {
    const f = await sharedHistory(2);
    try {
        await tableEvidence(f, [f.rootId]);
        f.input.memories = [];
        await synchronize(f.lib, f.input);
        await f.lib.transaction(['memory_revisions'], 'readwrite', async tx => {
            const root = (await tx.get<MemoryRevision>('memory_revisions', f.rootId))!;
            await tx.put('memory_revisions', { ...root, dependencies: ['missing-history'] } as MemoryRevision);
        });
        const before = await Promise.all(STORES.map(store => f.lib.all(store)));
        await expect(forkBranch(f.lib, await capture(f.lib, f.branch.id), 'missing-history-child'))
            .rejects.toThrow('继承表格历史来源依赖缺失');
        expect(await Promise.all(STORES.map(store => f.lib.all(store)))).toEqual(before);
    } finally { f.lib.close(); }
});

test('selected dependency cycles fail the existing fork preflight instead of waiting on recursive copies', async () => {
    const f = await fixture(2);
    try {
        const [left, right] = f.view.memories;
        await f.lib.transaction(['memory_revisions'], 'readwrite', async tx => {
            await tx.put('memory_revisions', { ...left, dependencies: [right.id] } as MemoryRevision);
            await tx.put('memory_revisions', { ...right, dependencies: [left.id] } as MemoryRevision);
        });
        const before = await Promise.all(STORES.map(store => f.lib.all(store)));
        await expect(forkBranch(f.lib, await capture(f.lib, f.branch.id), 'cyclic-child')).rejects.toThrow('摘要依赖循环');
        expect(await Promise.all(STORES.map(store => f.lib.all(store)))).toEqual(before);
    } finally { f.lib.close(); }
});
