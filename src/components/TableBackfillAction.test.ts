import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import type { TableDef } from '@/mnemosyne/model';
import type { TableBackfillReview } from '@/mnemosyne/table-backfill';

const mocks = vi.hoisted(() => ({
  lastFloors: vi.fn(), run: vi.fn(), stop: vi.fn(), save: vi.fn(),
  progress: { total: 1158, floors: {} as Record<string, number> },
}));
vi.mock('@/mnemosyne/bridge', () => ({ dailyBranch: async () => ({ id: 'branch' }), hostScope: () => 'chat', hostVersion: () => 'host' }));
vi.mock('@/mnemosyne/db', () => ({ activeLibrary: async () => ({}) }));
vi.mock('@/mnemosyne/jobs', () => ({ settings: { backfillBatchSize: 70 }, loadDailySettings: async () => {}, saveDailySettings: async () => {} }));
vi.mock('@/mnemosyne/table-backfill', async () => ({
  tableLastFloors: mocks.lastFloors, runTableBackfill: mocks.run, stopTableBackfill: mocks.stop,
  TABLE_BACKFILL_MAX_CHARS: 128000,
  backfillState: (await import('vue')).reactive({ busy: false, status: '', completed: 0, budget: null }),
}));
vi.mock('./ModalMask.vue', () => ({ default: Vue.defineComponent({ props: ['open'], setup: (p, { slots }) => () => p.open ? Vue.h('section', slots.default?.()) : null }) }));
vi.mock('./JsonResponseReview.vue', () => ({ default: Vue.defineComponent({
  props: ['review', 'busy', 'saveError'], emits: ['confirm', 'cancel'],
  setup: (p, { emit, slots }) => () => Vue.h('article', [
    Vue.h('p', p.saveError),
    Vue.h('section', slots.format?.()),
    Vue.h('button', { disabled: p.busy, onClick: () => emit('confirm', p.review.raw) }, '保存本批'),
    Vue.h('button', { disabled: p.busy, onClick: () => emit('cancel') }, '取消审阅'),
  ]),
}) }));
import Panel from './TableBackfillAction.vue';
import { backfillState, runTableBackfill, TABLE_BACKFILL_MAX_CHARS } from '@/mnemosyne/table-backfill';

// Run the actual parent template; native input directives record their model value in this renderer.
const descriptor = parse(readFileSync(new URL('./TableBackfillAction.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'backfill-action-test' }).bindings;
const template = compileTemplate({ source: descriptor.template!.content, filename: 'TableBackfillAction.vue', id: 'backfill-action-test', compilerOptions: { bindingMetadata: bindings } }).code;
const renderCode = template.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render');
const model = { mounted: (el: Node, binding: any) => { el.props.value = binding.value; }, updated: (el: Node, binding: any) => { el.props.value = binding.value; } };
(Panel as any).render = new Function('Vue', renderCode)({ ...Vue, vModelText: model, vModelCheckbox: model });
interface Node { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
const make = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] });
const renderer = Vue.createRenderer<Node, Node>({
  createElement: type => make(type), createText: text => make('text', text), createComment: text => make('comment', text),
  setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
  patchProp: (node, key, _, value) => { node.props[key] = value; },
  insert: (node, parent, anchor) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(i < 0 ? parent.children.length : i, 0, node);
  },
  remove: node => { const parent = node.parent; if (parent) parent.children.splice(parent.children.indexOf(node), 1); },
  parentNode: node => node.parent ?? null,
  nextSibling: node => { const siblings = node.parent?.children ?? []; return siblings[siblings.indexOf(node) + 1] ?? null; },
});
const nodes = (root: Node): Node[] => [root, ...root.children.flatMap(nodes)];
const text = (root: Node): string => (root.type === 'comment' ? '' : root.text) + root.children.map(text).join('');
const button = (root: Node, label: string) => nodes(root).find(n => n.type === 'button' && text(n) === label)!;
const numbers = (root: Node) => nodes(root).filter(n => n.type === 'input' && n.props.type === 'number');
const checkboxes = (root: Node) => nodes(root).filter(n => n.type === 'input' && n.props.type === 'checkbox');
const submit = (root: Node): Promise<void> => nodes(root).find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} });
const flush = async () => { await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick(); };
const apps: ReturnType<typeof renderer.createApp>[] = [];
const tables = ['a', 'b'].map(id => ({ id, name: `表${id.toUpperCase()}`, columns: [{ id: 'detail' }] })) as TableDef[];
async function mount() {
  const root = make('root'), app = renderer.createApp(Panel, { tables });
  app.provide(Vue.ssrContextKey, {}); app.mount(root); apps.push(app);
  await button(root, '批量补表').props.onClick(); await flush();
  for (const input of checkboxes(root)) input.props['onUpdate:modelValue'](true);
  await flush(); return root;
}
const budgetError = '补表完整材料超过预算，未发送；请减少每批楼数或可见表内容';

