import { test, expect } from 'vitest';
import { fixture, observation } from './fixtures';
import { capture, forkBranch, synchronize } from './canonical';
import { editEvent, eventView, setEventArchived } from './events';
import { commitManualEvent, keepEventOverview } from './manual-events';
import { previewEventResync, commitEventResync } from './event-resync';
import { exportLibrary, restoreLibrary, validateData } from './migration';
import { STORES, type CapturedView } from './model';
import type { Library } from './db';

const response = (memory: string, label = '早期') => JSON.stringify({ title: '合成事件', status: 'open', keywords: ['玉佩'],
    overview: `${label}概要`, progress: `${label}追加`, latestProgress: { memory, text: `${label}进展` } });
async function create(lib: Library, view: CapturedView, label = '早期') {
    const id = view.memories[0].id;
    return commitManualEvent(lib, view, null, [id], response(id, label), () => true);
}
async function cards(lib: Library, branch: string) { return (await eventView(lib, await capture(lib, branch))).cards; }

test('historical fork ignores unrelated edited floors and keeps archived chains, overview, latest and links', async () => {
    const { lib, branch, view } = await fixture(3);
    const id = await create(lib, view);
    await setEventArchived(lib, await capture(lib, branch.id), id, true);
    const later = observation(4); later.messages[5].content += '无关修改';
    await synchronize(lib, later);
    const child = await forkBranch(lib, await capture(lib, branch.id, 6), 'child');
    const [card] = await cards(lib, child.id);
    expect(card.chain.archived).toBe(true);
    expect(card.members).toHaveLength(1); expect(card.progress).toHaveLength(1);
    expect(card.meta).toMatchObject({ overview: '早期概要', latestProgress: { text: '早期进展' } });
    expect(card).toMatchObject({ blocked: false, needsReview: false });
    lib.close();
});

test('old links follow a confirmed summary revision but unconfirmed narrative cannot inherit', async () => {
    const { lib, branch, view, input } = await fixture(2);
    const id = await create(lib, view);
    input.memories[0] = { ...input.memories[0], content: '润色摘要', manualEdit: true };
    await synchronize(lib, input);
    const unconfirmed = await forkBranch(lib, await capture(lib, branch.id), 'before-review');
    expect(await cards(lib, unconfirmed.id)).toHaveLength(0);
    await keepEventOverview(lib, await capture(lib, branch.id), id);
    input.messages.push(...observation(3).messages.slice(4)); await synchronize(lib, input);
    const child = await forkBranch(lib, await capture(lib, branch.id, 4), 'after-review');
    expect((await cards(lib, child.id))[0]).toMatchObject({ meta: { overview: '早期概要' }, needsReview: false });
    expect((await cards(lib, child.id))[0].members).toHaveLength(1);
    lib.close();
});

test('inherited histories roll both narrative fields back together on repeated forks and survive export', async () => {
    const { lib, branch, view } = await fixture(1);
    await create(lib, view);
    for (const [count, label] of [[2, '中期'], [3, '后期']] as const) {
        await synchronize(lib, observation(count));
        const v = await capture(lib, branch.id), card = (await cards(lib, branch.id))[0];
        await commitManualEvent(lib, v, card, v.memories.map(m => m.id), response(v.memories.at(-1)!.id, label), () => true, true);
    }
    const child = await forkBranch(lib, await capture(lib, branch.id), 'full-child');
    expect((await cards(lib, child.id))[0].meta.overview).toBe('后期概要');
    const restored = await restoreLibrary(await exportLibrary(lib), false);
    for (const [cutoff, label, count] of [[2, '早期', 1], [4, '中期', 2]] as const) {
        const grandchild = await forkBranch(restored, await capture(restored, child.id, cutoff), `grandchild-${cutoff}`);
        const [card] = await cards(restored, grandchild.id);
        expect(card.meta).toMatchObject({ overview: `${label}概要`, latestProgress: { text: `${label}进展` } });
        expect(card.members).toHaveLength(count); expect(card.progress).toHaveLength(count);
    }
    restored.close(); lib.close();
});

