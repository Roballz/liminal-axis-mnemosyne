import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { CoreBackups } from './core-backups';
import { exportLibrary, restoreLibrary, validateCurrentData, validateData, type Package } from './migration';
import { fingerprint, STORES, type Branch, type Snapshot } from './model';
import type { BackupDisk } from '@/st/native-backups';

/** Actual legacy rows, not current-only descriptors relabelled as an old format. */
async function legacyPackage(length: number, version: Package['version'] = 13): Promise<Package> {
    const stores = STORES.filter(s => !(s === 'source_bodies' && version < 12) && !(s === 'table_history' && version < 11));
    const data = Object.fromEntries(stores.map(s => [s, []])) as unknown as Package['data'];
    const content = 'Synthetic retained historical body';
    data.stories.push({ id: 'story', schema: 1, created: 1 } as any);
    data.branches.push({ id: 'branch', schema: 1, story: 'story', head: `snapshot-${length - 1}`,
        view: 'view', epoch: 1, fork: null } as Branch);
    data.memory_views.push({ id: 'view', schema: 1, story: 'story', branch: 'branch', selections: {} } as any);
    data.host_bindings.push({ id: 'binding', schema: 1, story: 'story', branch: 'branch', scope: 'synthetic',
        generation: 1, intent: 'new_story' } as any);
    data.source_messages.push({ id: 'message', schema: 1, story: 'story' });
    data.source_revisions.push({ id: 'revision', schema: 1, story: 'story', owner: 'message', role: 'assistant',
        content, fingerprint: await fingerprint(['assistant', content]),
        provenance: { binding: 'binding', hostKey: 'host', index: 0, swipe: 0 } } as any);
    data.manifest_blocks.push({ id: 'block', schema: 1, story: 'story',
        entries: [{ message: 'message', revision: 'revision' }] } as any);
    data.history_snapshots = Array.from({ length }, (_, i): Snapshot => ({ id: `snapshot-${i}`, schema: 1,
        story: 'story', branch: 'branch', previous: i ? `snapshot-${i - 1}` : null,
        blocks: ['block'], length: 1, created: i + 1 }));
    const base = { format: 'mnemosyne-daily' as const, version, schema: 1 as const, created: 1, excluded: [],
        data, counts: Object.fromEntries(stores.map(s => [s, data[s].length])) as Package['counts'] };
    return { ...base, checksum: await fingerprint(base) };
}

function predecessorReads(pack: Package) {
    let reads = 0;
    for (const snapshot of pack.data.history_snapshots as Snapshot[]) {
        const previous = snapshot.previous;
        Object.defineProperty(snapshot, 'previous', { enumerable: true, configurable: true,
            get: () => { reads++; return previous; } });
    }
    validateData(pack);
    return reads;
}

test.each(['oldest-first', 'head-first'])('5k/10k legacy chains validate with linear predecessor reads (%s)', async order => {
    const counts = [];
    for (const length of [5_000, 10_000]) {
        const pack = await legacyPackage(length);
        if (order === 'head-first') pack.data.history_snapshots.reverse();
        const count = predecessorReads(pack);
        expect(count).toBeLessThanOrEqual(length * 8);
        counts.push(count);
    }
    expect(counts[1]).toBeLessThanOrEqual(counts[0] * 2 + 8);
});

test.each(Array.from({ length: 14 }, (_, i) => (i + 1) as Package['version']))('v%s retains old rows and rejects malformed predecessor graphs', async version => {
    const pack = await legacyPackage(12, version), original = JSON.stringify(pack);
    await expect(validateCurrentData(pack)).resolves.toBeUndefined();
    expect(JSON.stringify(pack)).toBe(original);
    const cycle = structuredClone(pack);
    (cycle.data.history_snapshots[0] as Snapshot).previous = 'snapshot-11';
    expect(() => validateData(cycle)).toThrow('快照循环');
    const missing = structuredClone(pack);
    (missing.data.history_snapshots[7] as Snapshot).previous = 'missing';
    expect(() => validateData(missing)).toThrow('引用缺失 history_snapshots/missing');
    const crossBranch = structuredClone(pack);
    crossBranch.data.branches.push({ ...crossBranch.data.branches[0], id: 'other-branch' });
    crossBranch.counts.branches++;
    crossBranch.data.history_snapshots[7].branch = 'other-branch';
    expect(() => validateData(crossBranch)).toThrow('快照前驱跨分支');
});

