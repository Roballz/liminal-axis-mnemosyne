import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { capture, synchronize, type HostObservation } from './canonical';
import { Library, freshLibraryName } from './db';
import { observation } from './fixtures';
import type { Binding, MemoryRevision, SourceBody } from './model';
import { SHARED_META, type Payload } from './shared-payloads';
import { readUnchangedArchive } from './unchanged-archive';

const opened: Library[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const lib of opened.splice(0)) lib.close();
});
const changedText = (text: string) => `改${text.slice(1)}`;

async function coldArchive(compact = false, history = false) {
    const lib = await Library.open(freshLibraryName()); opened.push(lib);
    if (compact) {
        await lib.transaction(['library_meta'], 'readwrite', tx => tx.put('library_meta',
            { id: SHARED_META, schema: 1, value: { version: 1 } } as any));
        lib.compactWrites = true;
    }
    const input = observation(4);
    input.memories.forEach(memory => { memory.content = '合成摘要。'.repeat(40); });
    let branch = await synchronize(lib, input);
    if (history) {
        input.messages.at(-1)!.content = changedText(input.messages.at(-1)!.content);
        input.memories.forEach(memory => { memory.content = changedText(memory.content); });
        branch = await synchronize(lib, input);
    }
    const view = await capture(lib, branch.id);
    const [binding] = await lib.all<Binding>('host_bindings', 'branch', branch.id);
    const revisions = await lib.all<MemoryRevision>('memory_revisions', 'branch', branch.id);
    lib.close();
    const cold = await Library.open(lib.db.name, true); opened.push(cold);
    return { lib: cold, input, branch, view, binding, revisions };
}

test.each([false, true])('cold %s compact archive hydrates exactly once, read-only, without historical scans', async compact => {
    const { lib, input, branch, view, binding, revisions } = await coldArchive(compact, true);
    expect(revisions.length).toBeGreaterThan(view.memories.length);
    expect(lib.compactWrites).toBe(compact);
    const transaction = vi.spyOn(lib, 'transaction');
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const indexedAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    const cursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    const indexedCursor = vi.spyOn(IDBIndex.prototype, 'openCursor');
    const keys = (store: string) => get.mock.calls.flatMap((args, i) =>
        (get.mock.contexts[i] as IDBObjectStore).name === store ? [args[0]] : []);

    expect(await readUnchangedArchive(lib, input, binding, branch.head, () => true)).toEqual(view);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][1]).toBe('readonly');
    expect(keys('source_revisions')).toEqual(view.refs.map(ref => ref.revision));
    expect(keys('source_bodies')).toEqual(view.refs.map(ref => ref.revision));
    expect(keys('memory_revisions')).toEqual(view.memories.map(memory => memory.id));
    expect(keys('history_snapshots')).toEqual([branch.head]);
    expect(keys('memory_views')).toEqual([branch.view]);
    expect(keys('manifest_blocks')).toEqual(view.snapshot.blocks);
    expect(getAll).not.toHaveBeenCalled();
    expect(cursor).not.toHaveBeenCalled(); expect(indexedCursor).not.toHaveBeenCalled();
    expect(indexedAll.mock.contexts.map(index => (index as IDBIndex).objectStore.name).sort())
        .toEqual(['memories', 'message_mappings']);
    expect(indexedAll.mock.calls.map(args => args[0])).toEqual([binding.id, binding.id]);
    if (compact) {
        const payloads = keys('memory_payloads');
        expect(payloads.length).toBeGreaterThan(0);
        expect(new Set(payloads).size).toBe(payloads.length);
    }
});

test('same-length body edits, roles, swipe variants and source identities take normal synchronization', async () => {
    const { lib, input, branch, binding } = await coldArchive();
    const changes: [string, (value: HostObservation) => void][] = [
        ['same-length body', value => { value.messages[1].content = changedText(value.messages[1].content); }],
        ['role', value => { value.messages[1].role = 'user'; }],
        ['swipe', value => { value.messages[1].swipe++; }],
        ['identity', value => { value.messages[1].key = 'replacement-host-key'; }],
    ];
    for (const [label, change] of changes) {
        const changed = structuredClone(input); change(changed);
        expect(await readUnchangedArchive(lib, changed, binding, branch.head, () => true), label).toBeUndefined();
    }
});

