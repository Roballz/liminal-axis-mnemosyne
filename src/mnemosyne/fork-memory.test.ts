import { test, expect } from 'vitest';
import { fixture, observation, output } from './fixtures';
import { capture, forkBranch, synchronize, statuses, keepSummary } from './canonical';
import { editEvent, eventView, deleteEvent, setEventArchived, prepareEventBatch, commitEventBatch } from './events';
import { exportLibrary, restoreLibrary } from './migration';
import { previewEventResync } from './event-resync';
import { STORES } from './model';

test('full fork copies event summaries, progress, manual links and archive flag independently, survives sync and export', async () => {
    const { lib, branch, input } = await fixture(2);
    const batch = (await prepareEventBatch(lib, await capture(lib, branch.id), 20, 48000))!;
    const result = output(batch);
    result.events[0].latestProgress = { memory: batch.memories[1].id, text: '准备归还' };
    await commitEventBatch(lib, batch, result);
    let parent = await capture(lib, branch.id);
    const card = (await eventView(lib, parent)).cards[0];
    await editEvent(lib, parent, card.chain.id, { title: '父线事件', status: 'dormant', keywords: ['归还'], overview: '已约定归还', summarized: parent.memories.map(m => m.id) }, { memory: parent.memories[0].id, active: true, kind: 'reference' });
    parent = await capture(lib, branch.id);
    await setEventArchived(lib, parent, card.chain.id, true);
    const child = await forkBranch(lib, parent, 'child');
    const copied = (await eventView(lib, await capture(lib, child.id))).cards[0];
    expect(copied.chain.id).not.toBe(card.chain.id);
    expect(copied.chain.archived).toBe(true);
    expect(copied).toMatchObject({ blocked: false, needsReview: false, meta: { overview: '已约定归还', status: 'dormant', latestProgress: { text: '准备归还' } } });
    expect(copied.members.some(m => m.locked && m.kind === 'reference')).toBe(true);
    expect(copied.progress).toHaveLength(1);
    expect(copied.members.every(m => !parent.memories.some(p => p.id === m.memory))).toBe(true);
    await synchronize(lib, { ...input, scope: 'child' });
    expect((await eventView(lib, await capture(lib, child.id))).cards[0]).toMatchObject({ blocked: false, needsReview: false });
    const pack = await exportLibrary(lib), restored = await restoreLibrary(pack, false);
    expect((await eventView(restored, await capture(restored, child.id))).cards[0].meta.overview).toBe('已约定归还');
    restored.close();
    await deleteEvent(lib, await capture(lib, child.id), copied.chain.id);
    expect((await eventView(lib, await capture(lib, branch.id))).cards[0].chain.id).toBe(card.chain.id);
    lib.close();
});

test('historical fork inherits only the earlier event version, never later progress or newly created events', async () => {
    const { lib, branch } = await fixture(1);
    let parent = await capture(lib, branch.id);
    const id = await editEvent(lib, parent, null, { title: '早期', status: 'open', keywords: [], overview: '早期进展', summarized: [parent.memories[0].id] }, { memory: parent.memories[0].id, active: true, kind: 'progress' });
    await synchronize(lib, observation(2));
    parent = await capture(lib, branch.id);
    await editEvent(lib, parent, id, { title: '后期', status: 'closed', keywords: [], overview: '未来结局', summarized: parent.memories.map(m => m.id) }, { memory: parent.memories[1].id, active: true, kind: 'progress' });
    parent = await capture(lib, branch.id);
    await editEvent(lib, parent, null, { title: '未来新事件', status: 'open', keywords: [] });
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), 'earlier-child');
    const view = await capture(lib, child.id), cards = (await eventView(lib, view)).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].meta).toMatchObject({ title: '早期', overview: '早期进展', status: 'open' });
    expect(cards[0].members).toHaveLength(1);
    expect(view.memories).toHaveLength(1);
    expect([...await statuses(lib, view)].every(([, status]) => status === 'valid')).toBe(true);
    lib.close();
});

