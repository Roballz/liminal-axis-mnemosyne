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