test('summary text, tags, generation evidence, basis and identities take normal synchronization', async () => {
    const { lib, input, branch, binding } = await coldArchive(true);
    const changes: [string, (value: HostObservation) => void][] = [
        ['text', value => { value.memories[0].content = changedText(value.memories[0].content); }],
        ['tags', value => { value.memories[0].tags = { version: 1, planIds: [], eventIds: ['event'] }; }],
        ['generation', value => { value.memories[0].generationKey = 1; }],
        ['basis', value => { value.memories[0].basisSnapshot = 'missing-basis'; }],
        ['identity', value => { value.memories[0].hostId = 'replacement-summary-id'; }],
        ['privacy', value => { value.memories[0].private = true; }],
    ];
    for (const [label, change] of changes) {
        const changed = structuredClone(input); change(changed);
        expect(await readUnchangedArchive(lib, changed, binding, branch.head, () => true), label).toBeUndefined();
    }
});

test('saved markers cannot authorize a different binding, scope or head', async () => {
    const { lib, input, branch, binding } = await coldArchive();
    expect(await readUnchangedArchive(lib, input, { ...binding, generation: binding.generation + 1 },
        branch.head, () => true)).toBeUndefined();
    expect(await readUnchangedArchive(lib, { ...input, scope: 'another-chat' }, binding,
        branch.head, () => true)).toBeUndefined();
    expect(await readUnchangedArchive(lib, input, binding, 'old-head', () => true)).toBeUndefined();
});

test('a matching host fingerprint cannot hide a different selected generation basis', async () => {
    const { lib, input, branch, binding } = await coldArchive();
    input.memories[0].basisSnapshot = branch.head;
    const saved = await synchronize(lib, input);
    const view = await capture(lib, saved.id);
    const memory = view.memories.find(value => value.hostId === input.memories[0].hostId)!;
    // Retain the exact host fingerprint while the selected provenance differs.
    await lib.transaction(['memory_revisions'], 'readwrite', tx => tx.put('memory_revisions',
        { ...memory, basis: 'unavailable-generation-basis' } as MemoryRevision));
    expect(await readUnchangedArchive(lib, input, binding, saved.head, () => true)).toBeUndefined();
});

test.each(['body', 'summary'] as const)('matching fingerprints never hide a corrupted %s payload', async kind => {
    const { lib, input, branch, view, binding } = await coldArchive(true);
    if (kind === 'body') {
        await lib.transaction(['source_bodies'], 'readwrite', async tx => {
            const body = (await tx.get<SourceBody>('source_bodies', view.refs[1].revision))!;
            await tx.put('source_bodies', { ...body, content: changedText(body.content) } as SourceBody);
        });
    } else {
        await lib.transaction(['memory_revisions', 'memory_payloads'], 'readwrite', async tx => {
            const memory = (await tx.rawGet<any>('memory_revisions', view.memories[0].id))!;
            expect(memory.sharedSchema).toBe(1);
            const payload = (await tx.get<Payload>('memory_payloads', memory.content.shared))!;
            await tx.put('memory_payloads', { ...payload, value: changedText(payload.value) } as Payload);
        });
    }
    await expect(readUnchangedArchive(lib, input, binding, branch.head, () => true)).rejects.toThrow(/内容.*校验/);
});

test('a generation change during hydration prevents publishing the otherwise matching view', async () => {
    const { lib, input, branch, binding } = await coldArchive();
    const guard = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(readUnchangedArchive(lib, input, binding, branch.head, guard)).rejects.toThrow('聊天在读取档案期间改变');
    expect(guard).toHaveBeenCalledTimes(2);
});