// Simulate the core's persistence callback boundary, then a preflight failure on the following batch.
async function reviewThenFail(...args: Parameters<typeof runTableBackfill>) {
  const [ranges, , , batchSize = 20, , reviewer, committed] = args;
  const start = ranges[0].start, end = Math.min(start + batchSize - 1, ranges[0].end);
  backfillState.busy = true;
  try {
    const draft: TableBackfillReview = {
      raw: '{}', title: `#${start} → #${end}`, tables: [], example: '{}', validate: () => '',
      async confirm() {
        await mocks.save();
        for (const r of ranges) mocks.progress.floors[r.table] = Math.max(mocks.progress.floors[r.table] ?? -1, end);
        committed?.({ tables: ranges.map(r => r.table), start, end, completed: 1 });
      },
    };
    if (!await reviewer!(draft)) return;
    backfillState.budget = { start: end + 1, end: end + batchSize, bodyChars: TABLE_BACKFILL_MAX_CHARS - 60000,
      tableChars: 60000, instructionChars: 1000, totalChars: TABLE_BACKFILL_MAX_CHARS + 1000, limitChars: TABLE_BACKFILL_MAX_CHARS };
    backfillState.status = budgetError;
    throw new Error(budgetError);
  } finally { backfillState.busy = false; }
}

beforeEach(() => {
  Object.assign(backfillState, { busy: false, status: '', completed: 0, budget: null });
  mocks.progress = { total: 1158, floors: {} };
  mocks.lastFloors.mockReset().mockImplementation(async () => structuredClone(mocks.progress));
  mocks.run.mockReset().mockImplementation(reviewThenFail);
  mocks.save.mockReset().mockResolvedValue(undefined); mocks.stop.mockReset();
});
afterEach(() => apps.splice(0).forEach(app => app.unmount()));

test('saved batches advance both tables before the next failure; retry keeps the remaining range, batch size and one budget error', async () => {
  const root = await mount();
  const pending = submit(root); await flush();
  expect(numbers(root).map(n => n.props.value)).toEqual([0, 1157, 70]);
  expect(mocks.save).not.toHaveBeenCalled();
  button(root, '保存本批').props.onClick(); await pending; await flush();
  expect(numbers(root).map(n => n.props.value)).toEqual([70, 1157, 70]);
  expect(text(root).split('最后确认：#69').length - 1).toBe(2);
  expect(text(root).split(budgetError).length - 1).toBe(1);
  for (const part of ['本批 #70 → #139', '正文（含格式）', '表格（定义与可见行）', '填写指令', '129,000 / 128,000', '超出 1,000 字符', '不自动拆批']) expect(text(root)).toContain(part);
  expect(mocks.lastFloors).toHaveBeenCalledOnce();
  mocks.run.mockRejectedValueOnce(new Error(budgetError));
  await submit(root); await flush();
  expect(mocks.run.mock.calls[1][0]).toEqual(tables.map(t => ({ table: t.id, start: 70, end: 1157 })));
  expect(mocks.run.mock.calls[1][1]).toBe(TABLE_BACKFILL_MAX_CHARS);
  expect(mocks.run.mock.calls[1][3]).toBe(70);
  expect(mocks.lastFloors).toHaveBeenCalledOnce();
  button(root, '取消').props.onClick(); await flush();
  await button(root, '批量补表').props.onClick(); await flush();
  expect(backfillState.budget).toBeNull(); expect(backfillState.status).toBe('');
  expect(text(root)).not.toContain(budgetError);
});

