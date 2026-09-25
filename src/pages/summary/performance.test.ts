import { afterEach, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SummaryPage from './index.vue';
import { memory, recomputeDerived } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import * as context from '@/st/context';
import * as bridge from '@/mnemosyne/bridge';

// This test exercises actual Vue card rendering, not browser layout/scrolling.
vi.mock('@/components/SummaryReviewPanel.vue', () => ({ default: { render: () => null } }));
afterEach(() => { vi.restoreAllMocks(); Object.assign(memory, createEmptyMemory()); });
it('240张摘要共享一次目录校验，首屏有界，折叠总结不挂载隐藏标签卡', async () => {
  const count = 240;
  const chat = Array.from({ length: count }, (_, i) => ({ name: '合成角色', is_user: false, is_system: false,
    mes: `合成剧情${i}。` + '正文只用于测量本地序列化。'.repeat(200), extra: { bbs_leaf: {
      id: `perf-${i}`, text: `合成摘要${i}`, delta: {}, v: 1 as const, swipe: 0, createdAt: i,
      tags: { version: 1 as const, planIds: [], eventIds: ['ev_perf'] },
    } },
  }));
  vi.spyOn(context, 'getContext').mockReturnValue({ chat, chatMetadata: {}, getCurrentChatId: () => 'synthetic-perf' } as any);
  Object.assign(memory, createEmptyMemory());
  recomputeDerived();
  const hints = vi.spyOn(bridge, 'currentEventHints').mockImplementation(() => {
    bridge.hostVersion(); // Same full-host serialization as a validated real cache read.
    return [{ id: 'ev_perf', title: '合成事件', status: 'open' }];
  });
  const start = performance.now();
  const html = await renderToString(createSSRApp(SummaryPage));
  console.info(`synthetic-summary-render: ${Math.round(performance.now() - start)}ms, directory reads=${hints.mock.calls.length}`);
  expect(hints).toHaveBeenCalledTimes(1);
  expect(html.match(/class="bbs-tags-top"/g)).toHaveLength(40);
  expect(html).toContain('显示更多');
  hints.mockClear();
  memory.summaries = [{ id: 'compressed', level: 1, text: '合成压缩总结', childIds: chat.map(m => m.extra.bbs_leaf.id), createdAt: count, auto: false }];
  const collapsed = await renderToString(createSSRApp(SummaryPage));
  expect(collapsed).toContain('展开下层 240 条');
  expect(collapsed).not.toContain('bbs-tags-top');
  expect(hints).not.toHaveBeenCalled();
});
