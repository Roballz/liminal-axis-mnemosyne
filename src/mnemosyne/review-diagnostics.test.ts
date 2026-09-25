import { test, expect } from 'vitest';
import { fixture } from './fixtures';
import { capture, forkBranch, keepSummary, statuses, synchronize } from './canonical';
import { Library } from './db';
import { editEvent, eventView, wrapEvents } from './events';
import { reviewDifference } from './review-diagnostics';
import { STORES } from './model';

test('108 legacy summaries can need review after one early role change; readonly diagnosis preserves every row and event', async () => {
    const { lib, input, view } = await fixture(108);
    await editEvent(lib, view, null, { title: '合成完整事件', status: 'open', keywords: [] }, { memory: view.memories[107].id, active: true, kind: 'progress' });
    input.messages[0].role = 'system';
    const branch = await synchronize(lib, input), next = await capture(lib, branch.id);
    expect([...await statuses(lib, next)].filter(([, status]) => status === 'needs_review')).toHaveLength(108);
    const snapshot = () => Promise.all(STORES.map(store => lib.all(store)));
    const before = await snapshot();
    const difference = await reviewDifference(lib, next, next.memories[107].id);
    expect(difference.kind).toBe('role');
    expect(difference.floor).toBe(0);
    expect(difference.before?.excerpt).toBe(difference.after?.excerpt);
    expect(difference.explanation).toContain('历史前缀');
    const events = await eventView(lib, next);
    expect(events).toMatchObject({ storedCount: 1, cards: [{ blocked: true }] });
    expect(wrapEvents(events.cards, next, next.memories.map(m => m.id), [], { chains: 5, excerptChars: 500, totalChars: 2000, extra: 1 })).toBe('');
    expect(await snapshot()).toEqual(before);
    const name = lib.db.name;
    lib.close();
    const reopened = await Library.open(name);
    expect(await reopened.all('event_chains')).toHaveLength(1);
    expect(await reopened.all('event_memberships')).toHaveLength(1);
    reopened.close();
});

test('identical parent and child stay separate; source change in child does not erase events or invalidate parent', async () => {
    const { lib, input, view } = await fixture(2);
    await editEvent(lib, view, null, { title: '父事件', status: 'open', keywords: [] });
    const parent = await capture(lib, view.branch.id);
    const child = await forkBranch(lib, parent, 'child-chat');
    const childInput = { ...structuredClone(input), scope: 'child-chat' };
    await synchronize(lib, childInput);
    const childView = await capture(lib, child.id);
    await editEvent(lib, childView, null, { title: '子事件', status: 'open', keywords: [] }, { memory: childView.memories[0].id, active: true, kind: 'progress' });
    const eventsBefore = await lib.all('event_revisions');
    await synchronize(lib, input);
    await synchronize(lib, childInput);
    expect((await eventView(lib, await capture(lib, child.id))).cards[0].meta.title).toBe('子事件');
    expect((await eventView(lib, await capture(lib, parent.branch.id))).cards[0].meta.title).toBe('父事件');
    childInput.messages[0].content += '\n新增正文';
    await synchronize(lib, childInput);
    const next = await capture(lib, child.id);
    const difference = await reviewDifference(lib, next, next.memories[0].id);
    expect(difference.kind).toBe('text');
    expect(difference.after?.excerpt).toContain('\\n新增正文');
    expect((await eventView(lib, next)).storedCount).toBe(1);
    expect((await eventView(lib, next)).cards).toMatchObject([{ blocked: true }]);
    expect((await eventView(lib, await capture(lib, parent.branch.id))).cards).toHaveLength(1);
    expect(await lib.all('event_revisions')).toEqual(eventsBefore);
    lib.close();
});

test('same-text replacement reports identity mismatch without guessing that it is compatible', async () => {
    const { lib, input, view } = await fixture(1);
    input.messages[0].key = 'new-identity';
    const next = await capture(lib, (await synchronize(lib, input)).id);
    const difference = await reviewDifference(lib, next, next.memories[0].id);
    expect(difference.kind).toBe('identity');
    expect(difference.before?.excerpt).toBe(difference.after?.excerpt);
    expect(await lib.all('reviews')).toHaveLength(0);
    expect((await statuses(lib, next)).get(view.memories[0].id)).toBe('needs_review');
    lib.close();
});

test('explicit provenance ignores unrelated prefix changes and locates its actual changed input', async () => {
    const { lib, input, view } = await fixture(2);
    input.memories[1].inputRefs = [view.refs[3]];
    input.memories[1].content += '重新生成';
    await synchronize(lib, input);
    input.messages[0].content = '不在该摘要输入内';
    let next = await capture(lib, (await synchronize(lib, input)).id);
    const selected = next.memories.find(m => m.hostId === 'leaf-1')!;
    expect((await statuses(lib, next)).get(selected.id)).toBe('valid');
    input.messages[3].content += '真正输入变化';
    next = await capture(lib, (await synchronize(lib, input)).id);
    const difference = await reviewDifference(lib, next, selected.id);
    expect(difference.kind).toBe('text');
    expect(difference.floor).toBe(3);
    expect(difference.explanation).toContain('具体输入来源');
    lib.close();
});

test('a manual keep cannot commit after the host guard changes', async () => {
    const { lib, view } = await fixture(1);
    await expect(keepSummary(lib, view, view.memories[0].id, () => false)).rejects.toThrow('视图已改变');
    expect(await lib.all('reviews')).toHaveLength(0);
    lib.close();
});