test('a 10k path entering a long cycle is rejected without recursion', async () => {
    const pack = await legacyPackage(10_000);
    // The head traverses a tail before entering a 5k-node cycle.
    (pack.data.history_snapshots[0] as Snapshot).previous = 'snapshot-4999';
    pack.data.history_snapshots.reverse();
    expect(() => validateData(pack)).toThrow('快照循环');
});

test('settled paths do not hide a later disconnected cycle, missing link, or cross-branch edge', async () => {
    for (const kind of ['cycle', 'missing', 'cross-branch']) {
        const pack = await legacyPackage(10_000);
        const old = pack.data.history_snapshots[0] as Snapshot;
        const extra: Snapshot = { ...old, id: 'extra', previous: kind === 'cycle' ? 'extra' : kind === 'missing' ? 'missing' : old.id };
        if (kind === 'cross-branch') {
            pack.data.branches.push({ ...pack.data.branches[0], id: 'other-branch' });
            pack.counts.branches++;
            extra.branch = 'other-branch';
        }
        pack.data.history_snapshots.push(extra); pack.counts.history_snapshots++;
        expect(() => validateData(pack)).toThrow(kind === 'cycle' ? '快照循环' : kind === 'missing' ? '引用缺失 history_snapshots/missing' : '快照前驱跨分支');
    }
});

test('a retained 5k legacy chain survives export and automatic backup persisted readback without changing legacy rows', async () => {
    const pack = await legacyPackage(5_000);
    // Exported stores use IndexedDB key order, which restore verifies exactly.
    pack.data.history_snapshots.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const { checksum: _, ...base } = pack;
    pack.checksum = await fingerprint(base);
    const lib = await restoreLibrary(pack, false);
    const files = new Map<string, Blob>();
    const disk: BackupDisk = { list: async () => [...files.keys()],
        read: async key => { const blob = files.get(key); if (!blob) throw new Error('missing'); return blob; },
        write: async (key, blob) => { files.set(key, blob); }, remove: async key => { files.delete(key); },
        readSettings: async () => undefined, writeSettings: async () => {} };
    try {
        const exported = await exportLibrary(lib);
        const sorted = (p: Package, store: 'history_snapshots' | 'source_revisions') =>
            p.data[store].slice().sort((a, b) => a.id.localeCompare(b.id));
        expect(sorted(exported, 'history_snapshots')).toEqual(sorted(pack, 'history_snapshots'));
        expect(sorted(exported, 'source_revisions')).toEqual(sorted(pack, 'source_revisions'));
        const backups = new CoreBackups(disk);
        const saved = await backups.save(lib, 'auto');
        expect(saved.state).toBe('saved');
        if (saved.state !== 'saved') throw new Error('missing saved backup');
        const readback = await backups.read(saved.entry.key);
        expect(readback.file.pack.data).toEqual(exported.data);
        expect(files.size).toBe(1);
        const restored = await restoreLibrary(readback.file.pack, false);
        try { expect((await exportLibrary(restored)).data).toEqual(exported.data); }
        finally { restored.close(); }
    } finally { lib.close(); }
}, 20_000);

function addSummaries(pack: Package, count: number, dense = true) {
    for (let i = 0; i < count; i++) {
        const id = `summary-${i}`;
        pack.data.memories.push({ id: `family-${i}`, schema: 1, story: 'story', owner: 'binding', hostId: id } as any);
        pack.data.memory_revisions.push({ id, schema: 1, story: 'story', branch: 'branch', owner: `family-${i}`,
            hostId: id, content: `Synthetic summary ${i}`, fingerprint: `legacy-${i}`, basis: 'snapshot-0',
            inputRefs: [], coverage: [], dependencies: dense ? Array.from({ length: i }, (_, j) => `summary-${j}`) : i ? [`summary-${i - 1}`] : [],
            declaration: null, level: 0, anchor: 'message', storyTime: '', recall: true, visibility: 'public', seed: false } as any);
    }
    pack.counts.memories = pack.data.memories.length;
    pack.counts.memory_revisions = pack.data.memory_revisions.length;
}

