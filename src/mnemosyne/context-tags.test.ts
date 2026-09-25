import { expect, it } from 'vitest';
import { fixture } from './fixtures';
import { capture, synchronize, statuses, keepSummary } from './canonical';
import { commitManualEvent, eventPending } from './manual-events';
import { eventView, renderPersistentEvents, editEvent } from './events';
import { exportLibrary, restoreLibrary } from './migration';
import { normalizeTags } from '@/memory/contextTags';
import { parseManualEvent } from './event-response';

it('标签随摘要版本导出恢复，纯标签编辑不破坏上层总结和事件依赖，正文变化仍阻断注入', async () => {
  const { lib, input, branch } = await fixture(2);
  try {
    input.memories[1].storyTime = '2026/9/25 10:00 - 2026/9/25 10:30';
    input.memories.push({ hostId: 'higher', content: '两次玉佩交接', level: 1, anchorKey: null,
      children: input.memories.map(m => m.hostId), storyTime: '', seed: false, enabled: true });
    await synchronize(lib, input);
    let view = await capture(lib, branch.id);
    const sources = view.memories.filter(m => m.level === 0);
    const output = { title: '玉佩归还', status: 'open', keywords: ['玉佩'], overview: '找到线索，尚待归还。', progress: '确认主人。',
      latestProgress: { memory: sources[1].id, text: '已确认主人，等待归还'.padEnd(100, '续') } };
    await commitManualEvent(lib, view, null, sources.map(m => m.id), JSON.stringify(output), () => true);
    input.memories[0].tags = normalizeTags({ participants: ['甲'], public: { reason: '现场直播' } });
    await synchronize(lib, input);
    view = await capture(lib, branch.id);
    expect([...(await statuses(lib, view)).values()].every(s => s === 'valid')).toBe(true);
    let card = (await eventView(lib, view)).cards[0];
    expect(card.needsReview).toBe(false);
    expect(eventPending(card)).toBe(false);
    expect(card.members).toHaveLength(2);
    expect(card.meta.latestProgress?.time).toBe('2026/9/25 10:30');
    const text = renderPersistentEvents([card]);
    expect(text).toContain('进行中的事件链');
    expect(text).toContain(output.latestProgress.text);
    expect(text).not.toContain(output.overview);
    const pack = await exportLibrary(lib);
    expect(pack.version).toBe(7);
    const restored = await restoreLibrary(pack, false);
    try { expect((await exportLibrary(restored)).data).toEqual(pack.data); } finally { restored.close(); }

    input.messages[1].content = '被修改的正文，不再找到玉佩';
    input.memories[0].tags = normalizeTags({ participants: ['乙'] });
    await synchronize(lib, input);
    view = await capture(lib, branch.id);
    const changed = view.memories.find(m => m.hostId === input.memories[0].hostId)!;
    expect((await statuses(lib, view)).get(changed.id)).toBe('needs_review');
    card = (await eventView(lib, view)).cards[0];
    expect(card.blocked).toBe(true);
    expect(renderPersistentEvents([card])).toBe('');

    await keepSummary(lib, view, changed.id);
    input.memories[0].tags = normalizeTags({ participants: ['甲', '乙'] });
    await synchronize(lib, input);
    view = await capture(lib, branch.id);
    const retagged = view.memories.find(m => m.hostId === changed.hostId)!;
    expect((await statuses(lib, view)).get(retagged.id)).toBe('valid');
    input.messages[1].content = '再次修改，之前的审核不应放行';
    await synchronize(lib, input);
    view = await capture(lib, branch.id);
    expect((await statuses(lib, view)).get(retagged.id)).toBe('needs_review');
  } finally { lib.close(); }
});

