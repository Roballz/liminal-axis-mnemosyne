import type { Library, Transaction } from './db';
import { check, equal, type Block, type Branch, type MemoryRevision, type Review, type Row, type Snapshot } from './model';

export const REVIEW_SOURCE_REPAIR_ID = 'review-source-repair-v1';
const PAGE_SIZE = 128;
const DISABLED = { version: 1, reason: 'empty_generated_sources' } as const;
interface Receipt extends Row { value: { version: 1; disabled: number; completedAt: number } }
export interface ReviewRepairResult { disabled: number; changed: boolean }
const running = new WeakMap<Library, Promise<ReviewRepairResult>>();

/** A narrow known defect: a generated approval was written for a prefix-based
 * L0 memory, although the approval contains no source evidence at all. The
 * original record stays intact; disabling it does not manufacture an approval. */
export function isEmptyGeneratedReview(review: Review, memory: MemoryRevision, nonemptyBasis: boolean): boolean {
    return nonemptyBasis && review.reviewSchema === 2 && review.origin === 'generated_sidecar' &&
        review.decision === 'compatible' && review.owner === memory.id &&
        review.branch === memory.branch && review.story === memory.story &&
        Array.isArray(review.sourceRefs) && review.sourceRefs.length === 0 &&
        Array.isArray(review.coverage) && review.coverage.length === 0 &&
        Array.isArray(review.dependencies) && review.dependencies.length === 0 &&
        !memory.sourceRecovery && memory.level === 0 && !!memory.anchor &&
        Array.isArray(memory.inputRefs) && memory.inputRefs.length === 0 &&
        Array.isArray(memory.coverage) && memory.coverage.length === 0 &&
        Array.isArray(memory.dependencies) && memory.dependencies.length === 0;
}

export function validReviewRepairReceipt(row: Row & { value?: any }): row is Receipt {
    const value = row.value;
    return row.id === REVIEW_SOURCE_REPAIR_ID && value?.version === 1 &&
        Object.keys(value).length === 3 && Number.isSafeInteger(value.disabled) && value.disabled >= 0 &&
        Number.isSafeInteger(value.completedAt) && value.completedAt > 0;
}

function isCandidate(review: Review) {
    return !review.disabled && review.reviewSchema === 2 && review.origin === 'generated_sidecar' &&
        Array.isArray(review.sourceRefs) && !review.sourceRefs.length;
}

/** Each cursor transaction finishes after a bounded number of rows. Never clone
 * all historical approvals (many contain long source prefixes) onto the UI. */
function readPage(tx: Transaction, after: string | undefined) {
    return new Promise<{ candidates: Review[]; last?: string; done: boolean }>((resolve, reject) => {
        const request = tx.native.objectStore('reviews').openCursor(after ? IDBKeyRange.lowerBound(after, true) : undefined);
        const candidates: Review[] = [];
        let count = 0;
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { resolve({ candidates, done: true }); return; }
            const review = cursor.value as Review;
            if (isCandidate(review)) candidates.push(review);
            if (++count === PAGE_SIZE) { resolve({ candidates, last: String(cursor.primaryKey), done: false }); return; }
            cursor.continue();
        };
    });
}

interface Plan { review: Review; memory: MemoryRevision }
async function planPage(lib: Library, reviews: Review[]): Promise<Plan[]> {
    if (!reviews.length) return [];
    return lib.transaction(['memory_revisions', 'history_snapshots', 'manifest_blocks'], 'readonly', async tx => {
        // Bounded to this page; no retained full-library or growing prefix cache.
        const memories = new Map<string, Promise<MemoryRevision | undefined>>();
        const candidates = await Promise.all(reviews.map(async review => {
            if (!memories.has(review.owner)) memories.set(review.owner, tx.get<MemoryRevision>('memory_revisions', review.owner));
            const memory = await memories.get(review.owner);
            if (!memory || !isEmptyGeneratedReview(review, memory, true)) return undefined;
            return { review, memory };
        }));
        const groups = new Map<string, Plan[]>();
        for (const plan of candidates) if (plan) {
            const group = groups.get(plan.memory.basis) ?? [];
            group.push(plan); groups.set(plan.memory.basis, group);
        }
        const blocks = new Map<string, Set<string> | undefined>(), plans: Plan[] = [];
        for (const [basis, group] of groups) {
            const snapshot = await tx.get<Snapshot>('history_snapshots', basis);
            if (!snapshot || snapshot.length < 1) continue;
            const eligible = group.filter(plan => plan.memory.story === snapshot.story);
            const targets = new Set(eligible.map(plan => plan.memory.anchor!)), found = new Set<string>();
            for (const id of snapshot.blocks) {
                if (!blocks.has(id)) {
                    const block = await tx.get<Block>('manifest_blocks', id);
                    blocks.set(id, block && new Set(block.entries.map(ref => ref.message)));
                }
                const messages = blocks.get(id);
                if (!messages) break;
                for (const anchor of targets) if (messages.has(anchor)) { targets.delete(anchor); found.add(anchor); }
                if (!targets.size) break;
            }
            plans.push(...eligible.filter(plan => found.has(plan.memory.anchor!)));
        }
        return plans;
    });
}

