import 'fake-indexeddb/auto';
import { expect, test, vi } from 'vitest';
import { fixture, output } from './fixtures';
import { prepareEventBatch, commitEventBatch } from './events';
import { saveTable } from './tables';
import { keepSummary } from './canonical';
import { SharedPayloads, payloadReader, SHARED_META, type Payload } from './shared-payloads';
import { reorganizeCoreLibrary } from './core-reorganization';
import { Library, libraryWriteStamp, publishUnchangedLibrary } from './db';
import { exportLibrary, restoreLibrary, validateCurrentData } from './migration';
import { capture, synchronize, forkBranch } from './canonical';
import { row, STORES, type MemoryRevision, type Row } from './model';
import { previewArchiveDeletion, commitArchiveDeletion } from './archive-deletion';

const long = '合成剧情记录；正文与摘要身份各自保留。'.repeat(80);
test('shared text, ordered blocks and collision checks preserve every byte and occurrence', async () => {
    const blocks = new Map<string, Payload>();
    const codec = new SharedPayloads(async key => blocks.get(key), async row => { blocks.set(row.id, structuredClone(row)); }, () => '0000000000000000');
    const dependencies = Array.from({ length: 300 }, (_, i) => `revision-${i % 257}`);
    const original = { ...row('mr'), content: long, dependencies, coverage: [], inputRefs: [] } as any;
    const packed = await codec.pack('memory_revisions', original), size = blocks.size;
    expect(await codec.unpack('memory_revisions', packed)).toEqual(original);
    expect(await codec.pack('memory_revisions', { ...original, id: 'second' })).toEqual({ ...packed, id: 'second' });
    expect(blocks.size).toBe(size);
    const second = { ...original, content: long + '变化', dependencies: [...dependencies, 'last'] };
    expect(await codec.unpack('memory_revisions', await codec.pack('memory_revisions', second))).toEqual(second);
    expect(payloadReader([...blocks.values()])(packed, 'memory_revisions')).toEqual(original);
});

test('invalid shared graphs, counts, field types and versions are rejected', async () => {
    const id = 'mp_0000000000000000';
    const cases = [
        [{ id, schema: 1, kind: 'node', value: [id], count: 1 }],
        [{ id, schema: 1, kind: 'node', value: ['missing'], count: 1 }],
        [{ id, schema: 1, kind: 'list', value: ['x'], count: 2 }],
    ];
    for (const rows of cases) expect(() => payloadReader(rows as any)).toThrow();
    const expand = payloadReader([{ id, schema: 1, kind: 'text', value: 'text', count: 4 } as Payload]);
    expect(() => expand({ id: 'mr', schema: 1, sharedSchema: 2, content: { shared: id } } as any, 'memory_revisions')).toThrow();
    expect(() => expand({ id: 'mr', schema: 1, sharedSchema: 1, dependencies: { shared: id } } as any, 'memory_revisions')).toThrow();
});

test('real reorganization preserves all history, branch, review, event/table evidence; future writes and restore stay compact', async () => {
    const f = await fixture(70), { lib, input } = f;
    input.memories.forEach(m => { m.content = long; });
    await synchronize(lib, input);
    const oldView = await capture(lib, f.branch.id);
    // Metadata revisions intentionally retain older dependencies and text.
    for (let i = 0; i < 3; i++) {
        input.memories[0].content = long + i;
        await synchronize(lib, input);
    }
    await forkBranch(lib, await capture(lib, f.branch.id, 120), 'synthetic-child');
    let currentView = await capture(lib, f.branch.id);
    await keepSummary(lib, currentView, currentView.memories[0].id);
    currentView = await capture(lib, f.branch.id);
    const batch = await prepareEventBatch(lib, currentView, 5, 200000);
    if (batch) await commitEventBatch(lib, batch, output(batch));
    await saveTable(lib, await capture(lib, f.branch.id), { ...row('table'), story: f.branch.story, branch: f.branch.id,
        name: '合成表', description: '', columns: [{ id: 'name', name: '名称', type: 'text', description: '', mode: 'replace' }],
        ai: false, version: 0, created: 1, updated: 1, deleted: false } as any);
    const before = await exportLibrary(lib), stamp = await libraryWriteStamp(lib);
    const progress = vi.fn();
    const report = await reorganizeCoreLibrary(lib, async () => true, progress);
    const target = await Library.open(report.library, true);
    try {
        expect(report.sourceStamp).toBe(stamp); expect(progress).toHaveBeenCalled();
        expect(await exportLibrary(lib)).toEqual(expect.objectContaining({ data: before.data }));
        expect(report.afterBytes).toBeLessThan(report.beforeBytes * .8);
        for (const store of STORES.filter(s => !['memory_payloads', 'memory_selection_nodes', 'library_meta'].includes(s)))
            expect(await target.all(store)).toEqual(await lib.all(store));
        expect(target.compactWrites).toBe(true);
        const view = await capture(target, f.branch.id);
        expect(view.memories).toEqual((await capture(lib, f.branch.id)).memories);
        expect(await target.get('memory_views', oldView.selection.id)).toEqual(oldView.selection);
        // Retention roots must inspect decoded SourceRefs even though fields are shared.
        const roots = await target.transaction(['memory_revisions', 'reviews', 'event_revisions', 'event_memberships', 'event_progress',
            'event_processing_receipts', 'custom_table_rows', 'table_receipts', 'table_history'], 'readonly', tx => tx.retentionRoots(f.branch.story));
        expect(roots.snapshotRoots.size).toBeGreaterThan(0);
        input.memories[1].content = long + '整理后新增';
        await synchronize(target, input);
        const pack = await exportLibrary(target);
        expect(pack.version).toBe(18); expect(pack.data.memory_payloads.length).toBeGreaterThan(0);
        expect(pack.data.memory_revisions.some(r => 'sharedSchema' in r)).toBe(true);
        const restored = await restoreLibrary(pack, false);
        try {
            expect(restored.compactWrites).toBe(true);
            expect((await exportLibrary(restored)).data).toEqual(pack.data);
            expect(await restored.all('memory_revisions')).toEqual(await target.all('memory_revisions'));
        } finally { restored.close(); }
        const bad = structuredClone(pack); bad.data.memory_payloads = []; bad.counts.memory_payloads = 0;
        await expect(validateCurrentData(bad)).rejects.toThrow('共享内容引用缺失');
        // Re-running also verifies already compact data and leaves old library intact.
        const again = await reorganizeCoreLibrary(target, async () => true);
        const copy = await Library.open(again.library, true); copy.close();
    } finally { target.close(); lib.close(); }
}, 30_000);