test('invalid sources are not promoted by inheritance, and interrupted or stale forks write nothing', async () => {
    const { lib, branch, input, view } = await fixture(1);
    await editEvent(lib, view, null, { title: '需审核', status: 'open', keywords: [] }, { memory: view.memories[0].id, active: true, kind: 'progress' });
    const stale = await capture(lib, branch.id);
    input.messages[0].content = '修改正文';
    await synchronize(lib, input);
    await expect(forkBranch(lib, stale, 'stale')).rejects.toThrow('父分支已改变');
    const parent = await capture(lib, branch.id);
    const before = await Promise.all(STORES.map(s => lib.all(s)));
    let checks = 0;
    await expect(forkBranch(lib, parent, 'cancelled', () => ++checks < 2)).rejects.toThrow('撤销');
    expect(await Promise.all(STORES.map(s => lib.all(s)))).toEqual(before);
    const child = await forkBranch(lib, parent, 'child');
    expect((await eventView(lib, await capture(lib, child.id))).cards).toEqual([]);
    lib.close();
});


test('explicitly reviewed sources remain valid in the child and a later edit still invalidates them', async () => {
    const { lib, input, branch, view } = await fixture(1);
    await editEvent(lib, view, null, { title: '人工保留', status: 'open', keywords: [] }, { memory: view.memories[0].id, active: true, kind: 'progress' });
    input.messages[0].content += '修改';
    await synchronize(lib, input);
    await keepSummary(lib, await capture(lib, branch.id), view.memories[0].id);
    const child = await forkBranch(lib, await capture(lib, branch.id), 'reviewed-child');
    let copied = await capture(lib, child.id);
    expect([...await statuses(lib, copied)].map(([, s]) => s)).toEqual(['valid']);
    expect((await eventView(lib, copied)).cards[0].blocked).toBe(false);
    const restored = await restoreLibrary(await exportLibrary(lib), false); restored.close();
    input.messages[0].content += '再次修改';
    await synchronize(lib, { ...input, scope: 'reviewed-child' });
    copied = await capture(lib, child.id);
    expect([...await statuses(lib, copied)].map(([, s]) => s)).toEqual(['needs_review']);
    lib.close();
});

test('reviewed high summaries copy old and approved dependency revisions into the same child family', async () => {
    const { lib, input, branch } = await fixture(1);
    input.memories.push({ ...input.memories[0], hostId: 'high', level: 1, anchorKey: null, children: ['leaf-0'], inputRefs: [], coverage: [] });
    await synchronize(lib, input);
    const original = await capture(lib, branch.id), high = original.memories.find(m => m.level === 1)!;
    input.memories[0].content = '重新措辞的底层摘要';
    await synchronize(lib, input);
    await keepSummary(lib, await capture(lib, branch.id), high.id);
    const event = await editEvent(lib, await capture(lib, branch.id), null, { title: '高层事件', status: 'open', keywords: [],
        overview: '已确认高层概要', summarized: [high.id] }, { memory: high.id, active: true, kind: 'progress' });
    const child = await forkBranch(lib, await capture(lib, branch.id), 'reviewed-high-child');
    const view = await capture(lib, child.id), copied = view.memories.find(m => m.level === 1)!;
    expect([...await statuses(lib, view)].map(([, s]) => s)).toEqual(['valid', 'valid']);
    const oldDependency = await lib.get('memory_revisions', copied.dependencies[0]);
    expect((oldDependency as any).branch).toBe(child.id);
    expect((oldDependency as any).owner).toBe(view.memories.find(m => m.level === 0)!.owner);
    expect(copied.dependencies[0]).not.toBe(view.memories.find(m => m.level === 0)!.id);
    const restored = await restoreLibrary(await exportLibrary(lib), false);
    expect([...await statuses(restored, await capture(restored, child.id))].every(([, s]) => s === 'valid')).toBe(true);
    const card = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    await editEvent(lib, await capture(lib, branch.id), event, { ...card.meta, title: '高层事件新标题' });
    expect((await previewEventResync(lib, await capture(lib, child.id))).cards).toHaveLength(1);
    restored.close(); lib.close();
});
