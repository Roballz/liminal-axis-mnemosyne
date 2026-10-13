import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'vue/compiler-sfc';

const source = (path: string) => parse(readFileSync(new URL(path, import.meta.url), 'utf8')).descriptor;

test('single picker reserves list space without shrinking rows; card action has no extra inset', () => {
  const picker = source('./EventMembershipDialog.vue');
  expect(picker.template!.content).not.toContain('mn-membership-preview');
  const css = picker.styles[0].content;
  expect(css).toMatch(/\.mn-membership-dialog \.mn-dialog-body > \*\s*\{\s*flex-shrink: 0;/);
  expect(css).toMatch(/\.mn-membership-single \.mn-membership-chains\s*\{\s*flex: 1 0 180px;/);
  expect(css).toContain('92dvh');
  expect(source('./FloorPanel.vue').styles.map(style => style.content).join('\n')).toMatch(/\.bbs-fp-events\s*\{[^}]*margin-top: 8px; padding: 0;/);
});
