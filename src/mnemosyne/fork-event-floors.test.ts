import { test, expect } from 'vitest';
import { fixture, observation } from './fixtures';
import { capture, forkBranch, keepSummary, synchronize } from './canonical';
import { editEvent, eventView, setEventArchived, type EventCard } from './events';
import { saveMemberships } from './event-memberships';
import { commitManualEvent } from './manual-events';
import { previewEventResync, commitEventResync } from './event-resync';
import { exportLibrary, restoreLibrary } from './migration';
import { Library, freshLibraryName } from './db';
import { STORES, type CapturedView, type MemoryRevision } from './model';

async function write(lib: Library, view: CapturedView, ids: string[], label: string, card: EventCard | null = null) {
    return commitManualEvent(lib, view, card, ids, JSON.stringify({ title: label, status: 'resolved', keywords: [],
        overview: `${label}概要`, progress: `${label}追加`, latestProgress: { memory: ids.at(-1), text: `${label}进展` } }), () => true, true);
}
async function cards(lib: Library, branch: string) { return (await eventView(lib, await capture(lib, branch))).cards; }

test('floor 300 material created and archived at 500 survives fork 499, export, and another earlier fork', async () => {
    const lib = await Library.open(freshLibraryName());
    const input = observation(250); input.memories = [];
    const branch = await synchronize(lib, input);
    input.memories = [observation(250).memories[149]]; // The summary itself was also saved late.
    await synchronize(lib, input);
    const parent = await capture(lib, branch.id), memory = parent.memories[0];
    const id = await write(lib, parent, [memory.id], '300楼已完成');
    await setEventArchived(lib, await capture(lib, branch.id), id, true);
    const child = await forkBranch(lib, await capture(lib, branch.id, 499), 'child-499');
    const [copied] = await cards(lib, child.id);
    expect(copied).toMatchObject({ chain: { archived: true }, meta: { overview: '300楼已完成概要',
        status: 'resolved', overviewCoverage: 1, latestProgress: { text: '300楼已完成进展' } }, blocked: false, needsReview: false });
    expect(copied.members).toHaveLength(1); expect(copied.progress).toHaveLength(1);
    expect(copied.members[0].memory).not.toBe(memory.id);
    for (const store of ['event_revisions', 'event_memberships', 'event_progress'] as const)
        expect((await lib.all<any>(store, 'branch', child.id)).every(r => r.cutoff <= 499)).toBe(true);
    const restored = await restoreLibrary(await exportLibrary(lib), false);
    const grandchild = await forkBranch(restored, await capture(restored, child.id, 300), 'child-300');
    expect((await cards(restored, grandchild.id))[0].meta.overview).toBe('300楼已完成概要');
    const tooEarly = await forkBranch(restored, await capture(restored, child.id, 299), 'child-299');
    expect(await cards(restored, tooEarly.id)).toHaveLength(0);
    restored.close(); lib.close();
});

test('late bulk links inherit before first overview, while a late material-only update keeps its latest overview', async () => {
    const { lib, branch, view } = await fixture(3);
    const id = (await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '待整理' })).created!;
    const emptyChild = await forkBranch(lib, await capture(lib, branch.id, 2), 'empty-overview');
    const [empty] = await cards(lib, emptyChild.id);
    expect(empty.meta.title).toBe('待整理'); expect(empty.meta.overview).toBe(''); expect(empty.members).toHaveLength(1);
    await write(lib, await capture(lib, branch.id), [view.memories[0].id], '稍后整理', (await cards(lib, branch.id))[0]);
    const updatedChild = await forkBranch(lib, await capture(lib, branch.id, 2), 'updated-overview');
    expect((await cards(lib, updatedChild.id))[0].meta.overview).toBe('稍后整理概要');
    expect((await cards(lib, branch.id))[0].chain.id).toBe(id);
    lib.close();
});

