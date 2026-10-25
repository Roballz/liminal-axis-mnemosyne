import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { statuses } from './canonical';
import { Transaction } from './db';
import { row, type Block, type MemoryRevision, type Review, type Snapshot } from './model';
import { sourcePrefixes } from './source-prefixes';
import { sourceRefMatches } from './source-equivalence';

afterEach(() => vi.restoreAllMocks());

test.each([100, 500, 1000])('%i growing legacy bases share block reads, comparisons and positions', async count => {
    const { lib, view } = await fixture(count);
    try {
        const memories = view.memories.slice().sort((a, b) => Number(a.hostId.slice(5)) - Number(b.hostId.slice(5)));
        const used = new Map<string, number>();
        await lib.transaction(['history_snapshots', 'manifest_blocks', 'memory_revisions'], 'readwrite', async tx => {
            for (let i = 0; i < count; i++) {
                const length = (i + 1) * 2;
                const blocks = view.snapshot.blocks.slice(0, Math.floor(length / 128));
                for (const id of blocks) used.set(id, 128);
                if (length % 128) {
                    const entries = view.refs.slice(Math.floor(length / 128) * 128, length);
                    const block: Block = { ...row('legacy-block'), entries, story: view.branch.story, variants: entries.map(() => 0) };
                    await tx.add('manifest_blocks', block); blocks.push(block.id); used.set(block.id, entries.length);
                }
                const { variants, ...base } = view.snapshot;
                const snapshot: Snapshot = { ...base, ...row('legacy-basis'), blocks, length };
                await tx.add('history_snapshots', snapshot);
                memories[i].basis = snapshot.id;
                await tx.put('memory_revisions', memories[i]);
            }
        });
        let visited = 0;
        const original = Transaction.prototype.get;
        vi.spyOn(Transaction.prototype, 'get').mockImplementation(async function (this: Transaction, store, key) {
            const value = await original.call(this, store, key) as any;
            if (store === 'manifest_blocks' && value) {
                const entries = value.entries;
                Object.defineProperty(value, 'entries', { get: () => { visited += entries.length; return entries; } });
            }
            return value;
        });
        expect([...(await statuses(lib, view)).values()].every(status => status === 'valid')).toBe(true);
        expect(visited).toBe([...used.values()].reduce((a, b) => a + b, 0));
        expect(visited).toBeLessThan(count * (count + 1));
        expect(visited).toBeLessThan(count * 128);
    } finally { lib.close(); }
});

test('200 historical review receipts resolve a selected equivalent once, without array searches', async () => {
    const { lib, view } = await fixture(100);
    try {
        const selected = view.memories.at(-1)!;
        selected.inputRefs = [view.refs.at(-1)!];
        const prior: MemoryRevision = { ...selected, ...row('old-review-owner'), fingerprint: 'old-tag-hash' };
        await lib.transaction(['memory_revisions', 'reviews'], 'readwrite', async tx => {
            await tx.add('memory_revisions', prior); await tx.put('memory_revisions', selected);
            for (let i = 0; i < 200; i++) await tx.add('reviews', {
                ...row('review'), story: view.branch.story, branch: view.branch.id, owner: prior.id,
                snapshot: view.snapshot.id, decision: 'compatible', origin: 'manual', created: i,
                reviewSchema: 2, sourceRefs: selected.inputRefs, coverage: [], dependencies: [],
            } as Review);
        });
        const find = vi.spyOn(view.memories, 'find');
        const get = vi.spyOn(Transaction.prototype, 'get');
        expect((await statuses(lib, view)).get(selected.id)).toBe('valid');
        expect(find).not.toHaveBeenCalled();
        expect(get.mock.calls.filter(([store, id]) => store === 'memory_revisions' && id === prior.id)).toHaveLength(1);
    } finally { lib.close(); }
});

test('child-only higher summaries check their basis identity without expanding its prefix', async () => {
    const { lib, view } = await fixture(1);
    try {
        const child = view.memories[0]; child.inputRefs = view.refs;
        const high: MemoryRevision = { ...child, ...row('higher'), owner: 'higher-family', level: 1,
            anchor: null, inputRefs: [], dependencies: [child.id], hostId: 'high' };
        view.memories.push(high);
        const get = vi.spyOn(Transaction.prototype, 'get');
        expect((await statuses(lib, view)).get(high.id)).toBe('valid');
        expect(get.mock.calls.filter(([store]) => store === 'manifest_blocks')).toHaveLength(0);
        high.basis = 'missing-basis';
        await expect(statuses(lib, view)).rejects.toThrow('摘要基线缺失');
    } finally { lib.close(); }
});

test('shared block prefixes retain exact offset, cutoff, role-repair and legacy anchor semantics', async () => {
    const { lib, view } = await fixture(2);
    try {
        const a: Block = { ...row('a'), entries: view.refs.slice(0, 2) };
        const b: Block = { ...row('b'), entries: [view.refs[2], view.refs[1], view.refs[3]] };
        const snapshots: Snapshot[] = [
            { ...view.snapshot, id: 'full', blocks: [a.id, b.id], length: 5 },
            { ...view.snapshot, id: 'different-offset', blocks: [b.id], length: 3 },
        ];
        const blocks = new Map([[a.id, a], [b.id, b]]);
        for (const current of [view.refs, view.refs.slice(0, 1), [view.refs[2], view.refs[1], view.refs[3]]]) {
            const indexed = sourcePrefixes(view.branch, current, snapshots, [a, b]);
            for (const snapshot of snapshots) {
                const expected = snapshot.blocks.flatMap(id => blocks.get(id)!.entries);
                let prefix = 0;
                while (prefix < expected.length && sourceRefMatches(view.branch, expected[prefix], current[prefix])) prefix++;
                const positions = new Map(expected.map((ref, i) => [ref.message, i]));
                const result = indexed.get(snapshot.id)!;
                expect(result.prefix).toBe(prefix);
                for (const anchor of [...positions.keys(), 'absent']) expect(result.through(anchor)).toBe((positions.get(anchor) ?? -1) + 1);
            }
        }
        const corrected = { ...view.refs[0], revision: 'role-corrected' };
        const branch = { ...view.branch, sourceRoleRepairSchema: 1 as const,
            sourceRoleRepairs: [{ before: view.refs[0], after: corrected, confirmedAt: 1 }] };
        expect(sourcePrefixes(branch, [corrected, view.refs[1]], [{ ...view.snapshot, blocks: [a.id], length: 2 }], [a]).get(view.snapshot.id)?.prefix).toBe(2);
        expect(() => sourcePrefixes(branch, [], [{ ...snapshots[0], length: 4 }], [a, b])).toThrow('历史清单计数错误');
    } finally { lib.close(); }
});
