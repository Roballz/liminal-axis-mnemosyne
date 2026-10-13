import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'vue/compiler-sfc';

const source = (path: string) => parse(readFileSync(new URL(path, import.meta.url), 'utf8')).descriptor;

test('event maintenance controls occupy a separate wrapping, left-aligned row', () => {
  const page = source('../pages/events/index.vue');
  const template = page.template!.content;
  const primary = template.split('class="mn-actions mn-event-primary-actions">')[1].split('</div>')[0];
  const maintenance = template.split('class="mn-actions mn-event-maintenance-actions">')[1].split('</div>')[0];
  expect(primary).toContain('新建事件');
  expect(primary).toContain('批量加入摘要');
  expect(primary).not.toContain('queueRefresh');
  expect(primary).not.toContain('previewResync');
  expect(maintenance).toContain('@click="queueRefresh"');
  expect(maintenance).toContain('@click="run(previewResync)"');
  const css = page.styles[0].content;
  expect(css).toMatch(/\.mn-event-toolbar \.mn-actions\s*\{[^}]*justify-content: flex-start;[^}]*flex-wrap: wrap;/);
});

test('single picker reserves list space without shrinking rows; card action has no extra inset', () => {
  const picker = source('./EventMembershipDialog.vue');
  expect(picker.template!.content).not.toContain('mn-membership-preview');
  const css = picker.styles[0].content;
  expect(css).toMatch(/\.mn-membership-dialog \.mn-dialog-body > \*\s*\{\s*flex-shrink: 0;/);
  expect(css).toMatch(/\.mn-membership-single \.mn-membership-chains\s*\{\s*flex: 1 0 180px;/);
  expect(css).toContain('92dvh');
  expect(source('./FloorPanel.vue').styles.map(style => style.content).join('\n')).toMatch(/\.bbs-fp-events\s*\{[^}]*margin-top: 8px; padding: 0;/);
});
