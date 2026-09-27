import { expect, test, vi } from 'vitest';
import { batchFixture, output } from './fixtures';
import { capture, forkBranch } from './canonical';
import { commitEventBatch, eventView } from './events';
import { Transaction } from './db';

test('shared event members do not reread selected summaries; historical fork projection stays complete', async () => {
    const { lib, batch, branch } = await batchFixture(20);
    try {
        const out = output(batch);
        out.events = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(out.events[0]), title: `合成事件${i}` }));
        await commitEventBatch(lib, batch, out);
        const view = await capture(lib, branch.id);
        const spy = vi.spyOn(Transaction.prototype, 'get');
        try {
            const start = performance.now();
            const current = await eventView(lib, view);
            const reads = spy.mock.calls.filter(([store]) => store === 'memory_revisions').length;
            console.info(`event projection: ${Math.round(performance.now() - start)}ms; summary rereads=${reads}; members=160`);
            expect(current.cards).toHaveLength(8);
            expect(current.cards.every(c => c.members.length === 20 && c.progress.length === 1 && !c.blocked && !c.needsReview)).toBe(true);
            expect(reads).toBe(0);
            spy.mockClear();
            const historical = await eventView(lib, view, true);
            expect(historical.cards.every(c => c.history?.memberships.length === 20 && c.history.revisions.length === 1 && c.inheritanceKey)).toBe(true);
            expect(spy.mock.calls.filter(([store]) => store === 'memory_revisions')).toHaveLength(0);
        } finally { spy.mockRestore(); }
        const child = await forkBranch(lib, view, 'performance-child');
        const childEvents = await eventView(lib, await capture(lib, child.id));
        expect(childEvents.cards.every(c => c.members.length === 20 && c.progress.length === 1)).toBe(true);
        expect(childEvents.cards).toHaveLength(8);
    } finally { lib.close(); }
});
