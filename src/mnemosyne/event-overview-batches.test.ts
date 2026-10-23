import { afterEach, test, expect, vi } from 'vitest';
import { fixture, output } from './fixtures';
import { capture, synchronize, type HostObservation } from './canonical';
import { eventView, editEvent, prepareEventBatch, commitEventBatch } from './events';
import { saveMemberships } from './event-memberships';
import { updateEventOverview, commitManualEvent, eventPending, eventCoverageUpgradeNeeded, parseManualEvent } from './manual-events';
import { estimateEventInputTokens } from './event-token-budget';
import { settings, dailySettingsDefaults } from './event-settings';
import { loadDailySettings, saveDailySettings } from './jobs';
import { buildEventInstruction } from './event-prompts';
import { activateLibrary, Transaction } from './db';
import { exportLibrary, restoreLibrary, validateData } from './migration';
import { fingerprint } from './model';
import type { ChatMsg } from '@/api/client';

const response = (overview = '合成累计概要', latestProgress: unknown = null) => JSON.stringify({
  title: '合成事件', status: 'open', keywords: [], overview, progress: '本次累计新增进展', latestProgress,
});
afterEach(() => { Object.assign(settings, dailySettingsDefaults); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function longChain(count = 80, size = 3000) {
  const data = await fixture(count) as Awaited<ReturnType<typeof fixture>> & { input: HostObservation };
  for (let i = 0; i < data.input.messages.length; i++) data.input.messages[i].content = `正文唯一标记${i}：` + '长'.repeat(size);
  for (let i = 0; i < data.input.memories.length; i++) {
    data.input.memories[i].inputRefs = data.view.refs.slice(0, (i + 1) * 2);
    data.input.memories[i].coverage = data.view.refs.slice(i * 2, i * 2 + 2);
  }
  // Rebind references after body changes so every synthetic summary is valid.
  const bodiesOnly = { ...data.input, memories: [] };
  await synchronize(data.lib, bodiesOnly);
  const bodyView = await capture(data.lib, data.branch.id);
  for (let i = 0; i < count; i++) {
    data.input.memories[i].inputRefs = bodyView.refs.slice(0, (i + 1) * 2);
    data.input.memories[i].coverage = bodyView.refs.slice(i * 2, i * 2 + 2);
  }
  await synchronize(data.lib, data.input);
  const view = await capture(data.lib, data.branch.id);
  const created = await saveMemberships(data.lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '合成长链' });
  return { ...data, view: await capture(data.lib, data.branch.id), id: created.created! };
}
const payload = (messages: ChatMsg[]) => JSON.parse(messages.at(-1)!.content);

test('over 200k characters use bounded sequential calls, rolling overview, exact coverage and no repeated raw sources', async () => {
  const { lib, branch, view, id } = await longChain();
  try {
    const seen = new Set<string>(), sourceIds = new Set<string>();
    let previous = '', calls = 0;
    const sender = vi.fn(async (messages: ChatMsg[]) => {
      const body = payload(messages);
      expect(estimateEventInputTokens(messages)).toBeLessThanOrEqual(80000);
      expect(body.overview).toBe(previous);
      expect(body.overviewRole).toBe(calls ? 'rolling' : 'rebuild_empty');
      expect(messages[1].content.indexOf('\"overview\"')).toBeLessThan(messages[1].content.indexOf('\"materials\"'));
      expect(messages[0].content).toContain('输出完整累计概要，不是只输出本批摘要');
      expect(body.batch).toBe(++calls);
      for (const m of body.materials) {
        expect(seen.has(m.id)).toBe(false); seen.add(m.id);
        for (const source of m.sources) { expect(sourceIds.has(source.revision)).toBe(false); sourceIds.add(source.revision); }
      }
      previous = `累计概要第${calls}批`;
      return response(previous, calls === 1 ? { memory: body.materials[0].id, text: '最初的关键进展' } : null);
    });
    await updateEventOverview(lib, view, id, 80000, sender);
    expect(calls).toBeGreaterThan(2); expect(calls).toBeLessThan(20);
    expect(seen.size).toBe(80); expect(sourceIds.size).toBe(160);
    const card = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    expect(new Set(card.meta.summarized)).toEqual(seen);
    expect(card.meta.latestProgress?.memory).toBe(view.memories[0].id);
    expect(card.meta.overview).toBe(previous); expect(eventPending(card)).toBe(false);
    expect(await lib.all('event_revisions')).toHaveLength(2);
    expect(await lib.all('event_progress')).toHaveLength(1);
    const pack = await exportLibrary(lib), restored = await restoreLibrary(pack, false);
    try { expect(eventPending((await eventView(restored, await capture(restored, branch.id))).cards[0])).toBe(false); }
    finally { restored.close(); }
  } finally { lib.close(); }
});

test('next incremental update sends only new summary and raw bodies, including overlapping old inputRefs', async () => {
  const { lib, branch, input, view } = await fixture(3);
  try {
    for (let i = 0; i < input.memories.length; i++) input.memories[i].inputRefs = view.refs.slice(0, (i + 1) * 2);
    await synchronize(lib, input);
    let current = await capture(lib, branch.id);
    const first = current.memories[0];
    const id = await commitManualEvent(lib, current, null, [first.id], response('旧已知核心'), () => true);
    current = await capture(lib, branch.id);
    await saveMemberships(lib, current, { mode: 'add', memories: current.memories.slice(1).map(m => m.id), eventIds: [id] });
    current = await capture(lib, branch.id);
    const sender = vi.fn(async (messages: ChatMsg[]) => {
      const body = payload(messages);
      expect(body.overview).toBe('旧已知核心'); expect(body.overviewRole).toBe('saved_verified'); expect(body.summarizedCount).toBe(1);
      expect(body.materials.map((m: any) => m.id)).toEqual(current.memories.slice(1).map(m => m.id));
      const sources = body.materials.flatMap((m: any) => m.sources.map((s: any) => s.revision));
      expect(sources).toHaveLength(4); expect(new Set(sources).size).toBe(4);
      expect(sources).not.toContain(current.refs[0].revision); expect(sources).not.toContain(current.refs[1].revision);
      return response();
    });
    await updateEventOverview(lib, current, id, 80000, sender);
    expect(sender).toHaveBeenCalledTimes(1);
  } finally { lib.close(); }
});

test.each(['failure', 'invalid', 'stop', 'edit', 'future-progress'] as const)('%s in a later batch leaves last saved overview and all pending members unchanged', async kind => {
  const { lib, branch, view, id } = await longChain(8, 3000);
  try {
    const before = await lib.all('event_revisions');
    let active = true, calls = 0;
    const sender = vi.fn(async (messages: ChatMsg[]) => {
      const body = payload(messages); calls++;
      if (calls === 2) {
        if (kind === 'failure') throw new Error('synthetic network error');
        if (kind === 'invalid') return '{"broken';
        if (kind === 'stop') active = false;
        if (kind === 'edit') await editEvent(lib, await capture(lib, branch.id), id, { title: '人工新标题', status: 'open', keywords: [] });
        if (kind === 'future-progress') return response('不能提前覆盖', { memory: view.memories.at(-1)!.id, text: '尚未提供的未来进展' });
      }
      return response(`累计${calls}`, { memory: body.materials[0].id, text: '本批进展' });
    });
    await expect(updateEventOverview(lib, view, id, 16000, sender, () => active)).rejects.toThrow();
    expect(calls).toBe(2);
    const after = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    expect(after.meta.overview).toBe(''); expect(after.meta.summarized).toEqual([]); expect(eventPending(after)).toBe(true);
    expect(await lib.all('event_revisions')).toHaveLength(before.length + (kind === 'edit' ? 1 : 0));
    expect(await lib.all('event_progress')).toHaveLength(0);
  } finally { lib.close(); }
});

test('oversized single complete member stops without sending or silently truncating', async () => {
  const { lib, view, id } = await longChain(1, 60000);
  try {
    const sender = vi.fn(async () => response());
    await expect(updateEventOverview(lib, view, id, 80000, sender)).rejects.toThrow('单条完整材料');
    expect(sender).not.toHaveBeenCalled(); expect(await lib.all('event_revisions')).toHaveLength(1);
  } finally { lib.close(); }
});

test.each(['changed', 'removed', 'legacy'] as const)('%s coverage rebuilds current members and never reuses stale overview', async kind => {
  const { lib, branch, view, input } = await fixture(2);
  try {
    const id = await commitManualEvent(lib, view, null, view.memories.map(m => m.id), response('旧待废弃概要'), () => true);
    let current = await capture(lib, branch.id);
    if (kind === 'changed') {
      input.memories[0] = { ...input.memories[0], content: '已更正的新事实', manualEdit: true, generationKey: 2 };
      await synchronize(lib, input); current = await capture(lib, branch.id);
    } else if (kind === 'removed') {
      const card = (await eventView(lib, current)).cards[0];
      await editEvent(lib, current, id, card.meta, { memory: current.memories[0].id, active: false, kind: 'progress' });
      current = await capture(lib, branch.id);
    } else {
      const revision = (await lib.all<any>('event_revisions'))[0];
      delete revision.eventSchema; delete revision.overview; delete revision.summarized;
      await lib.transaction(['event_revisions'], 'readwrite', tx => tx.put('event_revisions', revision));
      // Make a pending member without upgrading the historical coverage receipt.
      const card = (await eventView(lib, current)).cards[0];
      await editEvent(lib, current, id, { ...card.meta, summarized: [view.memories[0].id] });
      current = await capture(lib, branch.id);
    }
    const members = (await eventView(lib, current)).cards[0].members.map(m => m.memory);
    const sender = vi.fn(async (messages: ChatMsg[]) => {
      const body = payload(messages);
      expect(body.overview).toBe(''); expect(body.materials.map((m: any) => m.id)).toEqual(members);
      return response('当前有效核心');
    });
    await updateEventOverview(lib, current, id, 80000, sender);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(eventPending((await eventView(lib, await capture(lib, branch.id))).cards[0])).toBe(false);
  } finally { lib.close(); }
});

test('settings default/migration, Unicode limit and backup roundtrip preserve old text without truncation', async () => {
  const { lib } = await fixture(1);
  let restored: typeof lib | undefined;
  try {
    vi.stubGlobal('localStorage', { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() });
    await activateLibrary(lib);
    Object.assign(settings, dailySettingsDefaults);
    expect(settings.overviewMaxChars).toBe(1000); expect(settings.overviewBatchTokens).toBe(80000);
    const atLimit = '字'.repeat(999) + '🌸';
    expect(parseManualEvent(response(atLimit)).overview).toBe(atLimit);
    expect(() => parseManualEvent(response(atLimit + '超'))).toThrow('1000字');
    settings.overviewMaxChars = 1200; settings.overviewBatchTokens = 90000; settings.overviewMaterialMode = 'summary';
    expect(buildEventInstruction()).toContain('不超过600字');
    expect(buildEventInstruction(21)).toContain('不超过900字');
    expect(buildEventInstruction(41)).toContain('不超过1200字');
    expect(buildEventInstruction(61)).toContain('不超过1500字');
    await saveDailySettings();
    const pack = await exportLibrary(lib); expect(pack.version).toBe(14);
    restored = await restoreLibrary(pack, false); await activateLibrary(restored);
    settings.overviewMaxChars = 1; await loadDailySettings();
    expect(settings.overviewMaxChars).toBe(1200); expect(settings.overviewBatchTokens).toBe(90000); expect(settings.overviewMaterialMode).toBe('summary');
    const malformed = structuredClone(pack) as any;
    malformed.data.library_meta.find((r: any) => r.id === 'daily-settings').value.overviewMaxChars = 1.5;
    expect(() => validateData(malformed)).toThrow('事件概要设置');
    const badMode = structuredClone(pack) as any;
    badMode.data.library_meta.find((r: any) => r.id === 'daily-settings').value.overviewMaterialMode = 'arbitrary-secret-string';
    expect(() => validateData(badMode)).toThrow('设置白名单');
    const old = structuredClone(pack) as any; old.version = 13;
    const oldSettings = old.data.library_meta.find((r: any) => r.id === 'daily-settings').value;
    delete oldSettings.overviewMaxChars; delete oldSettings.overviewBatchTokens; delete oldSettings.overviewMaterialMode;
    const { checksum: _, ...base } = old; old.checksum = await fingerprint(base);
    const legacy = await restoreLibrary(old, false);
    try { await activateLibrary(legacy); await loadDailySettings(); expect(settings.overviewMaxChars).toBe(1000); expect(settings.overviewBatchTokens).toBe(80000); expect(settings.overviewMaterialMode).toBe('both'); }
    finally { legacy.close(); }
    settings.overviewMaxChars = 0; await expect(saveDailySettings()).rejects.toThrow('事件概要上限');
  } finally { lib.close(); restored?.close(); }
});


test('legacy progress with equal refs and synthesized summarized IDs gains no coverage marker through ordinary joins', async () => {
  const { lib, branch, view } = await fixture(3);
  try {
    const batch = (await prepareEventBatch(lib, view, 2, 80000))!;
    await commitEventBatch(lib, batch, output(batch));
    let current = await capture(lib, branch.id);
    let card = (await eventView(lib, current)).cards[0];
    expect(new Set(card.meta.refs)).toEqual(new Set(card.meta.summarized));
    expect(card.meta.overviewCoverage).toBeUndefined();
    await editEvent(lib, current, card.chain.id, card.meta, { memory: current.memories[2].id, active: true, kind: 'progress' });
    current = await capture(lib, branch.id); card = (await eventView(lib, current)).cards[0];
    expect(card.meta.eventSchema).toBe(2); expect(card.meta.overviewCoverage).toBeUndefined();
    const sender = vi.fn(async (messages: ChatMsg[]) => {
      expect(payload(messages).overview).toBe('');
      expect(payload(messages).materials).toHaveLength(3);
      return response();
    });
    await updateEventOverview(lib, current, card.chain.id, 80000, sender);
    const after = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    expect(after.meta.overviewCoverage).toBe(1); expect(after.meta.summarized).toHaveLength(3);
  } finally { lib.close(); }
});


test('rebuilding after unlinking the latest-progress source clears the old reference', async () => {
  const { lib, branch, view } = await fixture(2);
  try {
    const source = view.memories[0];
    const id = await commitManualEvent(lib, view, null, view.memories.map(m => m.id),
      response('旧包含已删除成员的概要', { memory: source.id, text: '旧来源进展' }), () => true);
    let current = await capture(lib, branch.id), card = (await eventView(lib, current)).cards[0];
    await editEvent(lib, current, id, card.meta, { memory: source.id, active: false, kind: 'progress' });
    current = await capture(lib, branch.id);
    await updateEventOverview(lib, current, id, 80000, async messages => {
      expect(payload(messages).latestProgress).toBeNull(); expect(payload(messages).overview).toBe('');
      return response('只依据剩余成员');
    });
    card = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    expect(card.meta.latestProgress).toBeNull(); expect(card.meta.summarized).toEqual([view.memories[1].id]);
  } finally { lib.close(); }
});


test('fully summarized old chains are eligible for the existing update button without requiring a new member', async () => {
  const { lib, branch, view } = await fixture(2);
  try {
    const id = await commitManualEvent(lib, view, null, view.memories.map(m => m.id), response('旧版完整概要'), () => true);
    const revision = (await lib.all<any>('event_revisions'))[0]; delete revision.overviewCoverage;
    await lib.transaction(['event_revisions'], 'readwrite', tx => tx.put('event_revisions', revision));
    const current = await capture(lib, branch.id), before = (await eventView(lib, current)).cards[0];
    expect(eventPending(before)).toBe(false); expect(eventCoverageUpgradeNeeded(before)).toBe(true); expect(before.meta.overview).toBe('旧版完整概要');
    const sender = vi.fn(async (messages: ChatMsg[]) => { expect(payload(messages).materials).toHaveLength(2); return response(); });
    expect(await updateEventOverview(lib, current, id, 80000, sender)).toBe(false);
    expect(sender).not.toHaveBeenCalled();
    await updateEventOverview(lib, current, id, 80000, sender, () => true, true);
    const after = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    expect(after.chain.id).toBe(id); expect(after.members).toEqual(before.members); expect(eventPending(after)).toBe(false);
    expect(await lib.all('event_chains')).toHaveLength(1);
  } finally { lib.close(); }
});

test('echoing inherited latest progress through multiple batches preserves its original plot time', async () => {
  const { lib, branch, view, input, id } = await longChain(6, 3000);
  try {
    const initial = view.memories[0];
    let card = (await eventView(lib, view)).cards[0];
    await editEvent(lib, view, id, { ...card.meta, latestProgress: { version: 1, memory: initial.id, text: '旧进展', time: '' } });
    let current = await capture(lib, branch.id); card = (await eventView(lib, current)).cards[0];
    const originalTime = card.meta.latestProgress!.time;
    input.memories[0] = { ...input.memories[0], storyTime: '2099/01/01 20:00', generationKey: 2, manualEdit: true };
    await synchronize(lib, input); current = await capture(lib, branch.id);
    let calls = 0;
    const sender = vi.fn(async (messages: ChatMsg[]) => {
      const body = payload(messages); calls++;
      expect(body.latestProgress.time).toBe(originalTime);
      return response('累计有效概要', body.latestProgress);
    });
    await updateEventOverview(lib, current, id, 16000, sender);
    expect(calls).toBeGreaterThan(1);
    card = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    expect(card.meta.latestProgress?.time).toBe(originalTime);
  } finally { lib.close(); }
});

test.each(['summary', 'body', 'both'] as const)('%s mode sends only selected text with IDs, source identity and original plot time', async mode => {
  const { lib, branch, input, view } = await fixture(2);
  try {
    input.memories[0].content = 'SUMMARY_SENTINEL_ONLY'; input.memories[0].storyTime = '2088/01/02 10:00 - 2088/01/02 11:00';
    input.messages[1].content = 'BODY_SENTINEL_ONLY';
    await synchronize(lib, { ...input, memories: [] });
    const bodyView = await capture(lib, branch.id);
    input.memories[0].inputRefs = bodyView.refs.slice(0, 2); input.memories[0].coverage = bodyView.refs.slice(0, 2);
    await synchronize(lib, input); let current = await capture(lib, branch.id);
    const memory = current.memories[0];
    const result = await saveMemberships(lib, current, { mode: 'add', memories: [memory.id], eventIds: [], newTitle: '材料选择' });
    current = await capture(lib, branch.id); settings.overviewMaterialMode = mode;
    await updateEventOverview(lib, current, result.created!, 80000, async messages => {
      const full = JSON.stringify(messages), material = payload(messages).materials[0];
      expect(full.includes('SUMMARY_SENTINEL_ONLY')).toBe(mode !== 'body');
      expect(full.includes('BODY_SENTINEL_ONLY')).toBe(mode !== 'summary');
      expect(material.id).toBe(memory.id); expect(material.storyTime).toBe(input.memories[0].storyTime);
      expect(material.sources[0].message).toBe(bodyView.refs[0].message);
      expect(material.sources[0].revision).toBe(bodyView.refs[0].revision);
      expect('summary' in material).toBe(mode !== 'body'); expect('body' in material.sources[0]).toBe(mode !== 'summary');
      // Mid-request setting changes must not change this operation's saved receipt.
      settings.overviewMaterialMode = mode === 'summary' ? 'body' : 'summary';
      return response();
    });
    const after = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    expect(after.meta.overviewMaterialMode).toBe(mode); expect(eventCoverageUpgradeNeeded(after)).toBe(true);
  } finally { lib.close(); }
});

test('selected text controls batching: summary-only fits where selected huge body does not', async () => {
  const { lib, view, id } = await longChain(1, 60000);
  try {
    settings.overviewMaterialMode = 'body';
    const sender = vi.fn(async () => response());
    await expect(updateEventOverview(lib, view, id, 80000, sender)).rejects.toThrow('单条完整材料');
    expect(sender).not.toHaveBeenCalled();
    settings.overviewMaterialMode = 'summary';
    await updateEventOverview(lib, view, id, 80000, sender); expect(sender).toHaveBeenCalledTimes(1);
  } finally { lib.close(); }
});

test('changing material modes rebuilds existing coverage on explicit update without carrying old mode text', async () => {
  const { lib, view, branch } = await fixture(2);
  try {
    settings.overviewMaterialMode = 'summary';
    const id = await commitManualEvent(lib, view, null, view.memories.map(m => m.id), response('OLD_MODE_OVERVIEW_SENTINEL'), () => true);
    const current = await capture(lib, branch.id), card = (await eventView(lib, current)).cards[0];
    settings.overviewMaterialMode = 'body';
    expect(eventPending(card)).toBe(false); expect(eventCoverageUpgradeNeeded(card)).toBe(true);
    const sender = vi.fn(async messages => {
      expect(payload(messages).materials).toHaveLength(2);
      expect(JSON.stringify(messages)).not.toContain('OLD_MODE_OVERVIEW_SENTINEL');
      expect(payload(messages).materials.every((m: any) => !('summary' in m))).toBe(true);
      return response();
    });
    expect(await updateEventOverview(lib, current, id, 80000, sender)).toBe(false);
    await updateEventOverview(lib, current, id, 80000, sender, () => true, true);
    expect(sender).toHaveBeenCalledTimes(1);
  } finally { lib.close(); }
});

test.each(['body', 'both'] as const)('%s mode rejects missing/empty selected body rather than silently falling back to summary', async mode => {
  const { lib, view, branch } = await fixture(1);
  try {
    const result = await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '缺正文' });
    const current = await capture(lib, branch.id);
    for (const [id, source] of current.sources) current.sources.set(id, { ...source, content: '' });
    settings.overviewMaterialMode = mode;
    const sender = vi.fn(async () => response());
    await expect(updateEventOverview(lib, current, result.created!, 80000, sender)).rejects.toThrow('正文缺失或清洗后为空');
    expect(sender).not.toHaveBeenCalled();
    settings.overviewMaterialMode = 'summary';
    await updateEventOverview(lib, current, result.created!, 80000, sender); expect(sender).toHaveBeenCalledTimes(1);
  } finally { lib.close(); }
});


