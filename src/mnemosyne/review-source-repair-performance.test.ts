import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { Library, Transaction } from './db';
import { capture, current } from './canonical';
import { fixture } from './fixtures';
import { ensureReviewSourceRepair } from './review-source-repair';
import type { Review } from './model';

afterEach(() => vi.restoreAllMocks());

/** Count actual IndexedDB work rather than elapsed time or implementation helpers. */
function observeDatabaseWork() {
    const reads: string[] = [], bulkReads: string[] = [], writes: { store: string; id?: string }[] = [];
    const reviewVisits = new Map<string, number>();
    const originalGet = IDBObjectStore.prototype.get;
    const originalGetAll = IDBObjectStore.prototype.getAll;
    const originalCursor = IDBObjectStore.prototype.openCursor;
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    const originalDelete = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
        reads.push(this.name);
        return originalGet.call(this, key);
    });
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
        bulkReads.push(this.name);
        return originalGetAll.apply(this, args);
    });
    vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args) {
        const request = originalCursor.apply(this, args);
        if (this.name === 'reviews') request.addEventListener('success', () => {
            const cursor = request.result;
            if (cursor) {
                const key = String(cursor.primaryKey);
                reviewVisits.set(key, (reviewVisits.get(key) ?? 0) + 1);
            }
        });
        return request;
    });
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        writes.push({ store: this.name, id: value?.id });
        return originalPut.call(this, value, key);
    });
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
        writes.push({ store: this.name, id: value?.id });
        return originalAdd.call(this, value, key);
    });
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
        writes.push({ store: this.name, id: String(key) });
        return originalDelete.call(this, key);
    });
    return { reads, bulkReads, writes, reviewVisits, clear() {
        reads.length = 0; bulkReads.length = 0; writes.length = 0; reviewVisits.clear();
    } };
}

test('300 old empty receipts scan once, avoid body reads, and invalidate another connection with one branch write', async () => {
    const { lib, view } = await fixture(1);
    const other = await Library.open(lib.db.name, true);
    try {
        const before = await capture(other, view.branch.id), memory = view.memories[0];
        const originals: Review[] = Array.from({ length: 300 }, (_, i) => ({
            id: `old-generated-review-${String(i).padStart(4, '0')}`, schema: 1,
            story: view.branch.story, branch: view.branch.id, owner: memory.id,
            snapshot: view.snapshot.id, decision: 'compatible', origin: 'generated_sidecar', created: i,
            reviewSchema: 2, sourceRefs: [], coverage: [], dependencies: [],
        }));
        await lib.transaction(['reviews'], 'readwrite', async tx => {
            for (const review of originals) await tx.add('reviews', review);
        });
        const work = observeDatabaseWork();
        const results = await Promise.all([ensureReviewSourceRepair(lib), ensureReviewSourceRepair(lib)]);
        expect(results[0]).toMatchObject({ disabled: 300, changed: true });
        expect(results[1]).toEqual(results[0]);
        expect(work.reviewVisits.size).toBe(300);
        expect([...work.reviewVisits.values()].every(visits => visits === 1)).toBe(true);
        expect(work.bulkReads).toEqual([]);
        expect(work.reads.filter(store => store === 'source_bodies' || store === 'source_revisions')).toEqual([]);
        expect(work.writes.filter(write => write.store === 'branches')).toEqual([{ store: 'branches', id: view.branch.id }]);
        expect(work.writes.filter(write => write.store === 'reviews')).toHaveLength(300);
        expect(work.writes.every(write => ['reviews', 'branches', 'library_meta', 'retention_control'].includes(write.store))).toBe(true);

        expect((await lib.get('branches', view.branch.id) as any).epoch).toBe(before.branch.epoch + 1);
        expect(await current(other, before)).toBe(false);
        const saved = await lib.all<Review>('reviews');
        expect(saved).toEqual(originals.map(review => ({ ...review,
            disabled: { version: 1, reason: 'empty_generated_sources' } })));

        work.clear();
        await ensureReviewSourceRepair(lib);
        expect(work.reviewVisits.size).toBe(0); expect(work.bulkReads).toEqual([]); expect(work.writes).toEqual([]);
        expect(work.reads.every(store => store === 'library_meta')).toBe(true);

        // A new connection must honor the durable completion record, not repeat the scan.
        work.clear();
        await ensureReviewSourceRepair(other);
        expect(work.reviewVisits.size).toBe(0); expect(work.bulkReads).toEqual([]); expect(work.writes).toEqual([]);
        expect(work.reads.every(store => store === 'library_meta')).toBe(true);
        expect(work.reads.length).toBeLessThanOrEqual(2);
    } finally { other.close(); lib.close(); }
});

test('an unaffected library completes maintenance without touching its branch or body data', async () => {
    const { lib, view } = await fixture(1);
    try {
        const review: Review = { id: 'valid-manual-review', schema: 1, story: view.branch.story,
            branch: view.branch.id, owner: view.memories[0].id, snapshot: view.snapshot.id,
            decision: 'compatible', origin: 'manual', created: 1, reviewSchema: 2,
            sourceRefs: view.refs, coverage: [], dependencies: [] };
        await lib.transaction(['reviews'], 'readwrite', tx => tx.add('reviews', review));
        const work = observeDatabaseWork();
        const result = await ensureReviewSourceRepair(lib);
        expect(result).toMatchObject({ disabled: 0, changed: false });
        expect(work.reviewVisits.get(review.id)).toBe(1);
        expect(work.bulkReads).toEqual([]);
        expect(work.reads.filter(store => store === 'source_bodies' || store === 'source_revisions')).toEqual([]);
        expect(work.writes.filter(write => write.store === 'reviews' || write.store === 'branches')).toEqual([]);
        work.clear();
        await ensureReviewSourceRepair(lib);
        expect(work.reviewVisits.size).toBe(0); expect(work.bulkReads).toEqual([]); expect(work.writes).toEqual([]);
    } finally { lib.close(); }
});

test('128 candidate anchors sharing one historical basis inspect that basis once per page', async () => {
    const { lib, view } = await fixture(128);
    try {
        await lib.transaction(['reviews'], 'readwrite', async tx => {
            for (const [i, memory] of view.memories.entries()) await tx.add('reviews', {
                id: `old-anchor-review-${String(i).padStart(4, '0')}`, schema: 1,
                story: view.branch.story, branch: view.branch.id, owner: memory.id,
                snapshot: view.snapshot.id, decision: 'compatible', origin: 'generated_sidecar', created: i,
                reviewSchema: 2, sourceRefs: [], coverage: [], dependencies: [],
            } as Review);
        });
        let inspected = 0;
        const seen = new WeakSet<object>(), originalGet = Transaction.prototype.get;
        vi.spyOn(Transaction.prototype, 'get').mockImplementation(async function (this: Transaction, store, key) {
            const value = await originalGet.call(this, store, key) as any;
            if (store === 'manifest_blocks' && value && !seen.has(value)) {
                seen.add(value);
                for (const ref of value.entries) {
                    const message = ref.message;
                    Object.defineProperty(ref, 'message', { configurable: true, enumerable: true,
                        get: () => { inspected++; return message; } });
                }
            }
            return value;
        });
        expect(await ensureReviewSourceRepair(lib)).toMatchObject({ disabled: 128, changed: true });
        // Counting identifier inspections catches repeated prefix walks even when
        // transaction-local block caching hides duplicate physical IndexedDB reads.
        expect(inspected).toBeLessThanOrEqual(view.refs.length * 2);
    } finally { lib.close(); }
});
