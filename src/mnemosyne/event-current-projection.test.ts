import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { capture, synchronize } from './canonical';
import { Library, Transaction } from './db';
import { eventView, editEvent, setEventArchived } from './events';
import { saveMemberships } from './event-memberships';
import { commitManualEvent } from './manual-events';
import { row, type Branch, type EventRevision, type Progress } from './model';

afterEach(() => vi.restoreAllMocks());

test('bulk add reads only its target chain; new-chain add does not read unrelated event history', async () => {
    const { lib, view } = await fixture(3);
    try {
        const first = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '甲' });
        const reads = vi.spyOn(Transaction.prototype, 'all');
        let next = await capture(lib, view.branch.id);
        reads.mockClear();
        const second = await saveMemberships(lib, next, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '乙' });
        expect(reads.mock.calls.filter(([store]) => store.startsWith('event_'))).toEqual([]);
        next = await capture(lib, view.branch.id);
        reads.mockClear();
        await saveMemberships(lib, next, { mode: 'add', memories: [view.memories[1].id], eventIds: [second.created!] });
        expect(reads.mock.calls.filter(([store]) => store.startsWith('event_'))
            .every(([, index, key]) => index === 'owner' && key === second.created)).toBe(true);
        const current = await capture(lib, view.branch.id), cards = (await eventView(lib, current)).cards;
        expect(cards.find(c => c.chain.id === first.created)!.members).toHaveLength(1);
        expect(cards.find(c => c.chain.id === second.created)!.members).toHaveLength(2);
    } finally { lib.close(); }
});

test('unlink does not lock source bodies, custom tables or unrelated stores', async () => {
    const { lib, view } = await fixture(2);
    try {
        const created = await saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '窄事务' });
        const current = await capture(lib, view.branch.id), card = (await eventView(lib, current)).cards[0];
        const transactions = vi.spyOn(Library.prototype, 'transaction');
        await editEvent(lib, current, created.created!, card.meta, { memory: view.memories[0].id, active: false, kind: 'progress' });
        const writes = transactions.mock.calls.filter(([, mode]) => mode === 'readwrite').map(([stores]) => [...stores].sort());
        expect(writes).toEqual([['branches', 'event_chains', 'event_memberships', 'event_revisions']]);
        expect(transactions.mock.calls.every(([stores]) => !stores.includes('source_bodies') && !stores.includes('custom_table_rows'))).toBe(true);
    } finally { lib.close(); }
});

test('saving an overview reuses covered current summaries without one transaction per member', async () => {
    const { lib, view } = await fixture(40);
    const raw = JSON.stringify({ title: '概要', status: 'open', keywords: [], overview: '合成完整概要', progress: '', latestProgress: null });
    try {
        await commitManualEvent(lib, view, null, view.memories.map(m => m.id), raw, () => true);
        const current = await capture(lib, view.branch.id), card = (await eventView(lib, current)).cards[0];
        const transactions = vi.spyOn(Library.prototype, 'transaction');
        await commitManualEvent(lib, current, card, current.memories.map(m => m.id), raw, () => true);
        expect(transactions.mock.calls.filter(([stores]) => stores.length === 1 && stores[0] === 'memory_revisions')).toHaveLength(0);
        expect((await eventView(lib, await capture(lib, current.branch.id))).cards[0].members).toHaveLength(40);
    } finally { lib.close(); }
});