test('mode-change rebuild cannot restore an old-mode latest-progress sentinel after null output', async () => {
  const { lib, view, branch } = await fixture(2);
  try {
    settings.overviewMaterialMode = 'summary';
    const id = await commitManualEvent(lib, view, null, [view.memories[0].id],
      response('旧概要', { memory: view.memories[0].id, text: 'OLD_MODE_PROGRESS_SENTINEL' }), () => true);
    let current = await capture(lib, branch.id);
    settings.overviewMaterialMode = 'body';
    await updateEventOverview(lib, current, id, 80000, async messages => {
      expect(JSON.stringify(messages)).not.toContain('OLD_MODE_PROGRESS_SENTINEL');
      return response();
    }, () => true, true);
    current = await capture(lib, branch.id);
    expect((await eventView(lib, current)).cards[0].meta.latestProgress).toBeNull();
    await saveMemberships(lib, current, { mode: 'add', memories: [current.memories[1].id], eventIds: [id] });
    current = await capture(lib, branch.id);
    await updateEventOverview(lib, current, id, 80000, async messages => {
      expect(JSON.stringify(messages)).not.toContain('OLD_MODE_PROGRESS_SENTINEL'); return response();
    });
  } finally { lib.close(); }
});


test('preparation uses cheap cancellation checks and one captured validity pass, not full host checks per member', async () => {
  const { lib, view, id } = await longChain(12, 3000);
  const reads = vi.spyOn(Transaction.prototype, 'all'), guard = vi.fn(() => true), preparationGuard = vi.fn(() => true);
  try {
    const sender = vi.fn(async () => response());
    await updateEventOverview(lib, view, id, 80000, sender, guard, false, preparationGuard);
    expect(preparationGuard.mock.calls.length).toBeGreaterThan(1);
    expect(guard).toHaveBeenCalledTimes(sender.mock.calls.length * 2 + 2);
    // One validation in target projection, one at commit. Dependency evaluation stays complete.
    expect(reads.mock.calls.filter(([store]) => store === 'reviews')).toHaveLength(2);
  } finally { reads.mockRestore(); lib.close(); }
});
