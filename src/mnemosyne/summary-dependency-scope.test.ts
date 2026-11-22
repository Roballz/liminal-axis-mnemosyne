import { expect, test, vi } from 'vitest';
import { capture, forkBranch, keepSummaries, keepSummary, statuses, synchronize, type HostObservation } from './canonical';
import { fixture } from './fixtures';
import { Transaction } from './db';
import { exportLibrary } from './migration';
import { sourceSyncBaseline } from './source-sync-guard';
import type { MemoryRevision } from './model';

const sync = async (lib: Awaited<ReturnType<typeof fixture>>['lib'], input: HostObservation) =>
    synchronize(lib, input, { ...await sourceSyncBaseline(lib, input), retireHistory: true, isCurrent: () => true });

test('legacy L0 context edges neither change identities on upgrade nor invalidate later branches', async () => {
    const { lib, input, branch, view } = await fixture(4);
    try {
        input.memories.push(
            { ...input.memories[0], hostId: 'first-l1', level: 1, anchorKey: null, children: ['leaf-0', 'leaf-1'] },
            { ...input.memories[0], hostId: 'other-l1', level: 1, anchorKey: null, children: ['leaf-2'] },
            { ...input.memories[0], hostId: 'first-l2', level: 2, anchorKey: null, children: ['first-l1'] },
        );
        // Real old generation evidence: the later leaf saw the first L2 as context.
        input.memories[3].children = ['first-l2'];
        input.memories[3].inputRefs = view.refs;
        input.memories[3].coverage = view.refs.slice(6);
        await sync(lib, input);
        let current = await capture(lib, branch.id);
        const later = current.memories.find(memory => memory.hostId === 'leaf-3')!;
        const top = current.memories.find(memory => memory.hostId === 'first-l2')!;
        const legacy: MemoryRevision = { ...later, dependencies: [top.id] };
        await lib.transaction(['memory_revisions'], 'readwrite', tx => tx.put('memory_revisions', legacy));
        current = await capture(lib, branch.id);
        const originalIds = current.memories.map(memory => memory.id);
        await sync(lib, input);
        current = await capture(lib, branch.id);
        expect(current.memories.map(memory => memory.id)).toEqual(originalIds);
        expect(current.memories.find(memory => memory.id === legacy.id)).toEqual(legacy);
        expect(new Set((await statuses(lib, current)).values())).toEqual(new Set(['valid']));
        input.memories.find(memory => memory.hostId === 'first-l2')!.content += '人工修改 L2';
        await sync(lib, input);
        current = await capture(lib, branch.id);
        expect((await statuses(lib, current)).get(legacy.id)).toBe('valid');
        input.messages[0].editedFrom = new Set([input.messages[0].content]);
        input.messages[0].content += '自身正文修订';
        await sync(lib, input);
        current = await capture(lib, branch.id);
        const states = await statuses(lib, current);
        for (const memory of current.memories) {
            const affected = ['leaf-0', 'first-l1', 'first-l2'].includes(memory.hostId);
            expect(states.get(memory.id)).toBe(affected ? 'needs_review' : 'valid');
        }
        await expect(exportLibrary(lib)).resolves.toBeDefined();
    } finally { lib.close(); }
});

test('known legacy manual source prefixes constrain only their own turn', async () => {
    const { lib, input, branch, view } = await fixture(3);
    try {
        input.memories[2].inputRefs = view.refs;
        input.memories[2].declaration = '人工修订摘要：以当前来源版本确认内容；原生成版本保留。';
        await synchronize(lib, input);
        input.messages[0].content += '不相关早期修改';
        await synchronize(lib, input);
        let current = await capture(lib, branch.id);
        let later = current.memories.find(memory => memory.hostId === 'leaf-2')!;
        expect((await statuses(lib, current)).get(later.id)).toBe('valid');
        input.messages[4].content += '自身问题修改';
        await synchronize(lib, input);
        current = await capture(lib, branch.id);
        expect((await statuses(lib, current)).get(later.id)).toBe('needs_review');
        await keepSummaries(lib, current, [later.id], () => true, undefined, undefined, true);
        current = await capture(lib, branch.id);
        later = current.memories.find(memory => memory.hostId === 'leaf-2')!;
        expect(later.inputRefs).toEqual(current.refs.slice(4));
        expect((await statuses(lib, current)).get(later.id)).toBe('valid');
        await expect(exportLibrary(lib)).resolves.toBeDefined();
    } finally { lib.close(); }
});