test('a straddling chain rolls back as a whole, without discarding an independent late earlier-floor chain', async () => {
    const { lib, branch, view } = await fixture(1);
    await write(lib, view, [view.memories[0].id], '早期');
    await synchronize(lib, observation(3));
    let current = await capture(lib, branch.id);
    const mixed = (await cards(lib, branch.id))[0];
    await write(lib, current, current.memories.map(m => m.id), '未来结局', mixed);
    current = await capture(lib, branch.id);
    await write(lib, current, [current.memories[0].id], '迟到独立事件');
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), 'mixed');
    const inherited = await cards(lib, child.id);
    expect(inherited.map(c => c.meta.overview).sort()).toEqual(['早期概要', '迟到独立事件概要']);
    expect(inherited.every(c => c.members.length === 1 && c.progress.length === 1)).toBe(true);
    expect(JSON.stringify(inherited)).not.toContain('未来结局');
    lib.close();
});

test('future active associations veto a late title/status update even when old overview refs are unchanged', async () => {
    const { lib, branch, view } = await fixture(1);
    const id = await write(lib, view, [view.memories[0].id], '早期');
    await synchronize(lib, observation(3));
    let current = await capture(lib, branch.id);
    await saveMemberships(lib, current, { mode: 'add', memories: [current.memories[2].id], eventIds: [id] });
    current = await capture(lib, branch.id);
    await editEvent(lib, current, id, { ...(await cards(lib, branch.id))[0].meta, title: '未来标题', status: 'dormant' });
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), 'before-future-link');
    const [inherited] = await cards(lib, child.id);
    expect(inherited.meta).toMatchObject({ title: '早期', status: 'resolved', overview: '早期概要' });
    expect(inherited.members).toHaveLength(1);
    lib.close();
});

test('summary coverage and source input beyond its anchor cannot be trimmed to admit later prose', async () => {
    const { lib, branch, input, view } = await fixture(3);
    for (const field of ['coverage', 'inputRefs'] as const) {
        input.memories[0] = { ...input.memories[0], [field]: view.refs.slice(0, 4) };
        await synchronize(lib, input);
        const current = await capture(lib, branch.id);
        await write(lib, current, [current.memories.find(m => m.hostId === 'leaf-0')!.id], `${field}跨界`);
    }
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), 'coverage');
    expect(await cards(lib, child.id)).toHaveLength(0);
    lib.close();
});

test.each(['missing', 'invalid'] as const)('%s floor evidence falls back to operation-time history', async kind => {
    const lib = await Library.open(freshLibraryName());
    const empty = observation(0);
    empty.memories = [{ ...observation(1).memories[0], anchorKey: null }];
    const branch = await synchronize(lib, empty);
    const input = { ...observation(1), memories: empty.memories };
    await synchronize(lib, input);
    let current = await capture(lib, branch.id);
    if (kind === 'invalid') {
        const memory: MemoryRevision = { ...current.memories[0], anchor: current.refs[1].message };
        // Synthetic legacy-invalid anchor: it is not in this summary's empty basis.
        await lib.transaction(['memory_revisions'], 'readwrite', tx => tx.put('memory_revisions', memory));
        current = await capture(lib, branch.id);
    }
    await write(lib, current, [current.memories[0].id], '旧规则早期');
    input.messages = observation(3).messages;
    await synchronize(lib, input);
    current = await capture(lib, branch.id);
    await write(lib, current, [current.memories[0].id], '无据迟到', (await cards(lib, branch.id))[0]);
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), `fallback-${kind}`);
    expect((await cards(lib, child.id))[0].meta.overview).toBe('旧规则早期概要');
    lib.close();
});

test('late unsourced prose is not backdated through an old-floor membership', async () => {
    const { lib, branch, view } = await fixture(3);
    await editEvent(lib, view, null, { title: '无来源', status: 'open', keywords: [], overview: '可能包含未来的手写内容' },
        { memory: view.memories[0].id, active: true, kind: 'progress' });
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), 'unsourced');
    expect(await cards(lib, child.id)).toHaveLength(0);
    lib.close();
});

