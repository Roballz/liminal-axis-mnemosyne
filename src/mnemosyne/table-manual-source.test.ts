import { afterEach, expect, test, vi } from 'vitest';
import { fixture, observation } from './fixtures';
import { capture, statuses, synchronize, forkBranch, type HostMemory } from './canonical';
import { Transaction } from './db';
import { allowedTableSources, newTable, renderTableState, type TableInput } from './tables';
import type { CapturedView, MemoryRevision, TableRow } from './model';

afterEach(() => vi.restoreAllMocks());
type Fixture = Awaited<ReturnType<typeof fixture>>;
const leaf = (view: CapturedView, host = 'leaf-0') => view.memories.find(memory => memory.hostId === host)!;
function manuallyEdit(host: HostMemory) {
    host.content += '（人工校字）'; host.manualEdit = true;
    host.generationKey = (host.generationKey ?? 0) + 1; host.children = [];
    // The bridge's manual marker takes precedence over the old generation sidecar.
    delete host.inputRefs; delete host.coverage; delete host.basisSnapshot;
    delete host.generatedSidecar; delete host.declaration;
}
async function sync(f: Fixture) {
    await synchronize(f.lib, f.input);
    const view = await capture(f.lib, f.branch.id);
    return { view, validity: await statuses(f.lib, view) };
}
function table(view: CapturedView, sources: string[], count = 1): TableInput[] {
    const def = newTable(view, '人工修订来源表');
    def.columns = [{ id: 'name', name: '名称', type: 'text', mode: 'replace', description: '' }];
    const rows: TableRow[] = Array.from({ length: count }, (_, i) => ({
        id: `table-row-${i}`, schema: 1, story: def.story, branch: def.branch, owner: def.id,
        version: 1, deleted: false, sources: sources.slice(), values: { name: `S-${String(i + 1).padStart(3, '0')}` },
    }));
    return [{ def, rows }];
}

test('legacy prefix survives appended tail and repeated manual edits with accumulated source IDs', async () => {
    const f = await fixture(2), old = leaf(f.view);
    try {
        expect(old.inputRefs).toEqual([]);
        f.input.messages.push({ key: 'later-tail', role: 'user', content: '后来追加但不属于原摘要的正文', swipe: 0 });
        await sync(f); manuallyEdit(f.input.memories[0]);
        let { view, validity } = await sync(f);
        const first = leaf(view);
        expect(first.basis).not.toBe(old.basis);
        expect(first.inputRefs).toEqual(f.view.refs.slice(0, 2));
        expect(validity.get(first.id)).toBe('valid');
        expect((await allowedTableSources(f.lib, view, table(view, [old.id]), validity)).has(old.id)).toBe(true);
        manuallyEdit(f.input.memories[0]); ({ view, validity } = await sync(f));
        expect(leaf(view).id).not.toBe(first.id);
        const inputs = table(view, [old.id, first.id]), before = structuredClone(inputs);
        const allowed = await allowedTableSources(f.lib, view, inputs, validity);
        expect([old.id, first.id].every(id => allowed.has(id))).toBe(true);
        expect(renderTableState(inputs, allowed)).toContain('S-001');
        expect(inputs).toEqual(before);
        expect(await f.lib.get('memory_revisions', old.id)).toEqual(old);
    } finally { f.lib.close(); }
});

test.each(['body-edit', 'same-text-swipe', 'private', 'disabled', 'removed', 'missing-basis',
    'source-recovery', 'other-branch', 'expanded-range', 'other-invalid-source'] as const)
('manual approval does not admit historical table sources after %s', async kind => {
    const f = await fixture(2);
    try {
        let old = leaf(f.view);
        const host = f.input.memories[0];
        if (kind === 'source-recovery') {
            host.inputRefs = f.view.refs.slice(0, 2); host.basisSnapshot = 'missing-generation-basis';
            old = leaf((await sync(f)).view);
            expect(old.sourceRecovery).toBeDefined();
        }
        if (kind === 'expanded-range') {
            host.inputRefs = f.view.refs; host.basisSnapshot = f.view.snapshot.id;
            host.generatedSidecar = true; host.generationKey = 1;
            await sync(f);
        }
        if (kind === 'other-branch') {
            const foreign = await synchronize(f.lib, observation(1, 'foreign-table-source'));
            old = leaf(await capture(f.lib, foreign.id));
        }
        const sources = [old.id];
        if (kind === 'body-edit') f.input.messages[0].content += '实际剧情改变';
        if (kind === 'same-text-swipe') f.input.messages[1].swipe++;
        if (kind === 'other-invalid-source') {
            sources.push(leaf(f.view, 'leaf-1').id);
            f.input.messages[2].content += '另一来源正文改变';
            manuallyEdit(f.input.memories[1]);
        }
        manuallyEdit(host);
        if (kind === 'private') host.private = true;
        if (kind === 'disabled') host.enabled = false;
        if (kind === 'removed') f.input.memories.shift();
        const { view, validity } = await sync(f);
        if (!['private', 'disabled', 'removed'].includes(kind)) expect(validity.get(leaf(view).id)).toBe('valid');
        if (kind === 'same-text-swipe') {
            expect(view.refs[1]).toEqual(f.view.refs[1]);
            expect(view.snapshot.variants![1]).not.toBe(f.view.snapshot.variants![1]);
        }
        if (kind === 'expanded-range') expect(leaf(view).inputRefs).toEqual(f.view.refs);
        if (kind === 'missing-basis') await f.lib.transaction(['memory_revisions'], 'readwrite', tx =>
            tx.put('memory_revisions', { ...old, basis: 'missing-historical-basis' } as MemoryRevision));
        const inputs = table(view, sources), allowed = await allowedTableSources(f.lib, view, inputs, validity);
        expect(renderTableState(inputs, allowed)).not.toContain('S-001');
        if (kind === 'other-invalid-source') {
            expect(allowed.has(old.id)).toBe(true);
            expect(allowed.has(sources[1])).toBe(false);
        } else expect(allowed.has(old.id)).toBe(false);
    } finally { f.lib.close(); }
});

