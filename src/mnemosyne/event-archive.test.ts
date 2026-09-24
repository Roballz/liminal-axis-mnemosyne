import { test, expect } from 'vitest';
import { batchFixture, output, observation } from './fixtures';
import { capture, synchronize } from './canonical';
import { commitEventBatch, eventView, setEventArchived, wrapEvents, editEvent } from './events';
import { exportLibrary, restoreLibrary } from './migration';
import { fingerprint, type EventChain } from './model';

test('archive/unarchive only changes organization; recall and all event facts stay intact', async () => {
  const { lib, batch, branch } = await batchFixture(2);
  await commitEventBatch(lib, batch, output(batch));
  const view = await capture(lib, branch.id), before = (await eventView(lib, view)).cards;
  const id = before[0].chain.id, budget = { chains: 2, excerptChars: 500, totalChars: 1600, extra: 1 };
  const recalled = wrapEvents(before, view, [batch.memories[0].id], [], budget);
  expect(recalled).toContain('玉佩归还');
  await setEventArchived(lib, view, id, true);
  await setEventArchived(lib, view, id, true);
  const archived = (await eventView(lib, view)).cards;
  expect(archived[0].chain.archived).toBe(true);
  expect(archived[0].meta).toEqual(before[0].meta);
  expect(archived[0].members).toEqual(before[0].members);
  expect(archived[0].progress).toEqual(before[0].progress);
  expect((await capture(lib, branch.id)).branch.epoch).toBe(view.branch.epoch);
  expect(wrapEvents(archived, view, [batch.memories[0].id], [], budget)).toBe(recalled);
  await editEvent(lib, view, id, { ...archived[0].meta, title: '改名后仍归档' });
  const current = await capture(lib, branch.id);
  expect((await lib.get<EventChain>('event_chains', id))?.archived).toBe(true);
  await setEventArchived(lib, current, id, false);
  expect((await lib.get<EventChain>('event_chains', id))?.archived).toBe(false);
  expect((await eventView(lib, current)).cards[0].meta.title).toBe('改名后仍归档');
  lib.close();
});

test('archive rejects changed views, other branches and cancelled host scopes', async () => {
  const { lib, batch, branch } = await batchFixture(1);
  await commitEventBatch(lib, batch, output(batch));
  const view = await capture(lib, branch.id), card = (await eventView(lib, view)).cards[0];
  await expect(setEventArchived(lib, view, card.chain.id, true, () => false)).rejects.toThrow('已改变');
  const other = await synchronize(lib, observation(1, 'other-archive-chat'));
  await expect(setEventArchived(lib, await capture(lib, other.id), card.chain.id, true)).rejects.toThrow('已改变');
  await editEvent(lib, view, card.chain.id, { ...card.meta, title: '改过' });
  await expect(setEventArchived(lib, view, card.chain.id, true)).rejects.toThrow('已改变');
  expect((await lib.get<EventChain>('event_chains', card.chain.id))?.archived).toBeUndefined();
  lib.close();
});

test('v4 archive flags round-trip, old v3 is readable, invalid archive metadata is rejected', async () => {
  const { lib, batch, branch } = await batchFixture(1);
  await commitEventBatch(lib, batch, output(batch));
  const view = await capture(lib, branch.id), card = (await eventView(lib, view)).cards[0];
  await setEventArchived(lib, view, card.chain.id, true);
  const pack = await exportLibrary(lib);
  expect(pack.version).toBe(5);
  const restored = await restoreLibrary(pack, false);
  expect(restored.db.version).toBe(1);
  expect((await exportLibrary(restored)).data).toEqual(pack.data);
  expect((await eventView(restored, await capture(restored, branch.id))).cards[0].chain.archived).toBe(true);
  restored.close();
  for (const flag of [{ archiveSchema: 1, archived: 'true' }, { archiveSchema: 2, archived: true }, { archived: true }]) {
    const bad = structuredClone(pack), chain = bad.data.event_chains[0] as EventChain;
    delete chain.archiveSchema;
    delete chain.archived;
    Object.assign(chain, flag);
    await expect(restoreLibrary(bad, false)).rejects.toThrow('归档标记非法');
  }
  const legacy = structuredClone(pack);
  legacy.version = 3;
  for (const chain of legacy.data.event_chains as EventChain[]) {
    delete chain.archiveSchema;
    delete chain.archived;
  }
  const { checksum, ...base } = legacy;
  legacy.checksum = await fingerprint(base);
  const old = await restoreLibrary(legacy, false);
  expect((await eventView(old, await capture(old, branch.id))).cards[0].chain.archived).toBeUndefined();
  old.close();
  lib.close();
});
