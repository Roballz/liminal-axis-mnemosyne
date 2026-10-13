import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { capture, synchronize } from './canonical';
import { previewRoleRepairs, confirmRoleRepairs } from './source-role-repair';
import { withoutTableHistory } from './fixtures';
import { fingerprint, STORES } from './model';
import { exportLibrary, restoreLibrary, validateData, type Package } from './migration';

async function sample(): Promise<Package> {
    const data = Object.fromEntries(STORES.map(s => [s, []])) as unknown as Package['data'];
    const content = '完整正文🙂';
    data.stories.push({ id: 's', schema: 1, created: 1 } as any);
    data.branches.push({ id: 'b', schema: 1, story: 's', head: 'h', view: 'v', epoch: 1, fork: null } as any);
    data.memory_views.push({ id: 'v', schema: 1, story: 's', branch: 'b', selections: {} } as any);
    data.host_bindings.push({ id: 'binding', schema: 1, story: 's', branch: 'b', scope: 'scope', generation: 1, intent: 'new_story' } as any);
    data.source_messages.push({ id: 'm', schema: 1, story: 's' });
    data.source_revisions.push({ id: 'r', schema: 1, story: 's', owner: 'm', role: 'assistant', fingerprint: await fingerprint(['assistant', content]), provenance: { binding: 'binding', hostKey: '0', index: 0, swipe: 0 }, bodySchema: 1, bodyHash: await fingerprint(content), bodyLength: content.length } as any);
    data.source_bodies.push({ id: 'r', schema: 1, story: 's', owner: 'm', content } as any);
    data.manifest_blocks.push({ id: 'block', schema: 1, story: 's', owner: 'current:b', entries: [{ message: 'm', revision: 'r' }], variants: [0] } as any);
    data.history_snapshots.push({ id: 'h', schema: 1, story: 's', branch: 'b', owner: 'current:b', snapshotSchema: 2, previous: null, blocks: ['block'], length: 1, created: 1 } as any);
    return resign({ format: 'mnemosyne-daily', version: 12, schema: 1, created: 1, excluded: [], data, counts: {} as Package['counts'], checksum: '' });
}
async function resign(pack: Package): Promise<Package> {
    pack.counts = Object.fromEntries(Object.entries(pack.data).map(([key, value]) => [key, value.length])) as Package['counts'];
    const { checksum: _, ...base } = pack;
    pack.checksum = await fingerprint(base);
    return pack;
}
test('v12 round trip preserves complete current bodies and absent historical descriptor bodies', async () => {
    const pack = await sample();
    pack.data.source_revisions.push({ ...pack.data.source_revisions[0], id: 'zold' });
    await resign(pack);
    const lib = await restoreLibrary(pack, false);
    try { expect((await exportLibrary(lib)).data).toEqual(pack.data); } finally { lib.close(); }
});
test('missing current body and forged body identity are rejected', async () => {
    const pack = await sample();
    pack.data.source_bodies = [];
    await resign(pack);
    expect(() => validateData(pack)).toThrow('当前正文载荷缺失');
    const forged = await sample();
    forged.data.source_bodies[0].owner = 'other';
    await resign(forged);
    await expect(restoreLibrary(forged, false)).rejects.toThrow('正文载荷非法');
});
test('recomputed package checksum cannot hide same-length payload corruption', async () => {
    const pack = await sample();
    (pack.data.source_bodies[0] as any).content = '篡改正文🙂';
    await resign(pack);
    await expect(restoreLibrary(pack, false)).rejects.toThrow('正文载荷摘要不匹配');
});
test('current snapshots reject top-level variants, foreign blocks and orphan roots', async () => {
    for (const mutate of [
        (p: Package) => { (p.data.history_snapshots[0] as any).variants = [0]; },
        (p: Package) => { p.data.manifest_blocks[0].owner = 'current:other'; },
        (p: Package) => { p.data.history_snapshots.push({ ...p.data.history_snapshots[0], id: 'orphan' }); },
    ]) {
        const pack = await sample(); mutate(pack); await resign(pack);
        expect(() => validateData(pack)).toThrow();
    }
});
test('legacy v1 through v11 packages remain readable without rewriting historical text', async () => {
    for (let version = 1; version <= 11; version++) {
        const pack = await sample();
        const revision = pack.data.source_revisions[0] as any;
        revision.content = (pack.data.source_bodies[0] as any).content;
        delete revision.bodySchema; delete revision.bodyHash; delete revision.bodyLength;
        delete (pack.data as any).source_bodies;
        const snapshot = pack.data.history_snapshots[0] as any;
        delete snapshot.snapshotSchema; delete snapshot.owner;
        const block = pack.data.manifest_blocks[0] as any;
        delete block.variants; delete block.owner;
        if (version < 11) delete (pack.data as any).table_history;
        pack.version = version as Package['version'];
        await resign(pack);
        const lib = await restoreLibrary(pack, false);
        try { expect((await exportLibrary(lib)).data.source_revisions).toEqual(pack.data.source_revisions); } finally { lib.close(); }
    }
});
test('legacy baseline preserves predecessor chain after current-policy publication', async () => {
    const pack = await sample();
    (pack.data.branches[0] as any).legacyHead = 'legacy';
    pack.data.history_snapshots.push({ id: 'legacy', schema: 1, story: 's', branch: 'b', previous: null, blocks: [], length: 0, created: 0 } as any);
    await resign(pack);
    expect(() => validateData(pack)).not.toThrow();
    delete (pack.data.branches[0] as any).legacyHead;
    expect(() => validateData(pack)).toThrow('未提交孤立快照');
});
test('mixed legacy/current-only historical role receipts compare exact ephemeral text digests', async () => {
    const pack = await sample();
    const before = pack.data.source_revisions[0] as any;
    const after = { ...before, id: 'zafter' };
    before.content = (pack.data.source_bodies[0] as any).content;
    before.role = 'system';
    before.fingerprint = await fingerprint([before.role, before.content]);
    delete before.bodySchema; delete before.bodyHash; delete before.bodyLength;
    pack.data.source_revisions.push(after);
    pack.data.source_bodies = [];
    pack.data.manifest_blocks.push({ ...pack.data.manifest_blocks[0], id: 'zblock', entries: [{ message: 'm', revision: 'zafter' }] } as any);
    pack.data.history_snapshots.push({ ...pack.data.history_snapshots[0], id: 'repair', blocks: ['zblock'] } as any);
    Object.assign(pack.data.branches[0], { sourceRoleRepairSchema: 1, sourceRoleRepairs: [{ before: { message: 'm', revision: 'r' }, after: { message: 'm', revision: 'zafter' }, confirmedAt: 1 }] });
    await resign(pack);
    const lib = await restoreLibrary(pack, false);
    try { expect((await exportLibrary(lib)).data.source_revisions).toEqual(pack.data.source_revisions); } finally { lib.close(); }
    after.bodyHash = await fingerprint('另一段正文🙂');
    await resign(pack);
    await expect(restoreLibrary(pack, false)).rejects.toThrow('来源角色修复跨身份、正文或分支');
});
test('forged role fingerprint is rejected even with matching content digest and package checksum', async () => {
    const pack = await sample();
    (pack.data.source_revisions[0] as any).role = 'system';
    await resign(pack);
    await expect(restoreLibrary(pack, false)).rejects.toThrow('正文角色摘要不匹配');
});

