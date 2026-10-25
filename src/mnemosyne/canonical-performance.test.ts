import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { capture, forkBranch, statuses, synchronize, type HostObservation } from './canonical';
import { retireCurrentBodies } from './current-body';
import { Library, Transaction, freshLibraryName } from './db';
import { observation } from './fixtures';
import { STORES, row, type Binding, type Branch, type CapturedView, type MemoryRevision, type SourceBody, type SourceRef } from './model';

afterEach(() => vi.restoreAllMocks());

function append(input: HostObservation, count = 2) {
    const start = input.messages.length;
    input.messages.push(...Array.from({ length: count }, (_, n) => ({
        key: `host-${start + n}`, role: 'user' as const, content: `新正文 ${start + n}`, swipe: 0,
    })));
}
async function rows(lib: Library) {
    return Promise.all(STORES.map(store => lib.all(store)));
}
async function collectorIsAlreadySettled(lib: Library, branchId: string, previous: SourceRef[]) {
    const view = await capture(lib, branchId), before = await rows(lib);
    await lib.transaction(STORES, 'readwrite', tx => retireCurrentBodies(tx, view.branch, previous));
    expect(await rows(lib)).toEqual(before);
}

test('80-message append hashes only the two new bodies and skips a provably empty history sweep', async () => {
    const lib = await Library.open(freshLibraryName()), input = observation(40);
    try {
        const branch = await synchronize(lib, input), before = await capture(lib, branch.id);
        await lib.transaction(['memory_revisions'], 'readwrite', async tx => {
            for (let i = 0; i < 500; i++) await tx.add('memory_revisions', {
                ...before.memories[0], ...row('history'), content: `未选择历史摘要 ${i}`,
            } as MemoryRevision);
        });
        append(input);
        const digest = vi.spyOn(crypto.subtle, 'digest'), all = vi.spyOn(Transaction.prototype, 'all');
        const get = vi.spyOn(Transaction.prototype, 'get');
        let captured: CapturedView | undefined;
        await synchronize(lib, input, undefined, view => { captured = view; });
        expect(digest).toHaveBeenCalledTimes(4);
        expect(all.mock.calls.filter(([store, index]) => store === 'memory_revisions' && index === 'story')).toHaveLength(0);
        expect(all.mock.calls.filter(([store, index]) => store === 'history_snapshots' && index === 'story')).toHaveLength(0);
        // Preflight tags and write-time live rows remain separate checks; post-sync
        // capture reuses only the latter, saving the former third 40-row read.
        expect(get.mock.calls.filter(([store]) => store === 'memory_revisions')).toHaveLength(80);
        expect(get.mock.calls.filter(([store]) => store === 'source_revisions')).toHaveLength(80);
        expect(get.mock.calls.filter(([store]) => store === 'source_bodies')).toHaveLength(80);
        expect(all.mock.calls.filter(([store, index]) => index === 'story' && [
            'reviews', 'event_revisions', 'event_memberships', 'event_progress', 'event_processing_receipts',
            'custom_table_rows', 'table_receipts', 'table_history',
        ].includes(store))).toHaveLength(0);
        vi.restoreAllMocks();
        expect(captured).toEqual(await capture(lib, branch.id));
        await collectorIsAlreadySettled(lib, branch.id, before.refs);
        expect((await capture(lib, branch.id)).sources.size).toBe(82);
        const unchanged = vi.spyOn(crypto.subtle, 'digest');
        await synchronize(lib, input);
        expect(unchanged).not.toHaveBeenCalled();
    } finally { lib.close(); }
});

test('exact same-length edits, nested memory changes and swipes retain canonical identity rules', async () => {
    const lib = await Library.open(freshLibraryName()), input = observation(2);
    try {
        const branch = await synchronize(lib, input), before = await capture(lib, branch.id);
        input.messages[1].content = input.messages[1].content.replace('玉佩', '玉石');
        input.memories[0].children.push('leaf-1');
        const digest = vi.spyOn(crypto.subtle, 'digest');
        await synchronize(lib, input);
        expect(digest).toHaveBeenCalledTimes(3);
        const changed = await capture(lib, branch.id);
        expect(changed.refs[1].revision).not.toBe(before.refs[1].revision);
        expect(changed.sources.get(changed.refs[1].revision)?.content).toBe(input.messages[1].content);
        expect(changed.memories[0].dependencies).toEqual([changed.memories[1].id]);
        digest.mockClear();
        input.messages[1].swipe = 1;
        await synchronize(lib, input);
        expect(digest).not.toHaveBeenCalled();
        const swiped = await capture(lib, branch.id);
        expect(swiped.refs).toEqual(changed.refs);
        expect(swiped.snapshot.id).not.toBe(changed.snapshot.id);
        expect(swiped.snapshot.variants?.[1]).toBe(1);
        await collectorIsAlreadySettled(lib, branch.id, changed.refs);
    } finally { lib.close(); }
});

