import { test, expect } from 'vitest';
import { fixture, output } from './fixtures';
import { capture, forkBranch, sameNarrativeRevision, synchronize } from './canonical';
import { commitEventBatch, editEvent, eventView, prepareEventBatch, type EventCard } from './events';
import { cleanLibraryHistory } from './history-cleanup';
import { exportLibrary, restoreLibrary } from './migration';
import type { Membership } from './model';

// Three adjacent summary floors model a missing middle link: only the middle
// family has an obsolete narrative revision; its neighbours have no history.
async function confirmedEvent(withOldMiddle = true) {
    const data = await fixture(3);
    const originalMiddle = data.view.memories.find(m => m.hostId === 'leaf-1')!;
    if (withOldMiddle) {
        data.input.memories[1].content = '已核对的中间摘要：玉佩已交回。';
        await synchronize(data.lib, data.input);
    }
    const view = await capture(data.lib, data.branch.id);
    const batch = (await prepareEventBatch(data.lib, view, 20, 48000))!;
    const result = output(batch);
    const middle = view.memories.find(m => m.hostId === 'leaf-1')!;
    result.events[0].latestProgress = { memory: middle.id, text: '玉佩已交回，等待登记。' };
    await commitEventBatch(data.lib, batch, result);
    const afterBatch = await capture(data.lib, data.branch.id);
    const card = (await eventView(data.lib, afterBatch)).cards[0];
    await editEvent(data.lib, afterBatch, card.chain.id, {
        ...card.meta, title: '玉佩交还登记', keywords: ['玉佩', '归还', '登记'],
        overview: '约定归还玉佩，随后完成交接，目前等待登记。',
        summarized: card.members.map(m => m.memory), confirmOverview: true,
    });
    return { ...data, originalMiddle, middle };
}

const eventState = (card: EventCard) => ({
    title: card.meta.title, status: card.meta.status, keywords: card.meta.keywords,
    overview: card.meta.overview, summarized: card.meta.summarized,
    latestProgress: card.meta.latestProgress, refs: card.meta.refs,
    overviewCoverage: card.meta.overviewCoverage, overviewMaterialMode: card.meta.overviewMaterialMode,
    members: card.members.map(m => ({ memory: m.memory, kind: m.kind, locked: m.locked, active: m.active })),
    progress: card.progress.map(p => ({ text: p.text, memories: p.memories })),
    needsReview: card.needsReview, blocked: card.blocked,
});

test('cleanup of an obsolete middle revision preserves events already based on its current replacement and the child copy', async () => {
    const { lib, branch, originalMiddle, middle } = await confirmedEvent();
    try {
        const beforeView = await capture(lib, branch.id);
        const before = (await eventView(lib, beforeView)).cards[0];
        expect(before.members).toHaveLength(3);
        expect(before.members[1].memory).toBe(middle.id);
        expect(before.needsReview).toBe(false);
        const child = await forkBranch(lib, beforeView, 'synthetic child before cleanup');
        const childBefore = eventState((await eventView(lib, await capture(lib, child.id))).cards[0]);

        await cleanLibraryHistory(lib, async () => true);

        const afterView = await capture(lib, branch.id);
        expect(afterView.memories.map(m => m.id)).toEqual(beforeView.memories.map(m => m.id));
        expect(await lib.get('memory_revisions', originalMiddle.id)).toBeUndefined();
        expect(eventState((await eventView(lib, afterView)).cards[0])).toEqual(eventState(before));
        expect(eventState((await eventView(lib, await capture(lib, child.id))).cards[0])).toEqual(childBefore);
        const restored = await restoreLibrary(await exportLibrary(lib), false);
        try {
            expect(eventState((await eventView(restored, await capture(restored, branch.id))).cards[0])).toEqual(eventState(before));
            expect(eventState((await eventView(restored, await capture(restored, child.id))).cards[0])).toEqual(childBefore);
        } finally { restored.close(); }
    } finally { lib.close(); }
});

test('a tag-only current revision keeps equivalent event prose and its middle association despite older unrelated narrative history', async () => {
    const { lib, input, branch, middle } = await confirmedEvent();
    try {
        input.memories[1].tags = { version: 1, participants: ['合成人物'], planIds: [], eventIds: [] };
        await synchronize(lib, input);
        const view = await capture(lib, branch.id);
        const tagged = view.memories.find(m => m.owner === middle.owner)!;
        expect(tagged.id).not.toBe(middle.id);
        expect(sameNarrativeRevision(middle, tagged)).toBe(true);
        const before = (await eventView(lib, view)).cards[0];
        expect(before.members[1].memory).toBe(tagged.id);
        expect(before.meta.latestProgress?.memory).toBe(tagged.id);
        expect(before.needsReview).toBe(false);

        await cleanLibraryHistory(lib, async () => true);

        const after = (await eventView(lib, await capture(lib, branch.id))).cards[0];
        expect(eventState(after)).toEqual(eventState(before));
        expect(after.members).toHaveLength(3);
        expect(await lib.get('memory_revisions', middle.id)).toBeUndefined();
        const restored = await restoreLibrary(await exportLibrary(lib), false);
        try {
            expect(eventState((await eventView(restored, await capture(restored, branch.id))).cards[0])).toEqual(eventState(before));
            expect(await restored.get('memory_revisions', middle.id)).toBeUndefined();
        } finally { restored.close(); }
    } finally { lib.close(); }
});

