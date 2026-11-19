import { test, expect } from 'vitest';
import { fixture, observation } from './fixtures';
import { capture, forkBranch, synchronize } from './canonical';
import { exportArchive, restoreArchive, validateArchive } from './archive-package';
import { exportLibrary } from './migration';
import { Library, freshLibraryName } from './db';
import type { Branch } from './model';
import { SHARED_META } from './shared-payloads';

test('single archive contains exact dependencies, without sibling or full parent chat', async () => {
    const { lib, view } = await fixture(4);
    const child = await forkBranch(lib, await capture(lib, view.branch.id, 4), 'child');
    await synchronize(lib, observation(20, 'unrelated'));
    const pack = await exportArchive(lib, child.id);
    await validateArchive(pack);
    expect(pack.pack.data.source_bodies).toHaveLength(4);
    expect((pack.pack.data.branches as Branch[]).filter(b => !b.archiveSupport).map(b => b.id)).toEqual([child.id]);
    expect(pack.pack.data.host_bindings.some((r: any) => r.scope === 'unrelated')).toBe(false);
    const fresh = await Library.open(freshLibraryName());
    await restoreArchive(fresh, pack, async () => true);
    const recovered = await capture(fresh, child.id);
    expect(recovered.refs).toEqual((await capture(lib, child.id)).refs);
    expect(recovered.memories.map(m => m.content)).toEqual((await capture(lib, child.id)).memories.map(m => m.content));
    await exportLibrary(fresh);
    lib.close(); fresh.close();
});

test('restore updates only target, preserving current sibling data and library settings', async () => {
    const { lib, branch, input } = await fixture(3);
    const pack = await exportArchive(lib, branch.id);
    input.messages[5].content = 'new target body'; input.memories[2].content = 'new target summary';
    await synchronize(lib, input);
    const other = await synchronize(lib, observation(2, 'other'));
    const otherBefore = await capture(lib, other.id);
    const child = await forkBranch(lib, await capture(lib, branch.id), 'child-after-edit');
    const childBefore = await capture(lib, child.id);
    await restoreArchive(lib, pack, async () => true, { branch: branch.id });
    expect((await capture(lib, other.id)).branch).toEqual(otherBefore.branch);
    expect((await capture(lib, child.id)).sources).toEqual(childBefore.sources);
    expect((await capture(lib, child.id)).branch).toEqual(childBefore.branch);
    expect((await capture(lib, branch.id)).sources.get(pack.pack.data.source_bodies.at(-1)!.id)).toBeDefined();
    await exportLibrary(lib);
    lib.close();
});

test('wrong archive, corrupted input and cancelled restore leave destination intact', async () => {
    const { lib, branch } = await fixture(2), pack = await exportArchive(lib, branch.id);
    const before = await exportLibrary(lib);
    await expect(restoreArchive(lib, pack, async () => true, { branch: 'other' })).rejects.toThrow('不属于');
    await expect(restoreArchive(lib, { ...pack, checksum: 'wrong' }, async () => true)).rejects.toThrow('校验和');
    await expect(restoreArchive(lib, pack, async () => false)).rejects.toThrow('未恢复');
    expect((await exportLibrary(lib)).data).toEqual(before.data);
    lib.close();
});

test('restoring an archive reclaims only its unreferenced shared text and preserves a sibling payload', async () => {
    const { lib, branch, input } = await fixture(1);
    await lib.transaction(['library_meta'], 'readwrite', tx => tx.put('library_meta', { id: SHARED_META, schema: 1, value: { version: 1 } } as any));
    lib.compactWrites = true;
    input.memories[0].content = 'original archived text '.repeat(50); await synchronize(lib, input);
    const pack = await exportArchive(lib, branch.id);
    const otherInput = observation(1, 'unrelated-shared-data'); otherInput.memories[0].content = 'sibling text '.repeat(50);
    await synchronize(lib, otherInput);
    input.memories[0].content = 'discarded target text '.repeat(50); await synchronize(lib, input);
    const prior = await lib.all<any>('memory_payloads');
    const sibling = prior.find(p => p.value === otherInput.memories[0].content)!, obsolete = prior.find(p => p.value === input.memories[0].content)!;
    expect(obsolete).toBeDefined();
    await restoreArchive(lib, pack, async () => true, { branch: branch.id });
    expect(await lib.get('memory_payloads', obsolete.id)).toBeUndefined();
    expect(await lib.get('memory_payloads', sibling.id)).toEqual(sibling);
    await exportLibrary(lib); lib.close();
});

test('a verified child backup restores over its migrated branch alongside its real parent and later event changes', async () => {
    const { reorganizeCoreLibrary } = await import('./core-reorganization');
    const { saveMemberships } = await import('./event-memberships');
    const { eventView } = await import('./events');
    const { lib, branch, input } = await fixture(35);
    input.memories[0].content = 'long parent summary '.repeat(50);
    await synchronize(lib, input);
    const child = await forkBranch(lib, await capture(lib, branch.id), 'child-to-restore');
    const current = await capture(lib, child.id);
    const members = current.memories.slice(1).map(m => m.id);
    const event = await saveMemberships(lib, current, { mode: 'add', memories: members, eventIds: [], newTitle: 'historical event' });
    const pack = await validateArchive(await exportArchive(lib, child.id));
    await saveMemberships(lib, await capture(lib, child.id), { mode: 'replace', memories: [members[0]], eventIds: [] });
    const migrated = await Library.open((await reorganizeCoreLibrary(lib, async () => true)).library, true);
    try {
        const parentBefore = await capture(migrated, branch.id);
        const restore = () => restoreArchive(migrated, pack, async () => true, { branch: child.id });
        await restore();
        const after = await capture(migrated, child.id);
        const card = (await eventView(migrated, after)).cards.find(c => c.chain.id === event.created)!;
        expect(card.members.map(m => m.memory)).toEqual(members);
        expect(await capture(migrated, branch.id)).toEqual(parentBefore);
        expect((await restore()).records).toBe(0);
        await exportLibrary(migrated);
    } finally { migrated.close(); lib.close(); }
});

test('a parent protection backup excludes snapshots pinned only by a child fork', async () => {
    const { lib, input, branch, view } = await fixture(1);
    try {
        // Capture a transient head with no summaries or table changes at that head.
        input.messages.push({ key: 'tail', role: 'user', content: 'temporary tail', swipe: 0 });
        await synchronize(lib, input);
        const forkPoint = await capture(lib, branch.id);
        const child = await forkBranch(lib, forkPoint, 'other-child');
        input.messages.push({ key: 'later', role: 'assistant', content: 'later body', swipe: 0 });
        await synchronize(lib, input);
        expect(forkPoint.snapshot.id).not.toBe(view.snapshot.id);
        expect((await capture(lib, child.id)).branch.fork?.snapshot).toBe(forkPoint.snapshot.id);
        const pack = await validateArchive(await exportArchive(lib, branch.id));
        expect(pack.pack.data.history_snapshots.some(s => s.id === forkPoint.snapshot.id)).toBe(false);
        expect(await lib.get('history_snapshots', forkPoint.snapshot.id)).toBeDefined();
    } finally { lib.close(); }
});