test('a failed append publishes no database evidence and a retry remains exact', async () => {
    const lib = await Library.open(freshLibraryName()), input = observation(2);
    try {
        const branch = await synchronize(lib, input), before = await rows(lib);
        append(input);
        const original = Transaction.prototype.put;
        const failure = vi.spyOn(Transaction.prototype, 'put').mockImplementation(function (this: Transaction, store, value) {
            if (store === 'source_bodies') throw new Error('synthetic quota');
            return original.call(this, store, value);
        });
        await expect(synchronize(lib, input)).rejects.toThrow('synthetic quota');
        failure.mockRestore();
        expect(await rows(lib)).toEqual(before);
        await synchronize(lib, input);
        const current = await capture(lib, branch.id);
        expect(current.sources.size).toBe(6);
        expect(current.sources.get(current.refs.at(-1)!.revision)?.content).toBe(input.messages.at(-1)!.content);
    } finally { lib.close(); }
});

test('unrooted heads, foreign history evidence, deletions and forks keep the full collector result', async () => {
    const lib = await Library.open(freshLibraryName()), input = observation(2);
    input.memories = [];
    const other = await Library.open(lib.db.name);
    try {
        const branch = await synchronize(lib, input);
        append(input);
        await synchronize(lib, input);
        const old = await capture(lib, branch.id);
        // Another connection may add historical evidence without a branch update.
        // Positive local roots are insufficient here, so the full collector must see it.
        const binding = (await other.all('host_bindings'))[0];
        const family = { ...row('mem'), story: branch.story, owner: binding.id, hostId: 'foreign-history' };
        await other.transaction(['memories', 'memory_revisions'], 'readwrite', async tx => {
            await tx.add('memories', family);
            await tx.add('memory_revisions', { ...row('mr'), story: branch.story, branch: branch.id,
                owner: family.id, content: '外部历史证据', hostId: family.hostId, fingerprint: 'synthetic',
                basis: old.snapshot.id, inputRefs: [], coverage: [], dependencies: [], declaration: '合成历史',
                level: 0, anchor: old.refs[1].message, storyTime: '', recall: false, visibility: 'public', seed: false,
            } as MemoryRevision);
        });
        append(input);
        const all = vi.spyOn(Transaction.prototype, 'all');
        await synchronize(lib, input);
        expect(all.mock.calls.some(([store, index]) => store === 'memory_revisions' && index === 'story')).toBe(true);
        expect(await lib.get('history_snapshots', old.snapshot.id)).toBeDefined();
        await collectorIsAlreadySettled(lib, branch.id, old.refs);
        const parent = await capture(lib, branch.id);
        const child = await forkBranch(lib, parent, 'child');
        input.messages[1].content = '父分支修改';
        input.messages.pop();
        await synchronize(lib, input);
        await collectorIsAlreadySettled(lib, branch.id, parent.refs);
        const childView = await capture(lib, child.id);
        expect(childView.sources.get(parent.refs[1].revision)?.content).toBe(parent.sources.get(parent.refs[1].revision)?.content);
        expect(childView.refs).toEqual(parent.refs);
    } finally { other.close(); lib.close(); }
});

test('a new connection and scope use the cold hash path', async () => {
    const lib = await Library.open(freshLibraryName()), input = observation(2);
    let other: Library | undefined;
    try {
        await synchronize(lib, input);
        other = await Library.open(lib.db.name);
        const digest = vi.spyOn(crypto.subtle, 'digest');
        await synchronize(other, input);
        expect(digest).toHaveBeenCalledTimes(10);
        digest.mockClear();
        input.scope = 'another-story';
        await synchronize(lib, input);
        expect(digest).toHaveBeenCalledTimes(10);
    } finally { other?.close(); lib.close(); }
});

