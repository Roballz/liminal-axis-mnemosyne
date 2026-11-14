import { expect, test } from 'vitest';
import { selectionRanks } from './selection-order';

const STEP = 2 ** 32;
function assign(order: string[], before: Map<string, number>) {
    const ranks = selectionRanks(order, family => before.get(family));
    expect(ranks.every((rank, i) => Number.isSafeInteger(rank) && rank >= 0 && (!i || rank > ranks[i - 1]))).toBe(true);
    return new Map(order.map((family, i) => [family, ranks[i]]));
}

test('ten thousand floors with L0/L1/L2 ordering never renumber existing higher summaries', () => {
    const leaves: string[] = [], first: string[] = [], second: string[] = [];
    let previous = new Map<string, number>(), changedExisting = 0;
    for (let i = 1; i <= 5000; i++) {
        leaves.push(`leaf-${i}`);
        if (i % 8 === 0) first.push(`first-${i / 8}`);
        if (i % 40 === 0) second.push(`second-${i / 40}`);
        const order = [...leaves, ...first, ...second];
        const ranks = selectionRanks(order, family => previous.get(family));
        const next = new Map<string, number>();
        for (let j = 0; j < order.length; j++) {
            const old = previous.get(order[j]);
            if (old !== undefined && old !== ranks[j]) changedExisting++;
            if (!Number.isSafeInteger(ranks[j]) || ranks[j] < 0 || j && ranks[j] <= ranks[j - 1])
                throw new Error('selection order changed');
            next.set(order[j], ranks[j]);
        }
        previous = next;
    }
    expect(previous.size).toBe(5750);
    expect(changedExisting).toBe(0);
}, 15000);

test.each([
    { name: 'dense prepend', old: [0, 1, 2], order: ['new', 'a', 'b', 'c'] },
    { name: 'dense insertion', old: [0, 1, 2], order: ['a', 'new', 'b', 'c'] },
    { name: 'sparse insertion', old: [3, 90, 400], order: ['a', 'new', 'b', 'c'] },
    { name: 'equal imported ranks', old: [100, 100, 100], order: ['a', 'b', 'new', 'c'] },
    { name: 'maximum rank append', old: [0, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER], order: ['a', 'b', 'c', 'new'] },
    { name: 'reordered old entries', old: [STEP, 2 * STEP, 3 * STEP], order: ['b', 'a', 'c'] },
    { name: 'removed old entry', old: [STEP, 2 * STEP, 3 * STEP], order: ['a', 'c'] },
])('$name preserves exact requested enumeration without changing prior ranks', ({ old, order }) => {
    const prior = new Map(['a', 'b', 'c'].map((key, i) => [key, old[i]])), unchanged = [...prior];
    const next = assign(order, prior);
    expect([...next].sort((a, b) => a[1] - b[1]).map(([family]) => family)).toEqual(order);
    expect([...prior]).toEqual(unchanged);
    if (order.join() === 'b,a,c') expect([...next].filter(([family, rank]) => rank !== prior.get(family))).toHaveLength(1);
});

test('repeated insertion into the same exhausted gap rebalances neighborhoods instead of the full view', () => {
    const order = Array.from({ length: 2048 }, (_, i) => `original-${i}`);
    let prior = new Map(order.map((family, i) => [family, (i + 1) * STEP]));
    let totalChanges = 0, maximumChanges = 0;
    for (let i = 0; i < 512; i++) {
        // Every insert precedes the previous insert, repeatedly exhausting left+1.
        order.splice(1024, 0, `inserted-${i}`);
        const next = assign(order, prior);
        const changed = [...next].filter(([family, rank]) => rank !== prior.get(family)).length;
        totalChanges += changed; maximumChanges = Math.max(maximumChanges, changed);
        prior = next;
    }
    expect(maximumChanges).toBeLessThanOrEqual(256);
    expect(totalChanges).toBeLessThan(512 * 128);
});

test('invalid legacy ranks remain rejected', () => {
    for (const rank of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        expect(() => selectionRanks(['a'], () => rank)).toThrow('摘要选择顺序非法');
});
