import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { capture, statuses, synchronize } from './canonical';
import { Transaction } from './db';
import { exportLibrary, restoreLibrary, validateData } from './migration';
import { ensureReviewSourceRepair, REVIEW_SOURCE_REPAIR_ID } from './review-source-repair';
import { row, type MemoryRevision, type Review } from './model';

afterEach(() => vi.restoreAllMocks());

function brokenReview(view: Awaited<ReturnType<typeof capture>>, memory = view.memories[0]): Review {
    return { ...row('review'), story: memory.story, branch: memory.branch, owner: memory.id,
        snapshot: view.snapshot.id, decision: 'compatible', origin: 'generated_sidecar', created: 1,
        reviewSchema: 2, sourceRefs: [], coverage: [], dependencies: [] };
}

test('known old empty approvals retain their evidence and become exportable/restorable without changing story content', async () => {
    const { lib, view, input } = await fixture(1);
    try {
        const review = brokenReview(view), original = structuredClone(view.memories[0]);
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', review));
        await expect(exportLibrary(lib)).rejects.toThrow('审核来源身份不匹配');
        expect(await ensureReviewSourceRepair(lib)).toEqual({ disabled: 1, changed: true });
        expect(await lib.get('memory_revisions', original.id)).toEqual(original);
        expect((await capture(lib, view.branch.id)).sources).toEqual(view.sources);
        expect(await lib.get('reviews', review.id)).toEqual({ ...review,
            disabled: { version: 1, reason: 'empty_generated_sources' } });
        const pack = await exportLibrary(lib);
        expect(pack.version).toBe(16);
        const copy = await restoreLibrary(pack, false);
        try { expect((await exportLibrary(copy)).data).toEqual(pack.data); } finally { copy.close(); }
        input.messages[0].content += ' subsequent source change';
        await synchronize(lib, input);
        expect((await statuses(lib, await capture(lib, view.branch.id))).get(original.id)).toBe('needs_review');
        await expect(exportLibrary(lib)).resolves.toBeDefined();
    } finally { lib.close(); }
});

test('maintenance includes unselected historical revisions and inactive archives', async () => {
    const { lib, view } = await fixture(1);
    try {
        const old: MemoryRevision = { ...view.memories[0], ...row('mr'), content: 'synthetic unselected history' };
        await lib.transaction(['memory_revisions', 'reviews'], 'readwrite', async tx => {
            await tx.add('memory_revisions', old);
            await tx.add('reviews', brokenReview(view, old));
        });
        const other = await synchronize(lib, { scope: 'another-archive', messages: [], memories: [] });
        expect(other.id).not.toBe(view.branch.id);
        expect(await ensureReviewSourceRepair(lib)).toMatchObject({ disabled: 1 });
        const pack = await exportLibrary(lib);
        expect(pack.data.memory_revisions.find(r => r.id === old.id)).toEqual(old);
        expect((await capture(lib, view.branch.id)).memories[0].id).toBe(view.memories[0].id);
    } finally { lib.close(); }
});

test('unknown/manual corruption remains blocked with archive, floor, field and receipt diagnostics', async () => {
    const { lib, view } = await fixture(1);
    try {
        const review = { ...brokenReview(view), origin: 'manual' as const };
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', review));
        expect(await ensureReviewSourceRepair(lib)).toEqual({ disabled: 0, changed: false });
        expect(await lib.get('reviews', review.id)).toEqual(review);
        await expect(exportLibrary(lib)).rejects.toThrow('来源列表应有 2 条，实际 0 条');
        await expect(exportLibrary(lib)).rejects.toThrow(`档案：synthetic-chat；摘要楼层 #1；审核：${review.id}`);
    } finally { lib.close(); }
});

test('disabled is a narrowly validated defect receipt, never a general bypass for malformed approvals', async () => {
    const { lib, view } = await fixture(1);
    try {
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', brokenReview(view)));
        await ensureReviewSourceRepair(lib);
        const pack = await exportLibrary(lib);
        for (const change of [
            (p: typeof pack) => { (p.data.reviews[0] as Review).sourceRefs = view.refs; },
            (p: typeof pack) => { (p.data.reviews[0] as Review).origin = 'manual'; },
            (p: typeof pack) => { (p.data.reviews[0] as Review).disabled = { version: 1, reason: 'arbitrary' } as any; },
            (p: typeof pack) => { p.version = 15; },
        ]) {
            const forged = structuredClone(pack); change(forged);
            expect(() => validateData(forged)).toThrow();
        }
    } finally { lib.close(); }
});

test('a scope change aborts the current batch and leaves no completion marker; a later attempt resumes safely', async () => {
    const { lib, view } = await fixture(1);
    try {
        const review = brokenReview(view);
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', review));
        let current = true;
        const original = Transaction.prototype.put;
        const spy = vi.spyOn(Transaction.prototype, 'put').mockImplementation(function (this: Transaction, store, value) {
            if (store === 'reviews') current = false;
            return original.call(this, store, value);
        });
        await expect(ensureReviewSourceRepair(lib, () => current)).rejects.toThrow('审核修复已暂停');
        spy.mockRestore();
        expect(await lib.get('reviews', review.id)).toEqual(review);
        expect(await lib.get('library_meta', REVIEW_SOURCE_REPAIR_ID)).toBeUndefined();
        expect((await lib.get<any>('branches', view.branch.id)).epoch).toBe(view.branch.epoch);
        expect(await ensureReviewSourceRepair(lib)).toMatchObject({ disabled: 1 });
        await expect(exportLibrary(lib)).resolves.toBeDefined();
    } finally { lib.close(); }
});
