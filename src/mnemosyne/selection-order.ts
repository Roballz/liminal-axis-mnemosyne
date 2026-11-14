import { check } from './model';

const RANK_STEP = 2 ** 32;
const MIN_LOCAL_STEP = 2 ** 16;
const MAX_RANK = Number.MAX_SAFE_INTEGER;

/** Preserve existing integer labels when only membership changes. A new L0 is
 * inserted before higher levels, so assigning array indexes would rewrite every
 * higher-level entry and, consequently, most immutable hash-trie buckets.
 * Existing schema-2 readers already accept these sparse safe-integer ranks.
 */
export function selectionRanks(families: readonly string[], previous: (family: string) => number | undefined): number[] {
    const ranks = families.map(previous);
    let last = -1, ordered = true;
    for (const rank of ranks) if (rank !== undefined) {
        check(Number.isSafeInteger(rank) && rank >= 0, '摘要选择顺序非法');
        if (rank <= last) ordered = false;
        last = rank;
    }

    if (!ordered) {
        // A genuine reorder (or valid imported equal ranks) keeps a longest
        // increasing subsequence as anchors; only displaced entries need labels.
        const tails: number[] = [], parents = new Int32Array(ranks.length).fill(-1);
        for (let i = 0; i < ranks.length; i++) {
            const rank = ranks[i];
            if (rank === undefined) continue;
            let low = 0, high = tails.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (ranks[tails[middle]]! < rank) low = middle + 1; else high = middle;
            }
            if (low) parents[i] = tails[low - 1];
            tails[low] = i;
        }
        const keep = new Uint8Array(ranks.length);
        for (let i = tails.at(-1) ?? -1; i >= 0; i = parents[i]) keep[i] = 1;
        for (let i = 0; i < ranks.length; i++) if (!keep[i]) ranks[i] = undefined;
    }

    const spread = (start: number, end: number, step: number, lower: number) => {
        for (let i = start; i < end; i++) ranks[i] = lower + (i - start + 1) * step;
    };
    const rebalance = (from: number, to: number): number => {
        // Expand only until nearby anchors leave ample room. Repeated insertion
        // into a tiny gap rebalances a bounded neighborhood, not the whole view.
        // Fully dense legacy labels may need one larger initial conversion.
        let radius = 32;
        for (;;) {
            let start = Math.max(0, from - radius), end = Math.min(ranks.length, to + radius);
            while (start > 0 && ranks[start - 1] === undefined) start--;
            while (end < ranks.length && ranks[end] === undefined) end++;
            const lower = start ? ranks[start - 1]! : 0;
            const upper = end < ranks.length ? ranks[end]! : MAX_RANK;
            const step = Math.min(RANK_STEP, Math.floor((upper - lower) / (end - start + 1)));
            if (step >= MIN_LOCAL_STEP || start === 0 && end === ranks.length) {
                check(step >= 1, '摘要选择顺序空间不足');
                spread(start, end, step, lower);
                return end;
            }
            radius *= 2;
        }
    };

    for (let start = 0; start < ranks.length;) {
        if (ranks[start] !== undefined) { start++; continue; }
        let end = start + 1;
        while (end < ranks.length && ranks[end] === undefined) end++;
        const count = end - start;
        if (start === 0 && end === ranks.length) {
            spread(start, end, Math.min(RANK_STEP, Math.floor(MAX_RANK / (count + 1))), 0);
        } else if (end === ranks.length) {
            const lower = ranks[start - 1]!;
            if (MAX_RANK - lower < count) { start = rebalance(start, end); continue; }
            spread(start, end, MAX_RANK - lower >= count * RANK_STEP ? RANK_STEP : 1, lower);
        } else if (start === 0) {
            const upper = ranks[end]!;
            if (upper < count) { start = rebalance(start, end); continue; }
            // Repeated prepends consume one integer at the beginning each time.
            spread(start, end, 1, upper - count - 1);
        } else {
            const lower = ranks[start - 1]!, upper = ranks[end]!;
            if (upper - lower <= count) { start = rebalance(start, end); continue; }
            // Repeated L0 appends consume one integer toward a fixed L1 anchor.
            // Midpoint ranks would exhaust even a 2^32 gap after just 32 appends.
            spread(start, end, 1, lower);
        }
        start = end;
    }
    last = -1;
    for (const rank of ranks) {
        check(rank !== undefined && Number.isSafeInteger(rank) && rank >= 0 && rank > last, '摘要选择顺序非法');
        last = rank;
    }
    return ranks as number[];
}