async function repair(lib: Library, isCurrent: () => boolean): Promise<ReviewRepairResult> {
    const guard = () => check(isCurrent(), '档案库已切换，审核修复已暂停；下次备份会继续');
    guard();
    const receipt = await lib.get<Receipt>('library_meta', REVIEW_SOURCE_REPAIR_ID);
    if (receipt) {
        check(validReviewRepairReceipt(receipt), '审核修复回执格式错误');
        return { disabled: 0, changed: false };
    }
    const advanced = new Set<string>();
    let after: string | undefined, disabled = 0;
    for (;;) {
        guard();
        const page = await lib.transaction(['reviews'], 'readonly', tx => readPage(tx, after));
        const plans = await planPage(lib, page.candidates);
        guard();
        if (plans.length) {
            const result = await lib.transaction(['reviews', 'memory_revisions', 'branches'], 'readwrite', async tx => {
                guard();
                let changed = 0;
                const branches = new Set<string>();
                for (const plan of plans) {
                    const [review, memory] = await Promise.all([
                        tx.get<Review>('reviews', plan.review.id), tx.get<MemoryRevision>('memory_revisions', plan.memory.id),
                    ]);
                    if (!review || review.disabled) continue; // Concurrent archive deletion/repair wins.
                    check(memory && equal(review, plan.review) && equal(memory, plan.memory), '审核记录已改变，修复已暂停；请重试备份');
                    await tx.put('reviews', { ...review, disabled: DISABLED } as Review);
                    changed++;
                    if (!advanced.has(review.branch)) branches.add(review.branch);
                }
                for (const id of branches) {
                    const branch = await tx.get<Branch>('branches', id);
                    check(branch, '审核所属档案已改变，修复已暂停');
                    await tx.put('branches', { ...branch, epoch: branch.epoch + 1 } as Branch);
                }
                guard();
                return { changed, branches };
            });
            disabled += result.changed;
            for (const id of result.branches) advanced.add(id);
        }
        if (page.done) break;
        after = page.last;
        // IDB transactions are closed before yielding, so normal page work and
        // archive writes are never held behind a full-library maintenance lock.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    guard();
    await lib.transaction(['library_meta'], 'readwrite', async tx => {
        const existing = await tx.get<Receipt>('library_meta', REVIEW_SOURCE_REPAIR_ID);
        if (!existing) await tx.add('library_meta', { id: REVIEW_SOURCE_REPAIR_ID, schema: 1,
            value: { version: 1, disabled, completedAt: Date.now() } } as Receipt);
        guard();
    });
    return { disabled, changed: disabled > 0 };
}

/** Explicit, bounded preparation on the normal library connection, before a
 * backup captures its guard. Export/backup Workers remain read-only on live DBs.
 * Repeated calls share one job; after success even the cursor scan is skipped. */
export async function ensureReviewSourceRepair(lib: Library, isCurrent: () => boolean = () => true): Promise<ReviewRepairResult> {
    check(isCurrent(), '档案库已切换，审核修复未开始');
    let pending = running.get(lib);
    if (!pending) {
        pending = repair(lib, isCurrent);
        running.set(lib, pending);
        void pending.then(() => running.set(lib, Promise.resolve({ disabled: 0, changed: false })), () => running.delete(lib));
    }
    const result = await pending;
    check(isCurrent(), '档案库已切换，审核修复已暂停');
    return result;
}
