import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { capture, confirmRecoveredSummaries, forkBranch, statuses, synchronize } from './canonical';
import { Transaction } from './db';
import { exportLibrary } from './migration';
import { row, type CapturedView, type MemoryRevision, type Review } from './model';

afterEach(() => vi.restoreAllMocks());

function receipt(view: CapturedView, memory: MemoryRevision, fields: Partial<Review> = {}): Review {
    return { ...row('review'), story: view.branch.story, branch: view.branch.id, owner: memory.id,
        snapshot: view.snapshot.id, decision: 'compatible', origin: 'manual', created: Date.now(),
        reviewSchema: 2, sourceRefs: view.refs, coverage: [], dependencies: [], ...fields };
}

async function annotatedSummary() {
    const f = await fixture(1), host = f.input.memories[0];
    host.inputRefs = f.view.refs; host.coverage = f.view.refs;
    host.basisSnapshot = f.view.snapshot.id; host.generatedSidecar = true;
    f.input.messages[1].content += '\n<bbs_vars>合成旁注</bbs_vars>';
    await synchronize(f.lib, f.input);
    return { ...f, view: await capture(f.lib, f.branch.id) };
}

test('confirming an annotated generated summary never writes empty sidecar approvals or masks later source edits', async () => {
    const f = await annotatedSummary();
    try {
        const before = await f.lib.all<Review>('reviews');
        expect(before).toHaveLength(1); expect(before[0].sourceRefs).toHaveLength(2);
        await confirmRecoveredSummaries(f.lib, f.view, [f.view.memories[0].id]);
        await synchronize(f.lib, f.input);
        const confirmed = await capture(f.lib, f.branch.id);
        expect(confirmed.memories[0].inputRefs).toEqual([]);
        expect(await f.lib.all('reviews')).toEqual(before);
        expect((await statuses(f.lib, confirmed)).get(confirmed.memories[0].id)).toBe('valid');
        await expect(exportLibrary(f.lib)).resolves.toBeDefined();
        // Keep the anchor annotation/evidence unchanged, as ordinary earlier edits do.
        f.input.messages[0].content += '实际剧情修改';
        await synchronize(f.lib, f.input);
        const changed = await capture(f.lib, f.branch.id);
        expect(changed.memories[0].id).toBe(confirmed.memories[0].id);
        expect((await statuses(f.lib, changed)).get(confirmed.memories[0].id)).toBe('needs_review');
    } finally { f.lib.close(); }
});

test('an existing empty generated receipt cannot approve later edits or propagate into a child before repair', async () => {
    const f = await annotatedSummary();
    try {
        await confirmRecoveredSummaries(f.lib, f.view, [f.view.memories[0].id]);
        const confirmed = await capture(f.lib, f.branch.id);
        const bad = receipt(confirmed, confirmed.memories[0], { origin: 'generated_sidecar', sourceRefs: [] });
        await f.lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', bad));
        const child = await forkBranch(f.lib, confirmed, 'receipt-child');
        expect((await f.lib.all<Review>('reviews', 'branch', child.id))).toEqual([]);
        expect((await capture(f.lib, child.id)).memories).toHaveLength(1);
        f.input.messages[0].content += '实际剧情修改';
        await synchronize(f.lib, f.input);
        const changed = await capture(f.lib, f.branch.id);
        expect((await statuses(f.lib, changed)).get(confirmed.memories[0].id)).toBe('needs_review');
        expect(await f.lib.get('reviews', bad.id)).toEqual(bad);
    } finally { f.lib.close(); }
});

test.each(['input', 'coverage', 'legacy-order'] as const)('live status rejects current but unrelated %s identities', async kind => {
    const f = await fixture(2);
    try {
        if (kind !== 'legacy-order') {
            f.input.memories[0].inputRefs = f.view.refs.slice(0, 2);
            f.input.memories[0].coverage = kind === 'coverage' ? f.view.refs.slice(0, 2) : [];
            await synchronize(f.lib, f.input);
        }
        if (kind === 'legacy-order') [f.input.messages[0], f.input.messages[1]] = [f.input.messages[1], f.input.messages[0]];
        else f.input.messages[0].content += '修改正文';
        await synchronize(f.lib, f.input);
        const current = await capture(f.lib, f.branch.id);
        const memory = current.memories.find(m => m.hostId === (kind === 'legacy-order' ? 'leaf-1' : 'leaf-0'))!;
        const bad = receipt(current, memory, {
            sourceRefs: kind === 'input' ? current.refs.slice(2) : kind === 'coverage' ? current.refs.slice(0, 2) : current.refs,
            coverage: kind === 'coverage' ? current.refs.slice(2) : [],
        });
        await f.lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', bad));
        expect((await statuses(f.lib, current)).get(memory.id)).toBe('needs_review');
    } finally { f.lib.close(); }
});

test('a high-summary review cannot replace a changed child with another valid family', async () => {
    const f = await fixture(2);
    try {
        f.input.memories.push({ ...f.input.memories[0], hostId: 'high', level: 1, anchorKey: null, children: ['leaf-0'] });
        await synchronize(f.lib, f.input);
        f.input.memories[0].content += '改写摘要';
        await synchronize(f.lib, f.input);
        const current = await capture(f.lib, f.branch.id), high = current.memories.find(m => m.hostId === 'high')!;
        const other = current.memories.find(m => m.hostId === 'leaf-1')!;
        const bad = receipt(current, high, { sourceRefs: [], dependencies: [other.id] });
        await f.lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', bad));
        expect((await statuses(f.lib, current)).get(high.id)).toBe('needs_rebuild');
    } finally { f.lib.close(); }
});

test('disabled receipts are ignored by status and cannot be inherited', async () => {
    const f = await annotatedSummary();
    try {
        const review = (await f.lib.all<Review>('reviews'))[0];
        await f.lib.transaction(['reviews'], 'readwrite', tx => tx.put('reviews', {
            ...review, disabled: { version: 1, reason: 'empty_generated_sources' },
        } as Review));
        expect((await statuses(f.lib, f.view)).get(f.view.memories[0].id)).toBe('needs_review');
        const child = await forkBranch(f.lib, f.view, 'disabled-review-child');
        expect(await f.lib.all<Review>('reviews', 'branch', child.id)).toEqual([]);
        expect((await capture(f.lib, child.id)).memories).toEqual([]);
    } finally { f.lib.close(); }
});

test('200 repeated legacy receipts share basis/block reads and never load source bodies', async () => {
    const f = await fixture(100);
    try {
        const memory = f.view.memories.at(-1)!;
        await f.lib.transaction(['reviews'], 'readwrite', async tx => {
            for (let i = 0; i < 200; i++) await tx.add('reviews', receipt(f.view, memory, { created: i }));
        });
        const get = vi.spyOn(Transaction.prototype, 'get'), all = vi.spyOn(Transaction.prototype, 'all');
        expect((await statuses(f.lib, f.view)).get(memory.id)).toBe('valid');
        const proofs = get.mock.calls.filter(([store]) => store === 'history_snapshots' || store === 'manifest_blocks');
        expect(proofs).toHaveLength(1 + f.view.snapshot.blocks.length);
        expect(new Set(proofs.map(([store, id]) => `${store}:${String(id)}`)).size).toBe(proofs.length);
        expect(get.mock.calls.some(([store]) => store === 'source_bodies' || store === 'source_revisions')).toBe(false);
        expect(all.mock.calls.every(([store, index]) => store === 'reviews' && index === 'branch')).toBe(true);
    } finally { f.lib.close(); }
});