test.each([0, 500, 2000])('ordinary turn sequence with %i historical summaries measures the remaining sweep', async historyCount => {
    const lib = await Library.open(freshLibraryName()), input = observation(40);
    try {
        const branch = await synchronize(lib, input), before = await capture(lib, branch.id);
        await lib.transaction(['memory_revisions'], 'readwrite', async tx => {
            for (let i = 0; i < historyCount; i++) await tx.add('memory_revisions', {
                ...before.memories[0], ...row('history'), content: `未选择历史摘要 ${i}`,
            } as MemoryRevision);
        });
        let scanned = 0;
        const original = Transaction.prototype.all;
        vi.spyOn(Transaction.prototype, 'all').mockImplementation(async function (this: Transaction, store, index, key) {
            const result = await original.call(this, store, index, key);
            if (store === 'memory_revisions' && index === 'story') scanned += result.length;
            return result as any;
        });
        const digest = vi.spyOn(crypto.subtle, 'digest');
        const counts: { step: string; hashes: number; historicalRows: number }[] = [];
        for (const step of ['user', 'assistant', 'summary', 'next-user']) {
            if (step === 'summary') input.memories.push({ ...input.memories[0], hostId: 'leaf-next',
                content: '新摘要', anchorKey: input.messages.at(-1)!.key });
            else { append(input, 1); if (step === 'assistant') input.messages.at(-1)!.role = 'assistant'; }
            digest.mockClear(); scanned = 0;
            const prior = await capture(lib, branch.id);
            await synchronize(lib, input);
            counts.push({ step, hashes: digest.mock.calls.length, historicalRows: scanned });
            await collectorIsAlreadySettled(lib, branch.id, prior.refs);
        }
        expect(counts.map(c => c.hashes)).toEqual([2, 2, 1, 2]);
        expect(counts.map(c => c.historicalRows)).toEqual([0, historyCount + 40, 0, 0]);
        console.info('append retention sequence', { historyCount, counts });
    } finally { lib.close(); }
});

test('same-call capture is published only after successful commit and equals cold capture', async () => {
    const lib = await Library.open(freshLibraryName()), input = observation(2);
    try {
        const branch = await synchronize(lib, input), before = await capture(lib, branch.id);
        const binding = (await lib.all<Binding>('host_bindings'))[0];
        append(input);
        const captured = vi.fn();
        let checks = 0;
        await expect(synchronize(lib, input, { branch, binding, isCurrent: () => ++checks === 1 }, captured))
            .rejects.toThrow('本次事务回滚');
        expect(captured).not.toHaveBeenCalled();
        expect(await capture(lib, branch.id)).toEqual(before);
        await synchronize(lib, input, undefined, captured);
        expect(captured).toHaveBeenCalledTimes(1);
        expect(captured.mock.calls[0][0]).toEqual(await capture(lib, branch.id));
        input.messages[1].content = '编辑后的正文';
        input.memories[0].content = '编辑后的摘要';
        input.messages.pop();
        await synchronize(lib, input, undefined, captured);
        expect(captured.mock.calls[1][0]).toEqual(await capture(lib, branch.id));
    } finally { lib.close(); }
});

test.each(['missing', 'wrong-owner'] as const)('same-call capture never substitutes host text for a %s stored body', async kind => {
    const lib = await Library.open(freshLibraryName()), input = observation(2);
    try {
        const branch = await synchronize(lib, input), before = await capture(lib, branch.id);
        const body = (await lib.get<SourceBody>('source_bodies', before.refs[0].revision))!;
        await lib.transaction(['source_bodies'], 'readwrite', async tx => {
            if (kind === 'missing') await tx.delete('source_bodies', body.id);
            else await tx.put('source_bodies', { ...body, owner: 'foreign' });
        });
        append(input);
        const captured = vi.fn();
        await expect(synchronize(lib, input, undefined, captured)).rejects.toThrow(/正文版本缺失|来源身份不一致/);
        expect(captured).not.toHaveBeenCalled();
        expect((await lib.get<Branch>('branches', branch.id))?.head).toBe(branch.head);
        await lib.transaction(['source_bodies'], 'readwrite', tx => tx.put('source_bodies', body));
        await synchronize(lib, input, undefined, captured);
        expect(captured.mock.calls[0][0]).toEqual(await capture(lib, branch.id));
    } finally { lib.close(); }
});

test('foreign in-place summary recovery between preflight and write is re-read before capture', async () => {
    const lib = await Library.open(freshLibraryName()), input = observation(2);
    const other = await Library.open(lib.db.name);
    try {
        const branch = await synchronize(lib, input), before = await capture(lib, branch.id);
        append(input);
        let changed = false;
        const original = Library.prototype.transaction;
        vi.spyOn(Library.prototype, 'transaction').mockImplementation(async function (this: Library, stores, mode, fn) {
            const result = await original.call(this, stores, mode, fn);
            if (this === lib && !changed && mode === 'readonly' && stores.includes('memory_revisions')) {
                changed = true;
                await other.transaction(['memory_revisions'], 'readwrite', tx => tx.put('memory_revisions', {
                    ...before.memories[0], sourceRecovery: { version: 1, reason: 'missing_basis', snapshot: before.snapshot.id },
                } as MemoryRevision));
            }
            return result;
        });
        let captured: CapturedView | undefined;
        await synchronize(lib, input, undefined, view => { captured = view; });
        expect(changed).toBe(true);
        expect(captured).toEqual(await capture(lib, branch.id));
        expect(captured!.memories[0].sourceRecovery?.reason).toBe('missing_basis');
        expect((await statuses(lib, captured!)).get(before.memories[0].id)).toBe('needs_review');
    } finally { other.close(); lib.close(); }
});
