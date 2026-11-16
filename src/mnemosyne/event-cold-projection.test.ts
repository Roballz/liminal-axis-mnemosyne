import { expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { capture } from './canonical';
import { editEvent, eventView } from './events';
import { Library } from './db';
import { row, type Branch, type EventRevision } from './model';
import { SharedPayloads } from './shared-payloads';

test('cold current events unpack only the latest overview, while explicit history still loads all revisions', async () => {
    const { lib, view } = await fixture(2);
    let cold: Library | undefined;
    try {
        const id = await editEvent(lib, view, null, { title: '初始事件', status: 'open', keywords: ['合成'],
            overview: '初始概要', summarized: [view.memories[0].id] },
            { memory: view.memories[0].id, active: true, kind: 'progress' });
        const original = (await lib.all<EventRevision>('event_revisions', 'owner', id))[0];
        await lib.transaction(['branches', 'event_revisions'], 'readwrite', async tx => {
            const branch = (await tx.get<Branch>('branches', view.branch.id))!;
            for (let i = 0; i < 64; i++) await tx.add('event_revisions', {
                ...original, ...row('er'), epoch: ++branch.epoch, title: `历史概要 ${i}`, overview: `版本 ${i}：${'仅属于该旧版本的概要。'.repeat(30)}`,
            } as EventRevision);
            // Existing projection semantics break unusual same-epoch ties by
            // IndexedDB primary-key order, not insertion order.
            for (const [key, title] of [['er_zz_latest', '同代后序'], ['er_00_latest', '当前概要']])
                await tx.add('event_revisions', { ...original, id: key, epoch: branch.epoch,
                    title, overview: `${title}：${'当前事件内容。'.repeat(35)}` } as EventRevision);
            await tx.put('branches', branch);
        });
        cold = await Library.open(lib.db.name);
        const current = await capture(cold, view.branch.id);
        const unpack = vi.spyOn(SharedPayloads.prototype, 'unpack');
        try {
            const projection = await eventView(cold, current);
            expect(projection.cards[0].meta.title).toBe('当前概要');
            expect(projection.cards[0].members).toHaveLength(1);
            expect(unpack.mock.calls.filter(([store]) => store === 'event_revisions').map(([, row]) => row.id))
                .toEqual(['er_00_latest']);
            unpack.mockClear();
            const history = await eventView(cold, current, true);
            expect(history.cards[0].history?.revisions).toHaveLength(67);
            expect(unpack.mock.calls.filter(([store]) => store === 'event_revisions')).toHaveLength(67);
        } finally { unpack.mockRestore(); }
    } finally { cold?.close(); lib.close(); }
});