test('sequential preservation leaves each ancestor pending until its own confirmation across syncs', async () => {
    const { lib, input, branch } = await fixture(2);
    try {
        input.memories.push(
            { ...input.memories[0], hostId: 'l1', level: 1, anchorKey: null, children: ['leaf-0'] },
            { ...input.memories[0], hostId: 'l2', level: 2, anchorKey: null, children: ['l1'] },
        );
        await sync(lib, input);
        input.messages[1].editedFrom = new Set([input.messages[1].content]);
        input.messages[1].content += '正文修订';
        await sync(lib, input);
        for (const [step, hostId] of ['leaf-0', 'l1', 'l2'].entries()) {
            const before = await capture(lib, branch.id), target = before.memories.find(memory => memory.hostId === hostId)!;
            const oldId = target.id, text = target.content;
            await keepSummaries(lib, before, [oldId], () => true, undefined, undefined, true);
            await sync(lib, input);
            const after = await capture(lib, branch.id), states = await statuses(lib, after);
            const selected = after.memories.find(memory => memory.hostId === hostId)!;
            expect(selected.id).not.toBe(oldId);
            expect(selected.content).toBe(text);
            expect(states.get(selected.id)).toBe('valid');
            for (const pending of ['leaf-0', 'l1', 'l2'].slice(step + 1))
                expect(states.get(after.memories.find(memory => memory.hostId === pending)!.id)).toBe('needs_rebuild');
            expect(states.get(after.memories.find(memory => memory.hostId === 'leaf-1')!.id)).toBe('valid');
        }
        await expect(exportLibrary(lib)).resolves.toBeDefined();
    } finally { lib.close(); }
});

test('a dangling historical L0 context edge is not loaded or recursively validated', async () => {
    const { lib, view } = await fixture(2);
    const later = view.memories.find(memory => memory.hostId === 'leaf-1')!;
    later.dependencies = ['old-context-no-longer-selected'];
    const get = vi.spyOn(Transaction.prototype, 'get');
    try {
        expect((await statuses(lib, view)).get(later.id)).toBe('valid');
        expect(get.mock.calls.filter(([store, id]) => store === 'memory_revisions' && id === later.dependencies[0])).toEqual([]);
    } finally { get.mockRestore(); lib.close(); }
});

test('a later own-source approval survives a fork after unrelated legacy context changes', async () => {
    const { lib, input, branch } = await fixture(2);
    try {
        input.messages[3].content += '自身正文首次修改';
        await synchronize(lib, input);
        let parent = await capture(lib, branch.id);
        await keepSummary(lib, parent, parent.memories.find(memory => memory.hostId === 'leaf-1')!.id);
        input.messages[0].content += '无关旧上下文随后变化';
        await synchronize(lib, input);
        parent = await capture(lib, branch.id);
        const later = parent.memories.find(memory => memory.hostId === 'leaf-1')!;
        expect((await statuses(lib, parent)).get(later.id)).toBe('valid');
        const child = await forkBranch(lib, parent, 'independent-later-source');
        const inherited = await capture(lib, child.id);
        expect(inherited.memories.map(memory => memory.hostId)).toEqual(['leaf-1']);
        expect((await statuses(lib, inherited)).get(inherited.memories[0].id)).toBe('valid');
        expect(inherited.memories[0].inputRefs).toEqual(inherited.refs.slice(2));
        await expect(exportLibrary(lib)).resolves.toBeDefined();
    } finally { lib.close(); }
});