test('200 table rows share historical source, snapshot and block reads without loading retired bodies', async () => {
    const f = await fixture(2), old = leaf(f.view);
    try {
        f.input.messages.push({ key: 'later-tail', role: 'user', content: '新增尾部', swipe: 0 });
        await sync(f); manuallyEdit(f.input.memories[0]);
        const { view, validity } = await sync(f), inputs = table(view, [old.id], 200);
        const get = vi.spyOn(Transaction.prototype, 'get'), all = vi.spyOn(Transaction.prototype, 'all');
        const allowed = await allowedTableSources(f.lib, view, inputs, validity);
        expect(renderTableState(inputs, allowed).split('\n').filter(line => line.startsWith('- '))).toHaveLength(200);
        expect(get.mock.calls.filter(([store, id]) => store === 'memory_revisions' && id === old.id)).toHaveLength(1);
        const proofs = get.mock.calls.filter(([store]) => store === 'history_snapshots' || store === 'manifest_blocks');
        expect(proofs.some(([store]) => store === 'history_snapshots')).toBe(true);
        expect(new Set(proofs.map(([store, id]) => `${store}:${String(id)}`)).size).toBe(proofs.length);
        expect(get.mock.calls.some(([store]) => store === 'source_bodies')).toBe(false);
        expect(all.mock.calls.some(([store]) => store === 'memory_revisions' || store === 'source_bodies')).toBe(false);
        expect(inputs[0].rows.every(record => record.sources.length === 1 && record.sources[0] === old.id)).toBe(true);
    } finally { f.lib.close(); }
});

test('table-specific source continuity does not approve a higher summary after its child text changes', async () => {
    const f = await fixture(2), old = leaf(f.view);
    try {
        f.input.memories.push({ hostId: 'high', content: '旧高层摘要', level: 1, anchorKey: null,
            children: ['leaf-0', 'leaf-1'], storyTime: '', seed: false, enabled: true });
        const before = await sync(f), high = leaf(before.view, 'high');
        expect(before.validity.get(high.id)).toBe('valid');
        manuallyEdit(f.input.memories[0]);
        const { view, validity } = await sync(f);
        expect(validity.get(high.id)).toBe('needs_rebuild');
        const inputs = table(view, [old.id]), allowed = await allowedTableSources(f.lib, view, inputs, validity);
        expect(renderTableState(inputs, allowed)).toContain('S-001');
        expect((await statuses(f.lib, view)).get(high.id)).toBe('needs_rebuild');
        expect(await f.lib.get('memory_revisions', high.id)).toEqual(high);
    } finally { f.lib.close(); }
});

test('manual correction of inherited summary uses its retained parent basis without admitting parent source IDs', async () => {
    const f = await fixture(2);
    try {
        const child = await forkBranch(f.lib, f.view, 'manual-child');
        const inherited = await capture(f.lib, child.id), original = leaf(inherited);
        expect(original.basis).toBe(leaf(f.view).basis);
        const input = structuredClone(f.input); input.scope = 'manual-child';
        manuallyEdit(input.memories[0]); await synchronize(f.lib, input);
        const view = await capture(f.lib, child.id), validity = await statuses(f.lib, view);
        const inputs = table(view, [original.id]);
        const allowed = await allowedTableSources(f.lib, view, [...inputs, ...table(view, [leaf(f.view).id])], validity);
        expect(allowed.has(original.id)).toBe(true);
        expect(allowed.has(leaf(f.view).id)).toBe(false);
        expect(renderTableState(inputs, allowed)).toContain('S-001');
        input.messages[0].content += '子分支实际剧情改变'; manuallyEdit(input.memories[0]);
        await synchronize(f.lib, input);
        const changed = await capture(f.lib, child.id);
        expect(renderTableState(inputs, await allowedTableSources(f.lib, changed, inputs, await statuses(f.lib, changed)))).toBe('');
    } finally { f.lib.close(); }
});