test('failed confirmation does not advance; manual historical refill then advances locally without replacing later confirmed floors', async () => {
  mocks.progress.floors = { a: 559, b: 699 };
  const root = await mount();
  numbers(root)[0].props['onUpdate:modelValue'](0); numbers(root)[0].props.onInput();
  numbers(root)[1].props['onUpdate:modelValue'](139); await flush();
  mocks.save.mockRejectedValueOnce(new Error('保存失败，尚未写入'));
  const pending = submit(root); await flush();
  button(root, '保存本批').props.onClick(); await flush();
  expect(numbers(root).map(n => n.props.value)).toEqual([0, 139, 70]);
  expect(text(root)).toContain('保存失败，尚未写入');
  button(root, '保存本批').props.onClick(); await pending; await flush();
  expect(numbers(root).map(n => n.props.value)).toEqual([70, 139, 70]);
  expect(text(root)).toContain('最后确认：#559'); expect(text(root)).toContain('最后确认：#699');
  expect(mocks.lastFloors).toHaveBeenCalledOnce();
  mocks.run.mockRejectedValueOnce(new Error(budgetError));
  await submit(root); await flush();
  expect(mocks.run.mock.calls[1][0]).toEqual(tables.map(t => ({ table: t.id, start: 70, end: 139 })));
});

test('cancelling an unconfirmed review preserves progress and does not pretend the batch was saved', async () => {
  const root = await mount(), pending = submit(root); await flush();
  expect(numbers(root)[0].props.value).toBe(0);
  button(root, '取消审阅').props.onClick(); await pending; await flush();
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.progress.floors).toEqual({});
  await button(root, '批量补表').props.onClick(); await flush();
  checkboxes(root)[0].props['onUpdate:modelValue'](true); await flush();
  expect(numbers(root)[0].props.value).toBe(0); expect(text(root)).toContain('最后确认：尚未更新');
});

test('large table previews are serialized once on first expansion, survive busy/error/budget rerenders, and reset for a new review', async () => {
  const oldValues = { detail: '旧批预览' + '文'.repeat(240000) };
  const oldReads = vi.fn(() => oldValues), newReads = vi.fn(() => ({ detail: '新批预览' }));
  const draft = (read: () => { detail: string }): TableBackfillReview => ({
    raw: '{}', title: '本批', example: '{}', validate: () => '', confirm: () => mocks.save(),
    tables: [{ def: tables[0], rows: [{ id: 'row-a', get values() { return read(); } }] }] as TableBackfillReview['tables'],
  });
  mocks.run.mockImplementation(async (...args: Parameters<typeof runTableBackfill>) => {
    backfillState.busy = true;
    try { if (await args[5]!(draft(oldReads))) await args[5]!(draft(newReads)); }
    finally { backfillState.busy = false; }
  });
  const root = await mount(), pending = submit(root); await flush();
  const details = () => nodes(root).find(n => n.type === 'details')!;
  expect(oldReads).not.toHaveBeenCalled(); expect(newReads).not.toHaveBeenCalled();
  details().props.onToggle({ currentTarget: { open: true } }); await flush();
  expect(oldReads).toHaveBeenCalledOnce(); expect(text(root)).toContain('旧批预览');
  let rejectSave!: (error: Error) => void;
  mocks.save.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectSave = reject; }));
  button(root, '保存本批').props.onClick(); await flush();
  expect(button(root, '保存本批').props.disabled).toBe(true);
  backfillState.budget = { start: 0, end: 69, bodyChars: 1000, tableChars: 240000, instructionChars: 1000, totalChars: 242000, limitChars: 270000 };
  await flush(); expect(oldReads).toHaveBeenCalledOnce();
  rejectSave(new Error('暂时保存失败')); await flush();
  expect(text(root)).toContain('暂时保存失败'); expect(oldReads).toHaveBeenCalledOnce();
  details().props.onToggle({ currentTarget: { open: false } }); await flush();
  details().props.onToggle({ currentTarget: { open: true } }); await flush();
  expect(oldReads).toHaveBeenCalledOnce();
  button(root, '保存本批').props.onClick(); await flush();
  expect(text(root)).not.toContain('旧批预览'); expect(newReads).not.toHaveBeenCalled();
  details().props.onToggle({ currentTarget: { open: true } }); await flush();
  expect(newReads).toHaveBeenCalledOnce(); expect(text(root)).toContain('新批预览');
  expect(oldReads).toHaveBeenCalledOnce();
  button(root, '取消审阅').props.onClick(); await pending;
  expect(mocks.save).toHaveBeenCalledTimes(2);
});