test('real v11 import role repair survives a later edit and v12 round trip without mutating legacy bytes', async () => {
    const pack = await sample();
    (pack.data.source_revisions[0] as any).role = 'system';
    (pack.data.source_revisions[0] as any).fingerprint = await fingerprint(['system', (pack.data.source_bodies[0] as any).content]);
    pack.data.message_mappings.push({ id: 'mapping', schema: 1, story: 's', owner: 'binding', message: 'm', hostKey: '0' } as any);
    withoutTableHistory(pack);
    pack.version = 11;
    pack.data.table_history = [];
    await resign(pack);
    const originalRevisions = structuredClone(pack.data.source_revisions);
    const originalSnapshots = structuredClone(pack.data.history_snapshots);
    const lib = await restoreLibrary(pack, false);
    try {
        const input = { scope: 'scope', messages: [{ key: '0', role: 'assistant' as const, content: (originalRevisions[0] as any).content, swipe: 0 }], memories: [] };
        const branch = await synchronize(lib, input);
        let view = await capture(lib, branch.id);
        const candidates = await previewRoleRepairs(lib, view, view.refs);
        expect(candidates).toHaveLength(1);
        await confirmRoleRepairs(lib, view, candidates, () => true);
        input.messages[0].content += ' 后续改动';
        await synchronize(lib, input);
        view = await capture(lib, branch.id);
        expect(view.branch.sourceRoleRepairs).toHaveLength(1);
        const exported = await exportLibrary(lib);
        expect(exported.data.source_bodies.some(r => r.id === candidates[0].after.revision)).toBe(false);
        expect(exported.data.source_revisions.find(r => r.id === originalRevisions[0].id)).toEqual(originalRevisions[0]);
        expect(exported.data.history_snapshots.find(r => r.id === originalSnapshots[0].id)).toEqual(originalSnapshots[0]);
        const restored = await restoreLibrary(exported, false);
        try { expect((await capture(restored, branch.id)).branch.sourceRoleRepairs).toEqual(view.branch.sourceRoleRepairs); } finally { restored.close(); }
    } finally { lib.close(); }
});
test('surplus historical payloads are rejected rather than silently retained or pruned on restore', async () => {
    const pack = await sample();
    pack.data.source_revisions.push({ ...pack.data.source_revisions[0], id: 'zold' });
    pack.data.source_bodies.push({ ...pack.data.source_bodies[0], id: 'zold' });
    await resign(pack);
    await expect(restoreLibrary(pack, false)).rejects.toThrow('非当前正文载荷不得保留');
});
