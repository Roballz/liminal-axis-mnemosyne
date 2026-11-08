import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, compileTemplate } from 'vue/compiler-sfc';
import * as Vue from 'vue';
const page = parse(readFileSync(new URL('../pages/tables/index.vue', import.meta.url), 'utf8')).descriptor;
const source = page.template!.content.match(/<button v-if="injectionReason\(record\)"[\s\S]*?<\/button/ )![0] + '>';
const code = compileTemplate({ source, filename: 'badge.vue', id: 'badge' }).code
  .replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`)
  .replace('export function render', 'return function render');
const render = new Function('Vue', code)(Vue);
test('blocked badge opens the selected row without triggering the card click or long press', () => {
  const ctx = { record: { id: 'blocked' }, injectionReason: () => '来源失效', openRepair: vi.fn() };
  const node = render(ctx, []);
  expect(node.children).toBe('未注入待确认');
  const stopPropagation = vi.fn();
  node.props.onPointerdown({ stopPropagation });
  node.props.onClick({ stopPropagation });
  expect(stopPropagation).toHaveBeenCalledTimes(2);
  expect(ctx.openRepair).toHaveBeenCalledWith(ctx.record);
  ctx.injectionReason = () => '';
  expect(render(ctx, []).type).toBe(Vue.Comment);
});