test('link removal history survives inheritance and does not erase earlier associations', async () => {
    const { lib, branch, view } = await fixture(1);
    const id = await create(lib, view);
    await synchronize(lib, observation(2));
    let current = await capture(lib, branch.id), card = (await cards(lib, branch.id))[0];
    await editEvent(lib, current, id, { ...card.meta, overview: '', summarized: [], latestProgress: null }, { memory: view.memories[0].id, active: false, kind: 'progress' });
    await synchronize(lib, observation(3));
    current = await capture(lib, branch.id);
    const child = await forkBranch(lib, current, 'unlinked-child');
    expect((await cards(lib, child.id))[0].members).toHaveLength(0);
    const early = await forkBranch(lib, await capture(lib, child.id, 2), 'early');
    expect((await cards(lib, early.id))[0].members).toHaveLength(1);
    expect((await cards(lib, early.id))[0].meta.overview).toBe('早期概要');
    const late = await forkBranch(lib, await capture(lib, child.id, 4), 'late');
    expect((await cards(lib, late.id))[0].members).toHaveLength(0);
    lib.close();
});

test('resync repairs a legacy empty shell, adds missing archives, keeps child edits and is idempotent', async () => {
    const { lib, branch, view } = await fixture(2);
    const first = await create(lib, view);
    const archived = await create(lib, await capture(lib, branch.id), '归档');
    await setEventArchived(lib, await capture(lib, branch.id), archived, true);
    const child = await forkBranch(lib, await capture(lib, branch.id), 'legacy-child');
    const inherited = await cards(lib, child.id), shell = inherited.find(c => !c.chain.archived)!;
    // Reproduce 1.3.8–1.3.10's empty, single-version import without a lineage receipt.
    await lib.transaction(STORES, 'readwrite', async tx => {
        for (const c of inherited) {
            for (const s of ['event_revisions', 'event_memberships', 'event_progress'] as const)
                for (const r of await tx.all(s, 'owner', c.chain.id)) await tx.delete(s, r.id);
            if (c.chain.archived) await tx.delete('event_chains', c.chain.id);
        }
        const { inheritance, ...legacy } = shell.chain;
        await tx.put('event_chains', legacy);
        await tx.add('event_revisions', { ...shell.meta, epoch: 1, refs: [], overview: '', summarized: [], latestProgress: null } as typeof shell.meta);
    });
    const own = await editEvent(lib, await capture(lib, child.id), null, { title: '子分支自建', status: 'open', keywords: [], overview: '自己写的' });
    const before = (await exportLibrary(lib)).data;
    const plan = await previewEventResync(lib, await capture(lib, child.id));
    expect(plan.entries.map(e => e.action).sort()).toEqual(['add', 'replace']);
    expect((await exportLibrary(lib)).data).toEqual(before); // preview is read only
    expect(await commitEventResync(lib, plan)).toBe(2);
    const result = await cards(lib, child.id);
    expect(result).toHaveLength(3);
    expect(result.find(c => c.chain.id === shell.chain.id)?.members).toHaveLength(1);
    expect(result.find(c => c.chain.archived)?.meta.overview).toBe('归档概要');
    expect(result.find(c => c.chain.id === own)?.meta.overview).toBe('自己写的');
    const afterData = (await exportLibrary(lib)).data;
    for (const store of STORES) {
        const after = afterData[store];
        expect(after.filter(r => (r as any).branch === branch.id)).toEqual(before[store].filter(r => (r as any).branch === branch.id));
    }
    expect((await previewEventResync(lib, await capture(lib, child.id))).cards).toHaveLength(0);
    const saved = await exportLibrary(lib); const restored = await restoreLibrary(saved, false);
    expect((await previewEventResync(restored, await capture(restored, child.id))).cards).toHaveLength(0);
    const bad = structuredClone(saved); (bad.data.event_chains.find(c => c.id === shell.chain.id) as any).inheritance.branch = child.id;
    expect(() => validateData(bad)).toThrow('继承凭据');
    restored.close();
    const local = result.find(c => c.chain.id === shell.chain.id)!;
    await editEvent(lib, await capture(lib, child.id), local.chain.id, { ...local.meta, overview: '子分支改写' });
    const parentCard = (await cards(lib, branch.id)).find(c => c.chain.id === first)!;
    await editEvent(lib, await capture(lib, branch.id), first, { ...parentCard.meta, overview: '父分支改写' });
    const retry = await previewEventResync(lib, await capture(lib, child.id));
    expect(retry.entries.some(e => e.reason.includes('子分支已修改'))).toBe(true);
    await commitEventResync(lib, retry);
    expect((await cards(lib, child.id)).find(c => c.chain.id === local.chain.id)?.meta.overview).toBe('子分支改写');
    lib.close();
});