it('事件常驻按进行中/暂搁分组，结束不注入，重复提及和改状态不刷新进展时间', async () => {
  const { lib, view, branch } = await fixture(1);
  try {
    const raw = JSON.stringify({ title: '寻找旧友', status: 'dormant', keywords: [], overview: '暂时中止寻找。', progress: '',
      latestProgress: { memory: view.memories[0].id, text: '线索中断' } });
    const id = await commitManualEvent(lib, view, null, [view.memories[0].id], raw, () => true);
    let current = await capture(lib, branch.id);
    let card = (await eventView(lib, current)).cards[0];
    expect(renderPersistentEvents([card])).toContain('暂搁的事件链');
    const latest = card.meta.latestProgress;
    await editEvent(lib, current, id, { ...card.meta, status: 'resolved' });
    current = await capture(lib, branch.id);
    card = (await eventView(lib, current)).cards[0];
    expect(card.meta.latestProgress).toEqual(latest);
    expect(renderPersistentEvents([card])).toBe('');
    expect(() => parseManualEvent(JSON.stringify({ ...JSON.parse(raw), latestProgress: { memory: view.memories[0].id, text: '长'.repeat(101) } }))).toThrow('100字');
    await expect(commitManualEvent(lib, current, card, [view.memories[0].id], JSON.stringify({ ...JSON.parse(raw), latestProgress: { memory: 'wrong', text: '伪进展' } }), () => true)).rejects.toThrow('本次事件材料');
  } finally { lib.close(); }
});

it('旧概要不因缺短进展而待更新，手改进展验证成员、时间和导出恢复', async () => {
  const { lib, input, branch } = await fixture(2);
  try {
    input.memories[0].storyTime = '2026/9/25 10:00 - 2026/9/25 10:30';
    await synchronize(lib, input);
    let view = await capture(lib, branch.id);
    const memory = view.memories[0].id, other = view.memories[1].id;
    const id = await editEvent(lib, view, null, { title: '旧事件', status: 'open', keywords: [], overview: '原有概要', summarized: [memory] }, { memory, active: true, kind: 'progress' });
    view = await capture(lib, branch.id);
    let card = (await eventView(lib, view)).cards[0];
    expect(card.meta.latestProgress).toBeUndefined();
    expect(eventPending(card)).toBe(false);
    const patch = { ...card.meta, latestProgress: { version: 1 as const, text: '2026/9/25 10:30 已确认归还时间'.padEnd(100, '续'), memory, time: '不可信时间' } };
    await expect(editEvent(lib, view, id, { ...patch, latestProgress: { ...patch.latestProgress, memory: other } })).rejects.toThrow('有效关联摘要');
    await expect(editEvent(lib, view, id, { ...patch, latestProgress: { ...patch.latestProgress, text: '长'.repeat(101) } })).rejects.toThrow('100字');
    await editEvent(lib, view, id, patch);
    view = await capture(lib, branch.id);
    card = (await eventView(lib, view)).cards[0];
    expect(card.meta.overview).toBe('原有概要');
    expect(card.meta.latestProgress).toEqual({ ...patch.latestProgress, time: '2026/9/25 10:30' });
    const text = renderPersistentEvents([card, { ...card, chain: { ...card.chain, id: 'ev_other' }, meta: { ...card.meta, title: '暂搁事件', status: 'dormant' } }]);
    expect(text).toContain('e1. [事件] 旧事件');
    expect(text).toContain('e2. [事件] 暂搁事件');
    expect(text).not.toContain(id);
    expect(text).not.toContain('ev_other');
    expect(text).toContain(patch.latestProgress.text);
    const restored = await restoreLibrary(await exportLibrary(lib), false);
    try { expect((await eventView(restored, await capture(restored, branch.id))).cards[0].meta.latestProgress).toEqual(card.meta.latestProgress); }
    finally { restored.close(); }
    await editEvent(lib, view, id, { ...card.meta, latestProgress: null });
    view = await capture(lib, branch.id);
    card = (await eventView(lib, view)).cards[0];
    expect(card.meta.latestProgress).toBeNull();
    expect(eventPending(card)).toBe(false);
    await editEvent(lib, view, id, card.meta, { memory: other, active: true, kind: 'progress' });
    card = (await eventView(lib, await capture(lib, branch.id))).cards[0];
    expect(eventPending(card)).toBe(true);
  } finally { lib.close(); }
});
