import { dependencyOnly, sameNarrativeRevision, type MemoryStatus } from './canonical';
import type { Transaction } from './db';
import { equal, type Block, type CapturedView, type MemoryRevision, type Review, type Snapshot, type SourceRef } from './model';
import { sourceRefMatches } from './source-equivalence';

const MANUAL_EDIT = '人工修订摘要：以当前来源版本确认内容；原生成版本保留。';
type Span = { offset: number; block: Block };
type Basis = { snapshot: Snapshot; spans: Span[]; loaded: number; next: number; broken?: boolean };
type Point = { ref: SourceRef; swipe: number };
// A legacy scope is a prefix length, never a copy of every historical ref.
type Scope = readonly SourceRef[] | number;
type Proof = { scope: Scope; coverage: readonly SourceRef[] };

/** Table receipts retain the output of earlier summaries. Only this projection may
 * follow proven manual corrections; event overviews still depend on exact text.
 * Validate roots sequentially. The caller owns the final live-view/host guard. */
export function createTableSourceValidator(tx: Transaction, view: CapturedView,
    validity: Map<string, MemoryStatus>, known: readonly MemoryRevision[] = []) {
    const selected = new Map(view.memories.map(memory => [memory.owner, memory]));
    const memories = new Map<string, Promise<MemoryRevision | undefined>>(
        [...known, ...view.memories].map(memory => [memory.id, Promise.resolve(memory)]));
    const positions = new Map(view.refs.map((ref, i) => [ref.message, i]));
    const snapshots = new Map<string, Promise<Basis | undefined>>();
    const blocks = new Map<string, Promise<Block | undefined>>();
    const reviews = new Map<string, Promise<Review[]>>();
    const proofs = new Map<string, Promise<Proof | undefined>>();
    const results = new Map<string, boolean>(), active = new Set<string>();
    const prefixes = new Map<string, Map<number, { count: number; failed: boolean }>>();
    // Forked, branch-local summaries retain their parent's immutable basis. The
    // memory identities remain branch-local; exact refs/swipes prove the basis.
    const basis = (snapshot: Snapshot | undefined): Basis | undefined => snapshot &&
        snapshot.story === view.branch.story &&
        Number.isSafeInteger(snapshot.length) && snapshot.length >= 0 && Array.isArray(snapshot.blocks) &&
        (!snapshot.variants || snapshot.variants.length === snapshot.length)
        ? { snapshot, spans: [], loaded: 0, next: 0 } : undefined;
    const currentBasis = basis(view.snapshot);
    snapshots.set(view.snapshot.id, Promise.resolve(currentBasis));
    const readMemory = (id: string) => {
        if (!memories.has(id)) memories.set(id, tx.get<MemoryRevision>('memory_revisions', id));
        return memories.get(id)!;
    };
    const readBasis = (id: string) => {
        if (!snapshots.has(id)) snapshots.set(id, tx.get<Snapshot>('history_snapshots', id).then(basis));
        return snapshots.get(id)!;
    };
    const readBlock = (id: string) => {
        if (!blocks.has(id)) blocks.set(id, tx.get<Block>('manifest_blocks', id));
        return blocks.get(id)!;
    };
    const validSwipe = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! >= 0;
    const swipeAt = (base: Basis, span: Span, index: number) => base.snapshot.snapshotSchema === 2
        ? span.block.variants?.[index - span.offset] : base.snapshot.variants?.[index] ?? 0;
    function cachedPoint(base: Basis | undefined, index: number): Point | undefined {
        if (!base || base.broken || index < 0 || index >= base.snapshot.length) return;
        if (base === currentBasis && index < view.refs.length &&
            (view.snapshot.variants || view.snapshot.snapshotSchema !== 2)) {
            const swipe = view.snapshot.variants?.[index] ?? 0;
            return validSwipe(swipe) ? { ref: view.refs[index], swipe } : undefined;
        }
        if (base.loaded <= index) return;
        let lo = 0, hi = base.spans.length - 1;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (base.spans[mid].offset <= index) lo = mid; else hi = mid - 1;
        }
        const span = base.spans[lo], swipe = swipeAt(base, span, index);
        return validSwipe(swipe) ? { ref: span.block.entries[index - span.offset], swipe } : undefined;
    }
    async function point(base: Basis | undefined, index: number): Promise<Point | undefined> {
        const cached = cachedPoint(base, index);
        if (cached || !base || base.broken || index < 0 || index >= base.snapshot.length) return cached;
        while (base.loaded <= index && base.next < base.snapshot.blocks.length) {
            const block = await readBlock(base.snapshot.blocks[base.next++]);
            if (!block || !Array.isArray(block.entries) || !block.entries.length || (base.snapshot.snapshotSchema === 2 &&
                block.variants?.length !== block.entries.length)) { base.broken = true; return; }
            base.spans.push({ offset: base.loaded, block }); base.loaded += block.entries.length;
            if (base.loaded > base.snapshot.length ||
                (base.next === base.snapshot.blocks.length && base.loaded !== base.snapshot.length)) {
                base.broken = true; return;
            }
        }
        if (base.loaded <= index) { base.broken = true; return; }
        return cachedPoint(base, index);
    }
    const currentSwipe = (index: number) => point(currentBasis, index).then(value => value?.swipe);
    // A confirmed role repair may be recorded on either side of an old basis;
    // applicability to the current ref is still checked in the forward direction.
    const sameBodyRef = (a: SourceRef, b: SourceRef) =>
        sourceRefMatches(view.branch, a, b) || sourceRefMatches(view.branch, b, a);
    const currentRefs = (refs: readonly SourceRef[]) => refs.every(ref =>
        sourceRefMatches(view.branch, ref, view.refs[positions.get(ref.message) ?? -1]));
    async function refsAt(base: Basis, refs: readonly SourceRef[], contiguous = false) {
        let previous = -1;
        for (const ref of refs) {
            const index = positions.get(ref.message) ?? -1;
            if (index < 0 || index <= previous || (contiguous && previous >= 0 && index !== previous + 1)) return false;
            // Captured refs and loaded blocks stay synchronous in this hot loop.
            const old = cachedPoint(base, index) ?? await point(base, index);
            const now = cachedPoint(currentBasis, index) ?? await point(currentBasis, index);
            if (!old || !now || !sameBodyRef(ref, old.ref) || old.swipe !== now.swipe) return false;
            previous = index;
        }
        return true;
    }
    async function prefixAt(base: Basis, length: number) {
        if (length > view.refs.length || length > base.snapshot.length) return false;
        if (!length) return true;
        if (!await point(base, length - 1)) return false;
        if (base === currentBasis) return true; // capture already verified this exact prefix.
        for (const span of base.spans) {
            if (span.offset >= length) break;
            const key = base.snapshot.snapshotSchema === 2 ? span.block.id + ':v2'
                : base.snapshot.variants ? base.snapshot.id + ':' + span.block.id : span.block.id + ':v0';
            let offsets = prefixes.get(key);
            if (!offsets) { offsets = new Map(); prefixes.set(key, offsets); }
            let state = offsets.get(span.offset);
            if (!state) { state = { count: 0, failed: false }; offsets.set(span.offset, state); }
            const needed = Math.min(span.block.entries.length, length - span.offset);
            while (!state.failed && state.count < needed) {
                const index = span.offset + state.count, swipe = swipeAt(base, span, index);
                const now = cachedPoint(currentBasis, index) ?? await point(currentBasis, index);
                if (!sourceRefMatches(view.branch, span.block.entries[state.count], view.refs[index]) ||
                    !now || !validSwipe(swipe) || swipe !== now.swipe) state.failed = true;
                else state.count++;
            }
            if (state.count < needed) return false;
        }
        return true;
    }
    const sameRange = (a: readonly SourceRef[], b: readonly SourceRef[]) =>
        a.length === b.length && a.every((ref, i) => ref.message === b[i].message);
    async function prove(memory: MemoryRevision): Promise<Proof | undefined> {
        const base = await readBasis(memory.basis);
        if (!base) return;
        const anchorIndex = memory.anchor ? positions.get(memory.anchor) ?? -1 : -1;
        if (memory.anchor && anchorIndex < 0) return;
        const scope: Scope = memory.inputRefs.length ? memory.inputRefs : dependencyOnly(memory) ? []
            : memory.anchor ? anchorIndex + 1 : base.snapshot.length;
        if (!(typeof scope === 'number' ? await prefixAt(base, scope) : await refsAt(base, scope)) ||
            !await refsAt(base, memory.coverage, true)) return;
        const anchor = memory.anchor ? await point(base, anchorIndex) : undefined;
        if (memory.anchor && (!anchor || anchor.swipe !== await currentSwipe(anchorIndex))) return;
        if ((typeof scope === 'number' || currentRefs(scope)) && currentRefs(memory.coverage) &&
            (!anchor || sourceRefMatches(view.branch, anchor.ref, view.refs[anchorIndex])))
            return { scope, coverage: memory.coverage };
        // Only generation's own exact receipt can explain a changed anchor ref.
        // A manual "keep" review approves applicability, not unchanged body text.
        if (!memory.anchor || !memory.inputRefs.some(ref => ref.message === memory.anchor)) return;
        if (!reviews.has(memory.id)) reviews.set(memory.id, tx.all<Review>('reviews', 'owner', memory.id));
        for (const review of await reviews.get(memory.id)!) {
            if (review.origin !== 'generated_sidecar' || review.reviewSchema !== 2 || review.decision !== 'compatible' ||
                review.owner !== memory.id || review.story !== memory.story || review.branch !== memory.branch ||
                !review.sourceRefs || !review.coverage || !equal(review.dependencies, memory.dependencies)) continue;
            const transparent = (before: readonly SourceRef[], after: readonly SourceRef[]) => sameRange(before, after) &&
                before.every((ref, i) => ref.message === memory.anchor || sourceRefMatches(view.branch, ref, after[i]));
            if (!transparent(memory.inputRefs, review.sourceRefs) || !transparent(memory.coverage, review.coverage) ||
                !currentRefs(review.sourceRefs) || !currentRefs(review.coverage)) continue;
            const receipt = await readBasis(review.snapshot);
            if (receipt && await refsAt(receipt, review.sourceRefs) && await refsAt(receipt, review.coverage, true))
                return { scope, coverage: memory.coverage };
        }
    }
    const proof = (memory: MemoryRevision) => {
        if (!proofs.has(memory.id)) proofs.set(memory.id, prove(memory));
        return proofs.get(memory.id)!;
    };
    const sameScope = (a: Scope, b: Scope) => {
        const length = typeof a === 'number' ? a : a.length;
        if (length !== (typeof b === 'number' ? b : b.length)) return false;
        if (typeof a === 'number' && typeof b === 'number') return true;
        for (let i = 0; i < length; i++)
            if ((typeof a === 'number' ? view.refs[i].message : a[i].message) !==
                (typeof b === 'number' ? view.refs[i].message : b[i].message)) return false;
        return true;
    };
    const eligible = (memory: MemoryRevision) => memory.story === view.branch.story && memory.branch === view.branch.id &&
        memory.recall && memory.visibility === 'public' && !memory.sourceRecovery;
    async function validate(prior: MemoryRevision): Promise<boolean> {
        if (results.has(prior.id)) return results.get(prior.id)!;
        const next = selected.get(prior.owner);
        if (!next || !eligible(prior) || !eligible(next) ||
            prior.hostId !== next.hostId || prior.level !== next.level || prior.anchor !== next.anchor || prior.seed !== next.seed)
            return false;
        const unchanged = sameNarrativeRevision(prior, next);
        if (unchanged && validity.get(next.id) === 'valid') { results.set(prior.id, true); return true; }
        if ((!unchanged && (next.declaration !== MANUAL_EDIT || next.level !== 0 || next.seed || !next.anchor)) ||
            active.has(prior.owner)) return false;
        active.add(prior.owner);
        let accepted = false;
        try {
            const before = await proof(prior), after = await proof(next);
            if (!before || !after || !sameScope(before.scope, after.scope) || !sameRange(before.coverage, after.coverage) ||
                prior.dependencies.length !== next.dependencies.length) return false;
            for (let i = 0; i < prior.dependencies.length; i++) {
                const oldDependency = await readMemory(prior.dependencies[i]), newDependency = await readMemory(next.dependencies[i]);
                if (!oldDependency || !newDependency || oldDependency.owner !== newDependency.owner ||
                    !await validate(oldDependency) || !await validate(newDependency)) return false;
            }
            accepted = true; return true;
        } finally { active.delete(prior.owner); results.set(prior.id, accepted); }
    }
    return validate;
}
