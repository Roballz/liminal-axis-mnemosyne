import { test, expect } from 'vitest';
import { fixture } from './fixtures';
import { capture, statuses, synchronize } from './canonical';
import { previewRoleRepairs, confirmRoleRepairs } from './source-role-repair';
import { eventView, prepareEventBatch, commitEventBatch } from './events';
import { exportLibrary, restoreLibrary } from './migration';
import { STORES, fingerprint } from './model';
import { reviewDifference } from './review-diagnostics';
import { sourceContent } from './source-equivalence';

async function legacyFixture() {
    const { lib, input } = await fixture(2);
    input.messages[1].role = 'system';
    input.memories.forEach(m => { m.content += '（旧误判期间归档）'; });
    let view = await capture(lib, (await synchronize(lib, input)).id);
    input.memories[1].inputRefs = [view.refs[1], view.refs[3]];
    input.memories[1].coverage = view.refs;
    view = await capture(lib, (await synchronize(lib, input)).id);
    const batch = (await prepareEventBatch(lib, view, 2, 50000))!;
    await commitEventBatch(lib, batch, {
        decisions: batch.memories.map(m => ({ memory: m.id, result: 'linked' })),
        events: [{ event_id: null, title: '已完成的整理', status: 'open', keywords: [],
            members: batch.memories.map(m => ({ memory: m.id, kind: 'progress' })), progress: '原进展不能丢失或重复付费整理' }],
    });
    input.messages[1].role = 'assistant';
    view = await capture(lib, (await synchronize(lib, input)).id);
    const candidates = await previewRoleRepairs(lib, view, [view.refs[1]]);
    return { lib, input, view, candidates };
}

test('confirmed exact roles recover explicit inputs, coverage, event progress and processing receipts; edits still block', async () => {
    const { lib, input, view, candidates } = await legacyFixture();
    expect([...await statuses(lib, view)].map(([, s]) => s)).toEqual(['needs_review', 'needs_review']);
    await confirmRoleRepairs(lib, view, candidates, () => true);
    let current = await capture(lib, view.branch.id);
    expect([...await statuses(lib, current)].map(([, s]) => s)).toEqual(['valid', 'valid']);
    expect(sourceContent(current, candidates[0].before)).toBe(input.messages[1].content);
    expect((await eventView(lib, current)).cards[0].progress[0].text).toContain('不能丢失');
    expect(await prepareEventBatch(lib, current, 2, 50000)).toBeNull(); // No repeated automatic API batch.
    expect((await eventView(lib, await capture(lib, view.branch.id, 2))).cards).toEqual([]);
    input.messages[3].content += '另一个真实正文改动';
    current = await capture(lib, (await synchronize(lib, input)).id);
    expect((await statuses(lib, current)).get(view.memories[1].id)).toBe('needs_review');
    expect(await reviewDifference(lib, current, view.memories[1].id)).toMatchObject({ kind: 'text', floor: 3 });
    expect((await eventView(lib, current)).cards).toEqual([]);
    expect(sourceContent(await capture(lib, view.branch.id, 1), candidates[0].before)).toBeUndefined();
    lib.close();
});

test('repair guards, invalid pairs and changed branch are atomic and never approve stale input', async () => {
    const { lib, input, view, candidates } = await legacyFixture();
    const snapshot = () => Promise.all(STORES.map(store => lib.all(store)));
    const before = await snapshot();
    let calls = 0;
    await expect(confirmRoleRepairs(lib, view, candidates, () => ++calls === 1)).rejects.toThrow('聊天已改变');
    expect(await snapshot()).toEqual(before);
    const forged = { ...candidates[0], after: view.refs[3], floor: 3 };
    await expect(confirmRoleRepairs(lib, view, [...candidates, forged], () => true)).rejects.toThrow('不再符合');
    expect(await snapshot()).toEqual(before);
    input.messages[1].content += '后续编辑';
    await synchronize(lib, input);
    const edited = await snapshot();
    await expect(confirmRoleRepairs(lib, view, candidates, () => true)).rejects.toThrow('视图已改变');
    expect(await snapshot()).toEqual(edited);
    const current = await capture(lib, view.branch.id);
    expect(await previewRoleRepairs(lib, current, [current.refs[1]])).toEqual([]);
    lib.close();
});

test.each(['content', 'identity', 'swipe', 'role'])('same-text repair rejects an invalid %s lineage in export and restore', async kind => {
    const { lib, view, candidates } = await legacyFixture();
    await confirmRoleRepairs(lib, view, candidates, () => true);
    const pack = await exportLibrary(lib);
    const old = pack.data.source_revisions.find(r => r.id === candidates[0].before.revision) as any;
    if (kind === 'content') old.content += '不同正文';
    if (kind === 'swipe') old.provenance.swipe++;
    if (kind === 'role') old.role = 'user';
    if (kind === 'identity') (pack.data.branches.find(r => r.id === view.branch.id) as any).sourceRoleRepairs[0].after = view.refs[3];
    const { checksum, ...base } = pack;
    pack.checksum = await fingerprint(base);
    await expect(restoreLibrary(pack, false)).rejects.toThrow('来源角色修复跨身份、正文或分支');
    expect((await capture(lib, view.branch.id)).branch.sourceRoleRepairs).toHaveLength(1);
    lib.close();
});

test('repair cannot merge a same-text new message or approve reordered source prefixes', async () => {
    const { lib, input, view, candidates } = await legacyFixture();
    await confirmRoleRepairs(lib, view, candidates, () => true);
    input.messages[1].key = 'unrelated-identical-reply';
    let current = await capture(lib, (await synchronize(lib, input)).id);
    expect(await previewRoleRepairs(lib, current, [current.refs[1]])).toEqual([]);
    expect((await eventView(lib, current)).cards).toEqual([]);
    input.messages[1].key = view.sources.get(view.refs[1].revision)!.provenance.hostKey;
    [input.messages[0], input.messages[1]] = [input.messages[1], input.messages[0]];
    current = await capture(lib, (await synchronize(lib, input)).id);
    expect((await eventView(lib, current)).cards).toEqual([]);
    lib.close();
});