test('late material from a divergent same-text swipe does not cross back to the saved fork', async () => {
    const { lib, branch, view, input } = await fixture(3);
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), 'old-swipe');
    input.messages[1].swipe = 1;
    await synchronize(lib, input);
    const current = await capture(lib, branch.id);
    expect(current.refs[1]).toEqual(view.refs[1]); // Same text can reuse the source revision.
    expect(current.snapshot.variants?.[1]).not.toBe(view.snapshot.variants?.[1]);
    await write(lib, current, [current.memories[0].id], '另一变体迟到事件');
    expect((await previewEventResync(lib, await capture(lib, child.id))).cards).toHaveLength(0);
    lib.close();
});

test('re-inherit does not import original-swipe material into a child changed to the same-text swipe', async () => {
    const { lib, branch, view } = await fixture(3);
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), 'changed-child-swipe');
    const changed = observation(1, 'changed-child-swipe');
    changed.messages[1].swipe = 1;
    await synchronize(lib, changed);
    const current = await capture(lib, child.id);
    expect(current.refs[1]).toEqual(view.refs[1]);
    expect(current.snapshot.variants?.[1]).not.toBe(view.snapshot.variants?.[1]);
    await write(lib, await capture(lib, branch.id), [view.memories[0].id], '原变体迟到事件');
    const plan = await previewEventResync(lib, current);
    expect(plan.cards).toHaveLength(0);
    expect(plan.entries[0].reason).toContain('来源摘要');
    lib.close();
});

test('late material explicitly approved after a source edit keeps that approval in its child', async () => {
    const { lib, branch, view, input } = await fixture(3);
    input.messages[1].content += '人工核对后的修改';
    await synchronize(lib, input);
    await keepSummary(lib, await capture(lib, branch.id), view.memories[0].id);
    const current = await capture(lib, branch.id);
    await write(lib, current, [current.memories[0].id], '人工保留的迟到事件');
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), 'approved-late');
    expect((await cards(lib, child.id))[0]).toMatchObject({ meta: { overview: '人工保留的迟到事件概要' }, blocked: false, needsReview: false });
    lib.close();
});

test('re-inherit repairs an existing empty child, is read-only until apply, and preserves later local edits', async () => {
    const { lib, branch, view } = await fixture(3);
    // This is the old-rule result: valid earlier summaries copied, but no late event.
    const child = await forkBranch(lib, await capture(lib, branch.id, 2), 'old-rule-child');
    const id = await write(lib, await capture(lib, branch.id), [view.memories[0].id], '旧规则漏掉');
    await setEventArchived(lib, await capture(lib, branch.id), id, true);
    const before = (await exportLibrary(lib)).data;
    const plan = await previewEventResync(lib, await capture(lib, child.id));
    expect(plan.entries).toMatchObject([{ action: 'add', archived: true, title: '旧规则漏掉' }]);
    expect((await exportLibrary(lib)).data).toEqual(before);
    expect(await commitEventResync(lib, plan)).toBe(1);
    const [recovered] = await cards(lib, child.id);
    expect(recovered.meta.overview).toBe('旧规则漏掉概要');
    expect(recovered.chain.archived).toBe(true);
    expect((await previewEventResync(lib, await capture(lib, child.id))).cards).toHaveLength(0);
    const after = (await exportLibrary(lib)).data;
    for (const store of STORES)
        expect(after[store].filter((r: any) => r.branch === branch.id)).toEqual(before[store].filter((r: any) => r.branch === branch.id));
    await editEvent(lib, await capture(lib, child.id), recovered.chain.id, { ...recovered.meta, title: '子分支自己改过' });
    await write(lib, await capture(lib, branch.id), [view.memories[0].id], '父分支再整理', (await cards(lib, branch.id))[0]);
    const retry = await previewEventResync(lib, await capture(lib, child.id));
    expect(retry.cards).toHaveLength(0); expect(retry.entries[0].reason).toContain('子分支已修改');
    lib.close();
});