test.each([false, true])('cleanup preserves manual unlink/relink ordering and historical operation cutoffs (relinked=%s)', async relink => {
    const { lib, input, branch, middle } = await confirmedEvent();
    try {
        const initial = await capture(lib, branch.id);
        const event = (await eventView(lib, initial)).cards[0];
        await editEvent(lib, initial, event.chain.id, event.meta,
            { memory: middle.id, active: false, kind: 'progress' });
        const removedAt = await capture(lib, branch.id);
        expect((await eventView(lib, removedAt)).cards[0].members).toHaveLength(2);

        input.messages.push(
            { key: 'later-user', role: 'user', content: '合成后续问题', swipe: 0 },
            { key: 'later-assistant', role: 'assistant', content: '合成后续剧情', swipe: 0 },
        );
        await synchronize(lib, input);
        if (relink) {
            const later = await capture(lib, branch.id);
            const card = (await eventView(lib, later)).cards[0];
            await editEvent(lib, later, card.chain.id, card.meta,
                { memory: middle.id, active: true, kind: 'progress' });
        }
        input.memories[1].tags = { version: 1, participants: ['合成人物'], planIds: [], eventIds: [] };
        await synchronize(lib, input);
        const before = await capture(lib, branch.id);
        const tagged = before.memories.find(m => m.owner === middle.owner)!;
        expect(sameNarrativeRevision(middle, tagged)).toBe(true);
        const operations = (await lib.all<Membership>('event_memberships')).filter(m => m.owner === event.chain.id);
        const removals = operations.filter(m => !m.active);
        expect(removals).toHaveLength(1);
        expect(removals[0].cutoff).toBe(removedAt.cutoff);
        expect(removals[0].epoch).toBe(removedAt.branch.epoch);
        expect(removals[0].cutoff).toBeLessThan(before.cutoff);
        const currentBefore = (await eventView(lib, before)).cards[0];
        const historicalBefore = (await eventView(lib, await capture(lib, branch.id, removedAt.cutoff))).cards[0];
        expect(historicalBefore.members).toHaveLength(2);

        await cleanLibraryHistory(lib, async () => true);

        const after = await capture(lib, branch.id);
        expect(after.branch.epoch).toBe(before.branch.epoch + 1);
        for (const operation of operations) {
            const retained = await lib.get<Membership>('event_memberships', operation.id);
            expect(retained).toEqual({ ...operation, memory: operation.memory === middle.id ? tagged.id : operation.memory });
            expect(retained!.epoch).toBeLessThan(after.branch.epoch);
        }
        const card = (await eventView(lib, after)).cards[0];
        expect(eventState(card)).toEqual(eventState(currentBefore));
        expect(card.members.some(m => m.memory === tagged.id)).toBe(relink);
        expect(card.removedMembers?.some(m => m.memory === tagged.id && m.locked)).toBe(!relink);
        const historicalAfter = (await eventView(lib, await capture(lib, branch.id, removedAt.cutoff))).cards[0];
        expect(eventState(historicalAfter)).toEqual(eventState(historicalBefore));
        await exportLibrary(lib);
    } finally { lib.close(); }
});

test('cleanup preserves already-reviewable prose without approving its changed source or dropping the family association', async () => {
    const { lib, input, branch, middle } = await confirmedEvent(false);
    try {
        const before = (await eventView(lib, await capture(lib, branch.id))).cards[0];
        input.memories[1].content = '修订后的中间摘要：本次仅核对玉佩的登记信息。';
        await synchronize(lib, input);
        const view = await capture(lib, branch.id);
        const replacement = view.memories.find(m => m.owner === middle.owner)!;
        expect(sameNarrativeRevision(middle, replacement)).toBe(false);
        const changed = (await eventView(lib, view)).cards[0];
        expect(changed.members).toHaveLength(3);
        expect(changed.members[1].memory).toBe(replacement.id);
        expect(changed.needsReview).toBe(true);

        await cleanLibraryHistory(lib, async () => true);

        const after = (await eventView(lib, await capture(lib, branch.id))).cards[0];
        expect(after.members.map(m => m.memory)).toEqual(changed.members.map(m => m.memory));
        expect(after.meta.title).toBe(before.meta.title);
        expect(after.meta.keywords).toEqual(before.meta.keywords);
        expect(eventState(after)).toEqual(eventState(changed));
        expect(after.meta.overview).toBe(before.meta.overview);
        expect(after.meta.latestProgress).toEqual(before.meta.latestProgress);
        expect(after.needsReview).toBe(true);
        expect(await lib.get('memory_revisions', middle.id)).toBeDefined();
        await exportLibrary(lib);
    } finally { lib.close(); }
});
