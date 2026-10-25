import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import * as body from './current-body';
import { capture, forkBranch, synchronize, type HostObservation } from './canonical';
import { Library, Transaction } from './db';
import { fixture } from './fixtures';
import { exportLibrary, restoreLibrary } from './migration';
import { STORES, row, type MemoryRevision, type Store } from './model';

const evidenceStores: Store[] = ['memory_revisions', 'reviews', 'event_revisions', 'event_memberships',
    'event_progress', 'event_processing_receipts', 'custom_table_rows', 'table_receipts', 'table_history'];
afterEach(() => vi.restoreAllMocks());

function append(input: HostObservation, role: 'user' | 'assistant') {
    const index = input.messages.length;
    input.messages.push({ key: `host-${index}`, role, content: `新增合成正文 ${index}`, swipe: 0 });
}
async function rows(lib: Library) {
    return lib.transaction(STORES, 'readonly', async tx => Object.fromEntries(
        await Promise.all(STORES.map(async store => [store, await tx.rawAll(store)]))));
}

/** The pre-F11 full scan is the independent oracle. Do not call the new root
 * extractor/counting/cache implementation to compute these expected roots. */
async function originalRoots(tx: Transaction, story: string) {
    const snapshotRoots = new Set<string>(), sourceRoots = new Set<string>();
    const collect = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const item = value as { message?: unknown; revision?: unknown; basis?: unknown; snapshot?: unknown };
        if (typeof item.message === 'string' && typeof item.revision === 'string') sourceRoots.add(item.revision);
        if (typeof item.basis === 'string') snapshotRoots.add(item.basis);
        if (typeof item.snapshot === 'string') snapshotRoots.add(item.snapshot);
        for (const child of Object.values(value)) if (child && typeof child === 'object') collect(child);
    };
    for (const store of evidenceStores) for (const item of await tx.all(store, 'story', story)) collect(item);
    return { snapshotRoots, sourceRoots };
}

test.each([0, 500, 2000])('cold history is read once, then repeated user/AI/summary turns scan zero old rows (%i history)', async count => {
    const { lib, input, branch, view } = await fixture(40);
    try {
        await lib.transaction(['memory_revisions'], 'readwrite', async tx => {
            for (let i = 0; i < count; i++) await tx.add('memory_revisions', {
                ...view.memories[0], ...row('history'), content: `旧修订 ${i}`,
            } as MemoryRevision);
        });
        let scanned = 0, sweeps = 0;
        const native = IDBIndex.prototype.getAll;
        vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
            const request = native.apply(this, args);
            if (this.name === 'story' && evidenceStores.includes(this.objectStore.name as Store)) {
                sweeps++;
                if (this.objectStore.name === 'memory_revisions') request.addEventListener('success', () => { scanned += request.result.length; });
            }
            return request;
        });
        const counts: { step: string; scanned: number; sweeps: number }[] = [];
        for (const step of ['cold-user', 'cold-assistant', 'summary-1', 'user-1', 'assistant-1', 'summary-2', 'user-2', 'assistant-2']) {
            if (step.startsWith('summary')) input.memories.push({ ...input.memories[0], hostId: step,
                content: `新摘要 ${step}`, anchorKey: input.messages.at(-1)!.key });
            else append(input, step.includes('assistant') ? 'assistant' : 'user');
            scanned = sweeps = 0;
            await synchronize(lib, input);
            counts.push({ step, scanned, sweeps });
        }
        expect(counts.map(c => c.scanned)).toEqual([0, count + 40, 0, 0, 0, 0, 0, 0]);
        expect(counts.map(c => c.sweeps)).toEqual([0, 9, 0, 0, 0, 0, 0, 0]);
        const current = await capture(lib, branch.id), before = await rows(lib);
        await lib.transaction(STORES, 'readwrite', tx => body.retireCurrentBodies(tx, current.branch, view.refs, undefined, true));
        expect(await rows(lib)).toEqual(before);
        console.info('retention evidence work', { count, counts });
    } finally { lib.close(); }
});

