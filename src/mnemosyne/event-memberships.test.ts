import { afterEach, expect, test, vi } from 'vitest';
import { fixture, observation } from './fixtures';
import { capture, synchronize } from './canonical';
import { eventView, editEvent, setEventArchived } from './events';
import { Transaction } from './db';
import { membershipProjection, parseFloorRanges, saveMemberships } from './event-memberships';
import { exportLibrary, restoreLibrary } from './migration';
afterEach(() => vi.restoreAllMocks());
const empty = { title: '合成事项', status: 'open', keywords: [] };

test('one atomic operation creates an empty-overview chain and joins a deduplicated batch without body reads', async () => {
  const { lib, view } = await fixture(4);
  const get = vi.spyOn(Transaction.prototype, 'get');
  const result = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id, view.memories[1].id, view.memories[0].id], eventIds: [], newTitle: '  归还玉佩  ' });
  expect(result).toMatchObject({ added: 2, removed: 0, already: 0 }); expect(result.created).toBeTruthy();
  expect(get.mock.calls.some(([store]) => store === 'source_bodies' || store === 'source_revisions')).toBe(false);
  const current = await capture(lib, view.branch.id), card = (await eventView(lib, current)).cards[0];
  expect(current.branch.epoch).toBe(view.branch.epoch + 1); expect(card.members).toHaveLength(2);
  expect(card.meta).toMatchObject({ title: '归还玉佩', overview: '', summarized: [], refs: [], latestProgress: null });
  expect(card.members.every(m => m.active && m.locked && m.origin === 'manual' && m.cutoff === view.cutoff)).toBe(true);
  expect(await lib.all('event_progress')).toHaveLength(0);
  lib.close();
});
test('single-summary replacement adds and removes multiple chains together; unaffected other summaries remain', async () => {
  const { lib, view } = await fixture(3);
  const a = await saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '甲链' });
  let next = await capture(lib, view.branch.id);
  const b = await editEvent(lib, next, null, { ...empty, title: '乙链' });
  next = await capture(lib, view.branch.id);
  const result = await saveMemberships(lib, next, { mode: 'replace', memories: [view.memories[0].id], eventIds: [b], newTitle: '丙链' });
  expect(result).toMatchObject({ added: 2, removed: 1 });
  const latest = await capture(lib, view.branch.id), cards = (await eventView(lib, latest)).cards;
  expect(latest.branch.epoch).toBe(next.branch.epoch + 1);
  expect(cards.find(c => c.chain.id === a.created)!.members).toHaveLength(2);
  expect(cards.find(c => c.chain.id === b)!.members[0].memory).toBe(view.memories[0].id);
  expect(cards.find(c => c.chain.id === result.created)!.members[0].memory).toBe(view.memories[0].id);
  lib.close();
});
test('repeat joins are no-op and do not create metadata/history churn', async () => {
  const { lib, view } = await fixture(2);
  const first = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '已存在' });
  const next = await capture(lib, view.branch.id), before = await exportLibrary(lib);
  expect(await saveMemberships(lib, next, { mode: 'add', memories: [view.memories[0].id], eventIds: [first.created!] })).toEqual({ added: 0, removed: 0, already: 1, created: null });
  expect((await exportLibrary(lib)).data).toEqual(before.data); lib.close();
});
test('cancellation at the final guard aborts every chain, membership and branch update', async () => {
  const { lib, view } = await fixture(4), before = await exportLibrary(lib);
  let calls = 0;
  await expect(saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '不应出现' }, () => ++calls === 1)).rejects.toThrow('未保存');
  expect((await exportLibrary(lib)).data).toEqual(before.data); lib.close();
});
test('stale previews and cross-branch target IDs are rejected without partial changes', async () => {
  const { lib, view } = await fixture(2);
  const first = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '原链' });
  await expect(saveMemberships(lib, view, { mode: 'add', memories: [view.memories[1].id], eventIds: [first.created!] })).rejects.toThrow('已改变');
  const other = await synchronize(lib, observation(1, 'other'));
  await expect(saveMemberships(lib, await capture(lib, other.id), { mode: 'add', memories: [(await capture(lib, other.id)).memories[0].id], eventIds: [first.created!] })).rejects.toThrow('不属于当前分支');
  expect(await lib.all('event_memberships')).toHaveLength(1); lib.close();
});
test('source-invalid summaries cannot join new chains but can unlink retained memberships', async () => {
  const { lib, view, input } = await fixture(2);
  const first = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '保留链' });
  input.messages[1].content += ' 新的事实变化'; await synchronize(lib, input);
  const next = await capture(lib, view.branch.id), data = await eventView(lib, next);
  expect(data.validity.get(next.memories[0].id)).toBe('needs_review');
  const badges = membershipProjection(next, data.cards);
  expect(badges.get(next.memories[0].hostId)).toEqual([expect.objectContaining({ id: first.created, needsReview: true })]);
  await expect(saveMemberships(lib, next, { mode: 'add', memories: [next.memories[0].id], eventIds: [], newTitle: '不许新增' })).rejects.toThrow('只能解除');
  expect((await saveMemberships(lib, next, { mode: 'replace', memories: [next.memories[0].id], eventIds: [] })).removed).toBe(1);
  expect((await eventView(lib, await capture(lib, view.branch.id))).cards[0].members).toHaveLength(0); lib.close();
});
test('family resolution and archived badges survive summary revisions; recall event tags are not memberships', async () => {
  const { lib, view, input } = await fixture(2);
  const first = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '原链' });
  await setEventArchived(lib, await capture(lib, view.branch.id), first.created!, true);
  input.memories[0].content += '手工修订';
  input.memories[1].tags = { version: 1, planIds: [], eventIds: [first.created!] };
  await synchronize(lib, input);
  const next = await capture(lib, view.branch.id), cards = (await eventView(lib, next)).cards;
  expect(next.memories[0].id).not.toBe(view.memories[0].id);
  const badges = membershipProjection(next, cards);
  expect(badges.get(next.memories[0].hostId)).toEqual([expect.objectContaining({ id: first.created, archived: true })]);
  expect(badges.has(next.memories[1].hostId)).toBe(false);
  expect((await saveMemberships(lib, next, { mode: 'add', memories: [next.memories[0].id], eventIds: [first.created!] })).already).toBe(1);
  expect(await lib.all('event_memberships')).toHaveLength(1); lib.close();
});
test('batch addition preserves memberships in other chains and rejects batch replacement/multiple targets', async () => {
  const { lib, view } = await fixture(2);
  const a = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '甲' });
  let next = await capture(lib, view.branch.id);
  const b = await editEvent(lib, next, null, { ...empty, title: '乙' }); next = await capture(lib, view.branch.id);
  await expect(saveMemberships(lib, next, { mode: 'replace', memories: next.memories.map(m => m.id), eventIds: [b] })).rejects.toThrow('一次只');
  await expect(saveMemberships(lib, next, { mode: 'add', memories: next.memories.map(m => m.id), eventIds: [a.created!, b] })).rejects.toThrow('一条目标链');
  await saveMemberships(lib, next, { mode: 'add', memories: next.memories.map(m => m.id), eventIds: [b] });
  const cards = (await eventView(lib, await capture(lib, view.branch.id))).cards;
  expect(cards.find(c => c.chain.id === a.created)!.members).toHaveLength(1);
  expect(cards.find(c => c.chain.id === b)!.members).toHaveLength(2); lib.close();
});
test('membership additions use existing package schema and survive full export/restore', async () => {
  const { lib, view } = await fixture(2);
  await saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '备份事件' });
  const pack = await exportLibrary(lib), restored = await restoreLibrary(pack, false);
  expect((await exportLibrary(restored)).data).toEqual(pack.data);
  expect((await eventView(restored, await capture(restored, view.branch.id))).cards[0].members).toHaveLength(2);
  restored.close(); lib.close();
});
test('floor ranges support separated ranges, Unicode commas and duplicates without inventing summary counts', () => {
  expect([...parseFloorRanges('100-102,180，#101、200 – 201', 210)!]).toEqual([100, 101, 102, 180, 200, 201]);
  expect(parseFloorRanges(' ', 210)).toBeNull();
  for (const input of ['150-100', '1,9999', 'word', '-1', '1.5', '1-2-3']) {
    expect(() => parseFloorRanges(input, 210)).toThrow();
  }
});