test('a warm current projection skips all old rows; committed unlink updates only its compact family state', async () => {
    const { lib, view } = await fixture(3);
    try {
        const id = (await saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '长历史' })).created!;
        const original = (await lib.all<EventRevision>('event_revisions', 'owner', id))[0];
        await lib.transaction(['branches', 'event_revisions'], 'readwrite', async tx => {
            const branch = (await tx.get<Branch>('branches', view.branch.id))!;
            for (let index = 0; index < 100; index++) await tx.add('event_revisions', {
                ...original, ...row('er'), epoch: ++branch.epoch, title: `第${index}版`,
            } as EventRevision);
            await tx.put('branches', branch);
        });
        let current = await capture(lib, view.branch.id);
        const first = await eventView(lib, current), reads = vi.spyOn(Transaction.prototype, 'all');
        expect(await eventView(lib, current)).toBe(first);
        await editEvent(lib, current, id, first.cards[0].meta, { memory: current.memories[0].id, active: false, kind: 'progress' });
        current = await capture(lib, view.branch.id);
        const changed = await eventView(lib, current);
        expect(changed).not.toBe(first);
        expect(changed.cards[0].meta.title).toBe('第99版');
        expect(changed.cards[0].members).toHaveLength(2);
        expect(changed.cards[0].removedMembers?.map(link => link.memory)).toContain(view.memories[0].id);
        expect(reads.mock.calls.filter(([store]) => ['event_revisions', 'event_memberships', 'event_progress'].includes(store))).toHaveLength(0);
        reads.mockClear();
        const history = await eventView(lib, current, true);
        expect(history.cards[0].history?.revisions).toHaveLength(102);
        expect(reads.mock.calls.filter(([store]) => store === 'event_revisions')).toHaveLength(1);
        expect(await eventView(lib, current)).toBe(changed);
    } finally { lib.close(); }
});

test('archive changes are observed without changing epoch or rereading the history payload', async () => {
    const { lib, view } = await fixture(2);
    try {
        const id = (await saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '收起' })).created!;
        const current = await capture(lib, view.branch.id), first = await eventView(lib, current);
        const reads = vi.spyOn(Transaction.prototype, 'all');
        await setEventArchived(lib, current, id, true);
        const archived = await eventView(lib, current);
        expect(archived).not.toBe(first);
        expect(archived.cards[0].chain.archived).toBe(true);
        expect((await lib.get<Branch>('branches', view.branch.id))!.epoch).toBe(current.branch.epoch);
        expect(reads.mock.calls.filter(([store]) => ['event_revisions', 'event_memberships', 'event_progress'].includes(store))).toHaveLength(0);
        expect(await eventView(lib, current)).toBe(archived);
    } finally { lib.close(); }
});

test('an aborted unlink cannot advance the compact cache or remove a member', async () => {
    const { lib, view } = await fixture(2);
    try {
        const id = (await saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '撤销' })).created!;
        const current = await capture(lib, view.branch.id), first = await eventView(lib, current), version = lib.changes.version;
        let checks = 0;
        await expect(editEvent(lib, current, id, first.cards[0].meta,
            { memory: current.memories[0].id, active: false, kind: 'progress' }, () => ++checks === 1)).rejects.toThrow('未提交');
        expect(lib.changes.version).toBe(version);
        expect(await eventView(lib, current)).toBe(first);
        expect(first.cards[0].members).toHaveLength(2);
    } finally { lib.close(); }
});

test('unlink and rejoin retain the original progress history and explicit removal state', async () => {
    const { lib, view } = await fixture(2);
    const raw = JSON.stringify({ title: '保留追加史', status: 'open', keywords: [], overview: '完整概要', progress: '两条摘要共同形成进展', latestProgress: null });
    try {
        const id = await commitManualEvent(lib, view, null, view.memories.map(memory => memory.id), raw, () => true);
        let current = await capture(lib, view.branch.id), card = (await eventView(lib, current)).cards[0];
        expect(card.progress).toHaveLength(1);
        await editEvent(lib, current, id, card.meta, { memory: view.memories[0].id, active: false, kind: 'progress' });
        current = await capture(lib, view.branch.id); card = (await eventView(lib, current)).cards[0];
        expect(card.progress).toHaveLength(0);
        expect(card.removedMembers).toHaveLength(1);
        expect(card.needsReview).toBe(true);
        await editEvent(lib, current, id, card.meta, { memory: view.memories[0].id, active: true, kind: 'progress' });
        current = await capture(lib, view.branch.id); card = (await eventView(lib, current)).cards[0];
        expect(card.progress).toHaveLength(1);
        expect(card.progress[0].text).toBe('两条摘要共同形成进展');
        expect(card.removedMembers).toHaveLength(0);
        expect(card.needsReview).toBe(false);
    } finally { lib.close(); }
});

