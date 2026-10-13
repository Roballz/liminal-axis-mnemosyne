import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, compileTemplate } from 'vue/compiler-sfc';
import * as Vue from 'vue';

const page = parse(readFileSync(new URL('../pages/events/index.vue', import.meta.url), 'utf8')).descriptor;
const toolbar = page.template!.content.split('    <div class="mn-event-heading">')[1].split('    <p v-if="!archiveMode"')[0];
const code = compileTemplate({ source: '<div class="mn-event-heading">' + toolbar, filename: 'toolbar.vue', id: 'toolbar', compilerOptions: { bindingMetadata: { Icon: 'setup-const' as any } } }).code
  .replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`)
  .replace('export function render', 'return function render');
const render = new Function('Vue', code)(Vue);
const flatten = (node: any): any[] => !node || typeof node !== 'object' ? [] : [node, ...(Array.isArray(node.children) ? node.children.flatMap(flatten) : [])];
const text = (node: any): string => typeof node === 'string' ? node : typeof node?.children === 'string' ? node.children : (node?.children ?? []).map(text).join('');
const state = () => ({ archiveMode: false, view: { branch: { fork: 'parent' } } as any, busy: false, loading: false,
  jobState: { busy: false }, manualEventState: { busy: false }, membershipUi: { loading: false },
  queueRefresh: vi.fn(), previewResync: vi.fn(), run: vi.fn(), edit: vi.fn(), openMemberships: vi.fn(), showArchives: vi.fn(), stopDailyJob: vi.fn(), batch: vi.fn() });
function draw(ctx: ReturnType<typeof state>) {
  const nodes = flatten(render(ctx, [], {}, { Icon: 'svg' }, {}, {}));
  return { nodes, buttons: nodes.filter(n => n.type === 'button'), icon: (label: string) => nodes.find(n => n.type === 'button' && n.props?.['aria-label'] === label) };
}

test('heading holds three named icon-only controls; lower row has exactly three short actions', () => {
  const ctx = state(), { nodes, icon } = draw(ctx);
  const heading = nodes.find(n => n.props?.class === 'mn-event-heading');
  expect(flatten(heading).filter(n => n.type === 'button')).toHaveLength(3);
  for (const name of ['刷新', '重新继承', '新建事件']) {
    expect(icon(name).props.title).toBe(name);
    expect(icon(name).props.type).toBe('button');
    expect(text(icon(name)).trim()).toBe('');
  }
  const row = nodes.find(n => n.props?.class === 'mn-actions mn-event-toolbar');
  expect(flatten(row).filter(n => n.type === 'button').map(n => text(n).trim())).toEqual(['批量更新', '批量摘要', '归档事件']);
  expect(flatten(row).find(n => text(n) === '归档事件').props.class).toContain('mn-event-archive');
  icon('刷新').props.onClick(); icon('重新继承').props.onClick(); icon('新建事件').props.onClick();
  expect(ctx.queueRefresh).toHaveBeenCalledOnce(); expect(ctx.run).toHaveBeenCalledWith(ctx.previewResync); expect(ctx.edit).toHaveBeenCalledWith(null);
});

test('conditional re-inherit and the original disabled guards are preserved', () => {
  const ctx = state(); ctx.view = null;
  expect(draw(ctx).icon('重新继承')).toBeUndefined(); expect(draw(ctx).icon('新建事件').props.disabled).toBe(true);
  ctx.view = { branch: {} }; expect(draw(ctx).icon('重新继承')).toBeUndefined();
  ctx.view.branch.fork = 'parent';
  for (const flag of ['busy', 'loading'] as const) { ctx[flag] = true; expect(draw(ctx).icon('刷新').props.disabled).toBe(true); expect(draw(ctx).icon('重新继承').props.disabled).toBe(true); ctx[flag] = false; }
  ctx.manualEventState.busy = true; expect(draw(ctx).icon('重新继承').props.disabled).toBe(true); expect(draw(ctx).icon('新建事件').props.disabled).toBe(false);
  ctx.manualEventState.busy = false; ctx.jobState.busy = true;
  expect(draw(ctx).icon('重新继承').props.disabled).toBe(true); expect(draw(ctx).icon('新建事件').props.disabled).toBe(true);
  expect(draw(ctx).icon('刷新').props.disabled).toBe(false);
});

test('batch stop, summary guards, archive entry and return preserve existing actions', () => {
  const ctx = state(), button = (label: string) => draw(ctx).buttons.find(n => text(n).trim() === label)!;
  button('批量更新').props.onClick(); expect(ctx.run).toHaveBeenCalledWith(ctx.batch);
  ctx.jobState.busy = true; button('停止').props.onClick(); expect(ctx.stopDailyJob).toHaveBeenCalledOnce();
  ctx.jobState.busy = false; button('批量摘要').props.onClick(); expect(ctx.openMemberships).toHaveBeenCalledOnce();
  ctx.membershipUi.loading = true; expect(button('批量摘要').props.disabled).toBe(true);
  ctx.manualEventState.busy = true; expect(button('批量更新').props.disabled).toBe(true);
  button('归档事件').props.onClick(); expect(ctx.showArchives).toHaveBeenCalledWith(true);
  ctx.archiveMode = true; expect(button('归档事件')).toBeUndefined(); button('返回事件').props.onClick(); expect(ctx.showArchives).toHaveBeenCalledWith(false);
});

test('narrow-width CSS contract keeps three text columns and nonshrinking icons beside a wrapping title', () => {
  const css = page.styles[0].content;
  expect(css).toMatch(/\.mn-event-toolbar\s*\{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  expect(css).toMatch(/\.mn-event-toolbar button\s*\{[^}]*white-space: nowrap;[^}]*padding: 8px 6px;[^}]*font-size: 12px;/);
  expect(css).toMatch(/\.mn-event-heading h2\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  expect(css).toMatch(/\.mn-event-heading-actions\s*\{[^}]*flex: 0 0 auto;[^}]*margin-left: auto;/);
  expect(css).toMatch(/\.mn-page \.mn-event-icon\s*\{[^}]*flex: 0 0 36px;/);
  expect(css).toMatch(/\.mn-page \.mn-event-archive\s*\{[^}]*background: #2563eb;[^}]*color: #fff;/);
  // Source-level sizing budget, not browser measurement: 320px viewport less
  // 40px shell and 32px page padding gives 248px; four 12px CJK glyphs fit.
  const available = 320 - 40 - 32;
  expect((available - 2 * 8) / 3).toBeGreaterThanOrEqual(4 * 12 + 2 * 6 + 2);
  expect(available - (3 * 36 + 2 * 4) - 8).toBeGreaterThanOrEqual(4 * 20);
});
