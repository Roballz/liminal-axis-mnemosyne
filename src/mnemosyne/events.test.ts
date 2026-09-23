import { test, expect, vi } from 'vitest';
import { batchFixture, fixture, output, observation } from './fixtures';
import { prepareEventBatch, parseEventOutput, commitEventBatch, eventView, editEvent, wrapEvents } from './events';
import { capture, synchronize } from './canonical';
import { type Branch, type EventReceipt, type Progress } from './model';
test('five summaries publish five memberships and exactly one append-only progress', async () => {
    const { lib, batch, branch } = await batchFixture();
    const out = output(batch);
    await commitEventBatch(lib, batch, out);
    expect(await lib.all('event_memberships')).toHaveLength(5);
    expect(await lib.all('event_progress')).toHaveLength(1);
    const cards = (await eventView(lib, await capture(lib, branch.id))).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].members).toHaveLength(5);
    expect(cards[0].progress[0].text).toBe(out.events[0].progress);
    lib.close();
});
test('explicit none persists success and is not offered for repeated paid processing', async () => {
    const { lib, batch, branch } = await batchFixture();
    await commitEventBatch(lib, batch, { decisions: batch.memories.map(m => ({ memory: m.id, result: 'none' })), events: [] });
    const receipts = await lib.all<EventReceipt>('event_processing_receipts');
    expect(receipts[0].result).toBe('success');
    expect(await prepareEventBatch(lib, await capture(lib, branch.id), 20, 48000)).toBeNull();
    expect(await lib.all('event_chains')).toHaveLength(0);
    lib.close();
});
test('needs_review is distinguished and held, not an automatic repeated request', async () => {
    const { lib, batch, branch } = await batchFixture();
    await commitEventBatch(lib, batch, { decisions: batch.memories.map(m => ({ memory: m.id, result: 'needs_review' })), events: [] });
    expect((await lib.all<EventReceipt>('event_processing_receipts'))[0].result).toBe('needs_review');
    expect(await prepareEventBatch(lib, await capture(lib, branch.id), 20, 48000)).toBeNull();
    lib.close();
});
test('missing fields, incomplete decisions, invented IDs and contradictory none fail without a receipt', async () => {
    const { lib, batch } = await batchFixture();
    expect(() => parseEventOutput('{}', batch)).toThrow('缺少');
    const incomplete = output(batch);
    incomplete.decisions.pop();
    expect(() => parseEventOutput(JSON.stringify(incomplete), batch)).toThrow('唯一');
    const invented = output(batch, 'fake-old-event');
    expect(() => parseEventOutput(JSON.stringify(invented), batch)).toThrow('event_id');
    const contradictory = output(batch);
    contradictory.decisions[0].result = 'none';
    expect(() => parseEventOutput(JSON.stringify(contradictory), batch)).toThrow('不一致');
    expect(await lib.all('event_processing_receipts')).toHaveLength(0);
    lib.close();
});
test('saved operation retry is idempotent, different output under same ID is rejected', async () => {
    const { lib, batch } = await batchFixture();
    const result = output(batch);
    const first = await commitEventBatch(lib, batch, result);
    expect((await commitEventBatch(lib, batch, result)).id).toBe(first.id);
    expect(await lib.all('event_progress')).toHaveLength(1);
    result.events[0].progress = '不同结果';
    await expect(commitEventBatch(lib, batch, result)).rejects.toThrow('操作ID冲突');
    lib.close();
});
test('save failure atomically rolls back events, links, narrative and receipt', async () => {
    const { lib, batch, branch } = await batchFixture();
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add');
    const original = spy.getMockImplementation();
    spy.mockImplementation(function (this: IDBObjectStore, value: any, key?: IDBValidKey) {
        if (this.name === 'event_processing_receipts')
            throw new Error('injected disk failure');
        return Reflect.apply(originalAdd, this, [value, ...(key === undefined ? [] : [key])]);
    });
    try {
        await expect(commitEventBatch(lib, batch, output(batch))).rejects.toThrow('disk failure');
    }
    finally {
        spy.mockRestore();
    }
    for (const store of ['event_chains', 'event_memberships', 'event_progress', 'event_processing_receipts'] as const)
        expect(await lib.all(store)).toHaveLength(0);
    expect((await lib.get<Branch>('branches', branch.id))?.epoch).toBe(branch.epoch);
    lib.close();
});
const originalAdd = IDBObjectStore.prototype.add;
test('source edit or view change rejects late event output', async () => {
    const { lib, batch, input } = await batchFixture();
    input.messages[1].content = '改写';
    await synchronize(lib, input);
    await expect(commitEventBatch(lib, batch, output(batch))).rejects.toThrow('过期');
    expect(await lib.all('event_progress')).toHaveLength(0);
    lib.close();
});
test('host observation invalidation prevents commit even before new Head is persisted', async () => {
    const { lib, batch } = await batchFixture();
    await expect(commitEventBatch(lib, batch, output(batch), () => false)).rejects.toThrow('过期');
    lib.close();
});
test('one summary can belong to multiple events; reference cannot fake new progress', async () => {
    const { lib, batch } = await batchFixture(1);
    const result = output(batch);
    result.events.push({ ...result.events[0], title: '另一事项', progress: '', members: [{ memory: batch.memories[0].id, kind: 'reference' }] });
    await commitEventBatch(lib, batch, result);
    expect(await lib.all('event_chains')).toHaveLength(2);
    expect(await lib.all('event_memberships')).toHaveLength(2);
    expect(await lib.all('event_progress')).toHaveLength(1);
    lib.close();
});
test('new batch continues old chain, preserving previous paragraph byte for byte', async () => {
    const { lib, input, batch, branch } = await batchFixture(2);
    await commitEventBatch(lib, batch, output(batch));
    const old = (await lib.all<Progress>('event_progress'))[0];
    const event = (await lib.all('event_chains'))[0];
    const larger = observation(4);
    input.messages = larger.messages;
    input.memories = larger.memories;
    await synchronize(lib, input);
    const second = (await prepareEventBatch(lib, await capture(lib, branch.id), 20, 48000))!;
    expect(second.memories).toHaveLength(2);
    expect(second.prompt).toContain(event.id);
    await commitEventBatch(lib, second, output(second, event.id));
    expect(await lib.get('event_progress', old.id)).toEqual(old);
    expect(await lib.all('event_progress')).toHaveLength(2);
    lib.close();
});
test('manual removal is recorded, locked and invalidates the dependent paragraph', async () => {
    const { lib, batch, branch } = await batchFixture();
    await commitEventBatch(lib, batch, output(batch));
    let view = await capture(lib, branch.id);
    let card = (await eventView(lib, view)).cards[0];
    await editEvent(lib, view, card.chain.id, card.meta, { memory: batch.memories[0].id, active: false, kind: 'progress' });
    view = await capture(lib, branch.id);
    card = (await eventView(lib, view)).cards[0];
    expect(card.members).toHaveLength(4);
    expect(card.progress).toHaveLength(0);
    expect(await lib.all('event_memberships')).toHaveLength(6);
    expect(await lib.all('event_progress')).toHaveLength(1);
    lib.close();
});
test('full catalog budget pauses instead of selecting a few candidate cards', async () => {
    const { lib, view, branch } = await fixture(1);
    let v = view;
    for (let i = 0; i < 12; i++) {
        await editEvent(lib, v, null, { title: `完整目录事项 ${i}`, status: 'closed', keywords: [] });
        v = await capture(lib, branch.id);
    }
    const batch = await prepareEventBatch(lib, v, 20, 48000);
    expect(batch?.catalog).toHaveLength(12);
    expect(batch?.prompt).toContain('完整目录事项 11');
    await expect(prepareEventBatch(lib, v, 20, 50)).rejects.toThrow('事件目录过大');
    lib.close();
});
test('historical cutoff never leaks future members, counts, title or progress', async () => {
    const { lib, input, batch, branch } = await batchFixture(2);
    await commitEventBatch(lib, batch, output(batch));
    const earlier = await capture(lib, branch.id);
    const chain = (await lib.all('event_chains'))[0];
    const later = observation(4);
    input.messages = later.messages;
    input.memories = later.memories;
    await synchronize(lib, input);
    const next = (await prepareEventBatch(lib, await capture(lib, branch.id), 20, 48000))!;
    const result = output(next, chain.id);
    result.events[0].title = '未来标题';
    result.events[0].progress = '未来进展';
    await commitEventBatch(lib, next, result);
    const historical = await capture(lib, branch.id, 4, earlier.snapshot.id);
    const card = (await eventView(lib, historical)).cards[0];
    expect(card.members).toHaveLength(2);
    expect(card.meta.title).toBe('玉佩归还');
    expect(card.progress).toHaveLength(1);
    const text = wrapEvents([card], historical, [batch.memories[0].id], [], { chains: 2, excerptChars: 500, totalChars: 1600, extra: 1 });
    expect(text).not.toContain('未来');
    expect(text).toContain('/2');
    lib.close();
});
test('multi-hit chain is wrapped once without removing normal selected evidence', async () => {
    const { lib, batch, branch } = await batchFixture();
    await commitEventBatch(lib, batch, output(batch));
    const view = await capture(lib, branch.id), { cards } = await eventView(lib, view);
    const selected = batch.memories.slice(0, 2).map(m => m.id);
    const text = wrapEvents(cards, view, selected, [], { chains: 2, excerptChars: 500, totalChars: 1600, extra: 1 });
    expect(text.match(/\[事件：/g)).toHaveLength(1);
    expect(selected).toHaveLength(2);
    expect(text).toContain('补充最新进展');
    lib.close();
});
test('latest already selected or recent is never added again', async () => {
    const { lib, batch, branch } = await batchFixture();
    await commitEventBatch(lib, batch, output(batch));
    const view = await capture(lib, branch.id), { cards } = await eventView(lib, view), latest = batch.memories.at(-1)!.id;
    const budget = { chains: 2, excerptChars: 500, totalChars: 1600, extra: 1 };
    expect(wrapEvents(cards, view, [batch.memories[0].id], [latest], budget)).not.toContain('补充最新进展');
    expect(wrapEvents(cards, view, [latest], [], budget)).not.toContain('补充最新进展');
    lib.close();
});
test('long 25-member chain has a fixed total budget and at most one extra summary', async () => {
    const { lib, view, branch } = await fixture(25);
    const batch = (await prepareEventBatch(lib, view, 30, 48000))!;
    const result = output(batch);
    result.events[0].progress = '长概述'.repeat(800);
    await commitEventBatch(lib, batch, result);
    const next = await capture(lib, branch.id), { cards } = await eventView(lib, next);
    const text = wrapEvents(cards, next, [batch.memories[12].id], [], { chains: 2, excerptChars: 120, totalChars: 250, extra: 1 });
    expect(text.length).toBeLessThanOrEqual(250);
    expect(text.match(/补充最新进展/g)).toHaveLength(1);
    expect(text).toContain('13/25');
    expect(text).not.toContain(batch.memories[1].content);
    lib.close();
});
test('a paragraph whose batch crosses cutoff is excluded in its entirety', async () => {
    const { lib, batch, branch } = await batchFixture();
    await commitEventBatch(lib, batch, output(batch));
    const view = await capture(lib, branch.id, 4);
    expect((await eventView(lib, view)).cards).toHaveLength(0);
    lib.close();
});
test('history backfill chooses a batch cutoff before loading the event catalog', async () => {
    const { lib, view, branch } = await fixture(5);
    await editEvent(lib, view, null, { title: '末尾才出现的未来事项', status: 'open', keywords: [] });
    const batch = await prepareEventBatch(lib, await capture(lib, branch.id), 2, 48000);
    expect(batch?.view.cutoff).toBe(4);
    expect(batch?.prompt).not.toContain('末尾才出现的未来事项');
    lib.close();
});