test('cross-connection writes cancel copying and final publication; aborted writes do not change stamp', async () => {
    const { lib } = await fixture(2), other = await Library.open(lib.db.name, true);
    const before = await libraryWriteStamp(lib);
    try {
        await expect(lib.transaction(['library_meta'], 'readwrite', async tx => {
            await tx.put('library_meta', { id: 'temporary', schema: 1 }); throw new Error('abort');
        })).rejects.toThrow('abort');
        expect(await libraryWriteStamp(lib)).toBe(before);
        let changed = false;
        await expect(reorganizeCoreLibrary(lib, async () => {
            if (!changed) { changed = true; await other.transaction(['library_meta'], 'readwrite', tx =>
                tx.put('library_meta', { id: 'daily-settings', schema: 1, value: {} } as Row)); }
            return true;
        })).rejects.toThrow('资料或页面已改变');
        const publish = vi.fn();
        await expect(publishUnchangedLibrary(lib, before, publish)).rejects.toThrow('资料已改变');
        expect(publish).not.toHaveBeenCalled();
        await publishUnchangedLibrary(lib, await libraryWriteStamp(lib), publish);
        expect(publish).toHaveBeenCalledOnce();
        await expect(reorganizeCoreLibrary(lib, async () => false)).rejects.toThrow('资料或页面已改变');
    } finally { lib.close(); other.close(); }
});

test('compact put/delete roots and archive deletion keep surviving source evidence valid', async () => {
    const { lib, branch } = await fixture(10);
    const report = await reorganizeCoreLibrary(lib, async () => true), target = await Library.open(report.library, true);
    try {
        const memory = (await target.all<MemoryRevision>('memory_revisions'))[0];
        await target.transaction(['memory_revisions'], 'readwrite', async tx => {
            await tx.put('memory_revisions', { ...memory, content: long } as MemoryRevision);
            const saved = await tx.get<MemoryRevision>('memory_revisions', memory.id);
            expect(saved?.content).toBe(long);
        });
        const plan = await previewArchiveDeletion(target, branch.id);
        await commitArchiveDeletion(target, plan, () => true);
        await exportLibrary(target);
        expect(await target.get('library_meta', SHARED_META)).toBeDefined();
    } finally { lib.close(); target.close(); }
});

test('compact writes preserve invocation order and returned arrays cannot mutate immutable blocks', async () => {
    const { lib } = await fixture(1), report = await reorganizeCoreLibrary(lib, async () => true);
    const target = await Library.open(report.library, true);
    try {
        const memory = (await target.all<MemoryRevision>('memory_revisions'))[0];
        await target.transaction(['memory_revisions'], 'readwrite', async tx => {
            const first = tx.put('memory_revisions', { ...memory, content: long } as MemoryRevision);
            const deleted = tx.delete('memory_revisions', memory.id);
            const added = tx.add('memory_revisions', { ...memory, content: long + '第二版' } as MemoryRevision);
            const read = tx.get<MemoryRevision>('memory_revisions', memory.id);
            await Promise.all([first, deleted, added]);
            expect((await read)?.content).toBe(long + '第二版');
        });
        const dependencies = Array.from({ length: 130 }, (_, i) => `revision-${i}`);
        const blocks = new Map<string, Payload>();
        const codec = new SharedPayloads(async key => blocks.get(key), async row => { blocks.set(row.id, structuredClone(row)); });
        const row = await codec.pack('memory_revisions', { ...memory, dependencies, content: long } as MemoryRevision);
        const read = await codec.unpack('memory_revisions', row) as MemoryRevision;
        read.dependencies.push('mutated');
        expect((await codec.unpack('memory_revisions', row) as MemoryRevision).dependencies).toEqual(dependencies);
    } finally { target.close(); lib.close(); }
});

test('parallel summary reads share in-flight blocks rather than reading the same dependencies once per summary', async () => {
    const blocks = new Map<string, Payload>();
    const writer = new SharedPayloads(async key => blocks.get(key), async row => { blocks.set(row.id, structuredClone(row)); });
    const original = { ...row('mr'), content: long, inputRefs: [], coverage: [], dependencies: Array.from({length:500}, (_, i) => `revision-${i}`) } as any;
    const packed = await writer.pack('memory_revisions', original);
    const load = vi.fn(async key => blocks.get(key));
    const reader = new SharedPayloads(load, async () => { throw new Error('readonly'); });
    const rows = await Promise.all(Array.from({ length: 100 }, () => reader.unpack('memory_revisions', packed)));
    expect(rows.every(row => JSON.stringify(row) === JSON.stringify(original))).toBe(true);
    expect(load).toHaveBeenCalledTimes(blocks.size);
});