test('resync updates an untouched import, retains its identity and rejects a subsequent stale child preview', async () => {
    const { lib, branch, view } = await fixture(1);
    const id = await create(lib, view);
    const child = await forkBranch(lib, await capture(lib, branch.id), 'child');
    const old = (await cards(lib, child.id))[0];
    const parentCard = (await cards(lib, branch.id))[0];
    await editEvent(lib, await capture(lib, branch.id), id, { ...parentCard.meta, overview: '父档案确认后的措辞' });
    await setEventArchived(lib, await capture(lib, branch.id), id, true);
    const plan = await previewEventResync(lib, await capture(lib, child.id));
    expect(plan.entries[0].action).toBe('replace');
    await commitEventResync(lib, plan);
    const updated = (await cards(lib, child.id))[0];
    expect(updated.chain.id).toBe(old.chain.id);
    expect(updated.chain.archived).toBe(true);
    expect(updated.meta.overview).toBe('父档案确认后的措辞');
    expect(updated.progress).toHaveLength(1);
    const stale = await previewEventResync(lib, await capture(lib, child.id));
    await editEvent(lib, await capture(lib, child.id), updated.chain.id, { ...updated.meta, title: '子分支标题' });
    await expect(commitEventResync(lib, stale)).rejects.toThrow('改变');
    expect((await cards(lib, child.id))[0].meta.title).toBe('子分支标题');
    lib.close();
});

test('resync excludes later plot, refuses stale/changed chat and never overwrites a changed child summary', async () => {
    const { lib, branch, view, input } = await fixture(1);
    const id = await create(lib, view);
    const child = await forkBranch(lib, await capture(lib, branch.id), 'child');
    await synchronize(lib, observation(2));
    const v = await capture(lib, branch.id), card = (await cards(lib, branch.id))[0];
    await commitManualEvent(lib, v, card, v.memories.map(m => m.id), response(v.memories.at(-1)!.id, '未来'), () => true, true);
    const plan = await previewEventResync(lib, await capture(lib, child.id));
    expect(plan.cards.every(c => !c.meta.overview?.includes('未来'))).toBe(true);
    const before = (await exportLibrary(lib)).data;
    await expect(commitEventResync(lib, plan, () => false)).rejects.toThrow('改变');
    expect((await exportLibrary(lib)).data).toEqual(before);
    await setEventArchived(lib, await capture(lib, branch.id), id, true);
    await expect(commitEventResync(lib, plan)).rejects.toThrow('改变');
    const fresh = await previewEventResync(lib, await capture(lib, child.id));
    let calls = 0;
    await expect(commitEventResync(lib, fresh, () => ++calls < 2)).rejects.toThrow('撤销');
    expect((await cards(lib, child.id))[0].chain.archived).toBeFalsy();
    input.memories[0].content = '子分支不同摘要';
    await synchronize(lib, { ...input, scope: 'child' });
    expect((await previewEventResync(lib, await capture(lib, child.id))).cards).toHaveLength(0);
    lib.close();
});