test('cached reclamation matches the original full collector after every append, summary, edit, swipe, deletion and fork', async () => {
    const initial = await fixture(12);
    let optimized: Library | undefined, oracle: Library | undefined;
    try {
        await initial.lib.transaction(['memory_revisions'], 'readwrite', async tx => {
            for (let i = 0; i < 150; i++) await tx.add('memory_revisions', {
                ...initial.view.memories[0], ...row('history'), content: `未选择证据 ${i}`,
            } as MemoryRevision);
        });
        const pack = await exportLibrary(initial.lib);
        optimized = await restoreLibrary(pack, false); oracle = await restoreLibrary(pack, false);
        const target = oracle.db.name, roots = Transaction.prototype.retentionRoots, retire = body.retireCurrentBodies;
        vi.spyOn(Transaction.prototype, 'retentionRoots').mockImplementation(function (this: Transaction, story, refresh) {
            return this.native.db.name === target ? originalRoots(this, story) : roots.call(this, story, refresh);
        });
        vi.spyOn(body, 'retireCurrentBodies').mockImplementation((tx, branch, previous, current, full) =>
            retire(tx, branch, previous, current, tx.native.db.name === target || full));
        const inputs = [structuredClone(initial.input), structuredClone(initial.input)];
        let serial = 0;
        vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${(++serial).toString().padStart(12, '0')}`);
        const time = vi.spyOn(Date, 'now');
        const operations = ['user', 'assistant', 'summary', 'user', 'assistant', 'edit', 'swipe', 'delete',
            'summary-edit', 'summary-remove', 'fork', 'edit-again', 'user', 'assistant'] as const;
        for (const [index, operation] of operations.entries()) {
            time.mockReturnValue(1_800_000_000_000 + index);
            for (const [side, lib] of [optimized, oracle].entries()) {
                serial = (index + 1) * 10000;
                const input = inputs[side];
                if (operation === 'user' || operation === 'assistant') append(input, operation);
                else if (operation === 'summary') input.memories.push({ ...input.memories[0], hostId: 'new-summary',
                    content: '新摘要', anchorKey: input.messages.at(-1)!.key });
                else if (operation === 'edit' || operation === 'edit-again') input.messages[1].content += operation;
                else if (operation === 'swipe') input.messages.at(-1)!.swipe++;
                else if (operation === 'delete') input.messages.splice(-2);
                else if (operation === 'summary-edit') input.memories[1].content += ' 新修订';
                else if (operation === 'summary-remove') input.memories.splice(2, 1);
                else if (operation === 'fork') {
                    await forkBranch(lib!, await capture(lib!, initial.branch.id), 'proof-child');
                    continue;
                }
                await synchronize(lib!, input);
            }
            expect(await rows(optimized), operation).toEqual(await rows(oracle));
        }
        expect((await exportLibrary(optimized)).data).toEqual((await exportLibrary(oracle)).data);
    } finally { optimized?.close(); oracle?.close(); initial.lib.close(); }
}, 15000);

test('a foreign same-epoch evidence insertion invalidates a warm root cache before reclaiming its old snapshot', async () => {
    const { lib, input, branch } = await fixture(3);
    const other = await Library.open(lib.db.name);
    try {
        append(input, 'user'); await synchronize(lib, input);
        const retained = await capture(lib, branch.id);
        await lib.transaction(STORES, 'readonly', tx => tx.retentionRoots(branch.story));
        const basis = retained.memories[0];
        await other.transaction(['memory_revisions'], 'readwrite', tx => tx.add('memory_revisions', {
            ...basis, ...row('foreign-history'), basis: retained.snapshot.id,
        } as MemoryRevision));
        expect((await lib.get('branches', branch.id) as typeof branch).epoch).toBe(retained.branch.epoch);
        const reads = vi.spyOn(IDBIndex.prototype, 'getAll');
        append(input, 'assistant'); await synchronize(lib, input);
        expect(reads.mock.contexts.some(context => (context as IDBIndex).objectStore.name === 'memory_revisions' &&
            (context as IDBIndex).name === 'story')).toBe(true);
        expect(await lib.get('history_snapshots', retained.snapshot.id)).toBeDefined();
        const current = await capture(lib, branch.id), before = await rows(lib);
        await lib.transaction(STORES, 'readwrite', tx => body.retireCurrentBodies(tx, current.branch, retained.refs, undefined, true));
        expect(await rows(lib)).toEqual(before);
    } finally { other.close(); lib.close(); }
});