test('foreign-connection event changes and changed source selections discard the compact cache', async () => {
    const { lib, view, input } = await fixture(3);
    const other = await Library.open(lib.db.name);
    try {
        const id = (await saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '外部变化' })).created!;
        let current = await capture(lib, view.branch.id), card = (await eventView(lib, current)).cards[0];
        await editEvent(other, current, id, card.meta, { memory: current.memories[0].id, active: false, kind: 'progress' });
        current = await capture(lib, view.branch.id);
        const reads = vi.spyOn(Transaction.prototype, 'all');
        card = (await eventView(lib, current)).cards[0];
        expect(card.members).toHaveLength(2);
        expect(reads.mock.calls.filter(([store]) => store === 'event_memberships')).toHaveLength(1);
        input.memories[1].content += ' 已修订';
        await synchronize(lib, input);
        current = await capture(lib, view.branch.id);
        reads.mockClear();
        const sourceChanged = await eventView(lib, current);
        expect(reads.mock.calls.filter(([store]) => store === 'event_memberships')).toHaveLength(1);
        expect(sourceChanged.cards[0].members.some(link => link.memory === current.memories[1].id)).toBe(true);
        // A historical cutoff cannot consume the live compact rows or overwrite its cache.
        reads.mockClear();
        await eventView(lib, await capture(lib, current.branch.id, 2));
        expect(reads.mock.calls.filter(([store]) => store === 'event_memberships')).toHaveLength(1);
        expect(await eventView(lib, current)).toBe(sourceChanged);
    } finally { other.close(); lib.close(); }
});

test('an oversized committed membership batch takes the complete cold path instead of trusting a partial journal', async () => {
    const { lib, view } = await fixture(140);
    try {
        const id = (await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '大批加入' })).created!;
        let current = await capture(lib, view.branch.id);
        await eventView(lib, current);
        await saveMemberships(lib, current, { mode: 'add', memories: current.memories.map(memory => memory.id), eventIds: [id] });
        current = await capture(lib, view.branch.id);
        const reads = vi.spyOn(Transaction.prototype, 'all');
        expect((await eventView(lib, current)).cards[0].members).toHaveLength(140);
        expect(reads.mock.calls.filter(([store]) => store === 'event_memberships')).toHaveLength(1);
    } finally { lib.close(); }
});

test('same-cutoff same-epoch progress keeps IndexedDB key order in warm and cold legacy overviews', async () => {
    const { lib, view } = await fixture(1);
    const other = await Library.open(lib.db.name);
    try {
        const id = (await saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(memory => memory.id), eventIds: [], newTitle: '并列进展' })).created!;
        const original = (await lib.all<EventRevision>('event_revisions', 'owner', id))[0];
        let first!: Progress;
        await lib.transaction(['branches', 'event_revisions', 'event_progress'], 'readwrite', async tx => {
            const branch = (await tx.get<Branch>('branches', view.branch.id))!;
            const revision: EventRevision = { ...original, ...row('er'), epoch: ++branch.epoch };
            delete revision.overview; delete revision.summarized;
            first = { ...row('ep'), id: 'ep_z', story: branch.story, branch: branch.id, owner: id,
                snapshot: view.snapshot.id, cutoff: view.cutoff, epoch: branch.epoch,
                memories: [view.memories[0].id], text: '主键排后', operation: 'synthetic-progress' };
            await tx.add('event_revisions', revision);
            await tx.add('event_progress', first);
            await tx.put('branches', branch);
        });
        let current = await capture(lib, view.branch.id);
        expect((await eventView(lib, current)).cards[0].meta.overview).toBe('主键排后');
        await lib.transaction(['branches', 'event_progress'], 'readwrite', async tx => {
            const branch = (await tx.get<Branch>('branches', view.branch.id))!;
            const earlier: Progress = { ...first, id: 'ep_a', text: '主键排前' };
            await tx.add('event_progress', earlier);
            await tx.put('branches', { ...branch, epoch: branch.epoch + 1 } as Branch);
        });
        current = await capture(lib, view.branch.id);
        const warm = await eventView(lib, current), cold = await eventView(other, current);
        expect(warm.cards).toEqual(cold.cards);
        expect(warm.cards[0].progress.map(progress => progress.id)).toEqual(['ep_a', 'ep_z']);
        expect(warm.cards[0].meta.overview).toBe('主键排前\n主键排后');
    } finally { other.close(); lib.close(); }
});
