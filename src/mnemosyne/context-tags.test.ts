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
      latestProgress: { memory: sources[1].id, text: '已确认主人，等待归还' } };
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
    expect(() => parseManualEvent(JSON.stringify({ ...JSON.parse(raw), latestProgress: { memory: view.memories[0].id, text: '长'.repeat(31) } }))).toThrow('30字');
    await expect(commitManualEvent(lib, current, card, [view.memories[0].id], JSON.stringify({ ...JSON.parse(raw), latestProgress: { memory: 'wrong', text: '伪进展' } }), () => true)).rejects.toThrow('本次事件材料');
  } finally { lib.close(); }
});