/** Count traversed edges, not timings; non-enumerable instrumentation is never serialized. */
function dependencyVisits(pack: Package) {
    let edges = 0, iterators = 0;
    for (const row of pack.data.memory_revisions as any[]) {
        const dependencies: string[] = row.dependencies;
        const iterator = dependencies[Symbol.iterator].bind(dependencies);
        Object.defineProperty(dependencies, Symbol.iterator, { configurable: true, value: function* () {
            iterators++;
            for (const id of { [Symbol.iterator]: iterator }) { edges++; yield id; }
        } });
    }
    validateData(pack);
    return { edges, iterators };
}

test.each([30, 155, 1_000])('dense shared %s-node summary DAG visits each edge twice at most', async count => {
    const pack = await legacyPackage(1); addSummaries(pack, count);
    const before = JSON.stringify(pack);
    const visits = dependencyVisits(pack), edges = count * (count - 1) / 2;
    expect(visits.edges).toBe(edges * 2); // Direct story check + one graph traversal.
    expect(visits.iterators).toBe(count * 2);
    expect(JSON.stringify(pack)).toBe(before);
});

test('20k dependency chain is iterative and rejects a cycle after the long tail', async () => {
    const pack = await legacyPackage(1); addSummaries(pack, 20_000, false);
    pack.data.memory_revisions.reverse();
    expect(() => validateData(pack)).not.toThrow();
    (pack.data.memory_revisions.at(-1) as any).dependencies = ['summary-9999'];
    expect(() => validateData(pack)).toThrow('摘要依赖循环');
});

test.each(Array.from({ length: 14 }, (_, i) => (i + 1) as Package['version']))('v%s shared summaries retain graph rejection guards after settled paths', async version => {
    const pack = await legacyPackage(1, version); addSummaries(pack, 30);
    expect(() => validateData(pack)).not.toThrow();
    const cycle = structuredClone(pack);
    (cycle.data.memory_revisions[28] as any).dependencies.push('summary-29');
    expect(() => validateData(cycle)).toThrow('摘要依赖循环');
    const missing = structuredClone(pack);
    (missing.data.memory_revisions[29] as any).dependencies.push('missing');
    expect(() => validateData(missing)).toThrow('引用缺失 memory_revisions/missing');
    const crossStory = structuredClone(pack);
    crossStory.data.stories.push({ ...crossStory.data.stories[0], id: 'other-story' }); crossStory.counts.stories++;
    crossStory.data.branches.push({ ...crossStory.data.branches[0], id: 'other-branch', story: 'other-story' }); crossStory.counts.branches++;
    crossStory.data.memory_revisions.push({ ...crossStory.data.memory_revisions[0], id: 'foreign', story: 'other-story', branch: 'other-branch' });
    crossStory.counts.memory_revisions++;
    (crossStory.data.memory_revisions[29] as any).dependencies.push('foreign');
    // Earlier branch validation also checks the foreign branch's head owner, so
    // make its otherwise unused head/view local to that branch before reaching edges.
    crossStory.data.history_snapshots.push({ ...crossStory.data.history_snapshots[0], id: 'other-head', story: 'other-story', branch: 'other-branch', blocks: [], length: 0 } as any);
    crossStory.counts.history_snapshots++;
    crossStory.data.memory_views.push({ id: 'other-view', schema: 1, story: 'other-story', branch: 'other-branch', selections: {} } as any);
    crossStory.counts.memory_views++;
    Object.assign(crossStory.data.branches.at(-1)!, { head: 'other-head', view: 'other-view' });
    expect(() => validateData(crossStory)).toThrow('摘要依赖跨故事');
});
