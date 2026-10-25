import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, ssrContextKey } from 'vue';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
const state = vi.hoisted(() => ({ commit: vi.fn(), closeBook: vi.fn() }));
vi.mock('@/state/ui', () => ({ closeBook: state.closeBook }));
vi.mock('@/mnemosyne/event-membership-ui', async () => {
  const { shallowRef, reactive } = await import('vue');
  const membershipSession = shallowRef<any>(null), membershipSelected = shallowRef(new Set<string>()), membershipPicking = shallowRef(false);
  return { membershipSession, membershipSelected, membershipPicking, membershipUi: reactive({ saving: false, error: '' }),
    closeMemberships: () => { membershipSession.value = null; membershipPicking.value = false; },
    toggleMembershipRow: (id: string) => { const next = new Set(membershipSelected.value); next.has(id) ? next.delete(id) : next.add(id); membershipSelected.value = next; },
    commitMembershipSelection: state.commit };
});
vi.mock('./ModalMask.vue', () => ({ default: defineComponent({ props: ['open'], setup: (p, { slots }) => () => p.open ? h('section', slots.default?.()) : null }) }));
import Panel from './EventMembershipDialog.vue';
import { membershipSession, membershipSelected, membershipPicking } from '@/mnemosyne/event-membership-ui';
const descriptor = parse(readFileSync(new URL('./EventMembershipDialog.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'membership-test' }).bindings;
const template = compileTemplate({ source: descriptor.template!.content, filename: 'EventMembershipDialog.vue', id: 'membership-test', compilerOptions: { bindingMetadata: bindings } }).code;
const renderCode = template.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render');
(Panel as any).render = new Function('Vue', renderCode)({ ...Vue, vModelText: {} });
interface Node { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node; focus: () => void; isConnected: boolean; getRootNode: () => any; querySelectorAll: () => Node[] }
let active: Node | null = null;
const nodes = (root: Node): Node[] => [root, ...root.children.flatMap(nodes)];
const content = (node: Node): string => node.text + node.children.map(content).join('');
const make = (type: string, text = ''): Node => {
  const node: Node = { type, text, props: {}, children: [], isConnected: true, focus: () => { active = node; },
    getRootNode: () => ({ activeElement: active }), querySelectorAll: () => nodes(node).filter(n => ['button', 'input', 'textarea'].includes(n.type) && !n.props.disabled) };
  return Vue.markRaw(node);
};
const renderer = createRenderer<Node, Node>({ createElement: type => make(type), createText: text => make('text', text), createComment: text => make('comment', text),
  setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; }, patchProp: (node, key, _, value) => { node.props[key] = value; },
  insert: (node, parent, anchor) => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(i < 0 ? parent.children.length : i, 0, node); },
  remove: node => { node.isConnected = false; const p = node.parent; if (p) p.children.splice(p.children.indexOf(node), 1); }, parentNode: node => node.parent ?? null,
  nextSibling: node => { const siblings = node.parent?.children ?? []; return siblings[siblings.indexOf(node) + 1] ?? null; } });
const findButton = (root: Node, label: string) => nodes(root).find(n => n.type === 'button' && content(n) === label)!;
const field = (root: Node, label: string) => nodes(root).find(n => n.type === 'input' && n.props['aria-label'] === label)!;
async function flush() { await nextTick(); await nextTick(); }
function session(mode: 'single' | 'bulk' = 'bulk') { return { mode, floor: mode === 'single' ? 1 : undefined, target: 'event-0', view: { refs: Array(200).fill({}) },
  rows: Array.from({ length: mode === 'single' ? 1 : 55 }, (_, i) => ({ id: `m-${i}`, hostId: `leaf-${i}`, floor: i * 2 + 1, text: i % 3 ? '调查合成摘要' : '灯会合成摘要', time: '', valid: true })),
  cards: Array.from({ length: 25 }, (_, i) => ({ chain: { id: `event-${i}` }, meta: { title: `事件 ${i}` }, members: i === 0 ? [{ memory: 'm-0' }] : [] })) } as any; }
function mount() { const root = make('root'), app = renderer.createApp(Panel); app.provide(ssrContextKey, {}); app.mount(root); return { root, app }; }
beforeEach(() => { membershipSession.value = null; membershipPicking.value = false; membershipSelected.value = new Set(); active = null; state.commit.mockReset(); });
afterEach(() => { membershipSession.value = null; vi.restoreAllMocks(); });
test('rendered bulk picker mounts only 20 rows, retains selection across row/chain pages and filters', async () => {
  const { root, app } = mount(); membershipSession.value = session(); await flush();
  const rows = () => nodes(root).filter(n => n.type === 'input' && n.props.type === 'checkbox');
  expect(rows()).toHaveLength(20);
  findButton(root, '选择本页').props.onClick(); await flush(); expect(membershipSelected.value.size).toBe(20);
  findButton(root, '下一页摘要').props.onClick(); await flush(); rows()[0].props.onChange(); await flush();
  expect(membershipSelected.value.size).toBe(21);
  field(root, '楼层范围').props['onUpdate:modelValue']('1-9,21'); field(root, '摘要关键词').props['onUpdate:modelValue']('灯会'); await flush();
  expect(rows()).toHaveLength(2); expect(membershipSelected.value.size).toBe(21);
  findButton(root, '清空选择').props.onClick(); findButton(root, '选择全部筛选结果').props.onClick(); await flush(); expect(membershipSelected.value.size).toBe(2);
  findButton(root, '下一页事件链').props.onClick(); await flush();
  const form = nodes(root).find(n => n.type === 'form')!; await form.props.onSubmit({ preventDefault() {} });
  expect(state.commit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'add', eventIds: ['event-0'], memories: ['m-0', 'm-3'] }));
  app.unmount();
});
test('chat-card pick return refocuses the remounted form, retains filters and restores Escape/Tab handling', async () => {
  const { root, app } = mount(); membershipSession.value = session(); await flush();
  field(root, '楼层范围').props['onUpdate:modelValue']('1-9'); findButton(root, '选择本页').props.onClick(); await flush();
  const chosen = [...membershipSelected.value];
  findButton(root, '从聊天摘要卡勾选').props.onClick(); await flush(); expect(nodes(root).some(n => n.type === 'form')).toBe(false);
  findButton(root, '选择目标链').props.onClick(); await flush();
  const form = nodes(root).find(n => n.type === 'form')!; expect(active).toBe(form); expect([...membershipSelected.value]).toEqual(chosen);
  expect(nodes(root).filter(n => n.type === 'input' && n.props.type === 'checkbox')).toHaveLength(5);
  const preventDefault = vi.fn(), stopPropagation = vi.fn(); form.props.onKeydown({ key: 'Tab', preventDefault, stopPropagation });
  expect(preventDefault).toHaveBeenCalled(); expect(active?.type).toBe('button');
  form.props.onKeydown({ key: 'Escape', preventDefault, stopPropagation }); await flush(); expect(membershipSession.value).toBeNull();
  app.unmount();
});
test('single-card create/remove stays a draft until save; popup contains no immediate AI action', async () => {
  const { root, app } = mount(); membershipSession.value = session('single'); await flush();
  expect(content(root)).not.toContain('灯会合成摘要');
  expect(nodes(root).find(n => n.type === 'form')!.props.class).toContain('mn-membership-single');
  expect(nodes(root).filter(n => n.type === 'input' && n.props.type === 'checkbox')).toHaveLength(20);
  expect(content(root)).not.toContain('立即更新'); expect(content(root)).not.toContain('确认调用');
  nodes(root).find(n => n.type === 'input' && n.props.type === 'checkbox')!.props.onChange(); await flush();
  findButton(root, '新建事件链').props.onClick(); await flush(); field(root, '新事件链名称').props['onUpdate:modelValue']('新建测试'); await flush();
  expect(content(root)).toContain('新增 1 条关联'); expect(content(root)).toContain('移除 1 条关联'); expect(state.commit).not.toHaveBeenCalled();
  findButton(root, '取消').props.onClick(); await flush(); expect(state.commit).not.toHaveBeenCalled(); app.unmount();
});

test('single-card filters retain selection and close/reopen resets unsaved changes', async () => {
  const { root, app } = mount(); membershipSession.value = session('single'); await flush();
  nodes(root).filter(n => n.type === 'input' && n.props.type === 'checkbox')[1].props.onChange(); await flush();
  field(root, '查找事件链').props['onUpdate:modelValue']('事件 24'); await flush();
  expect(nodes(root).filter(n => n.type === 'input' && n.props.type === 'checkbox')).toHaveLength(1);
  const form = nodes(root).find(n => n.type === 'form')!;
  await form.props.onSubmit({ preventDefault() {} });
  expect(state.commit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'replace', eventIds: ['event-0', 'event-1'], memories: ['m-0'] }));
  findButton(root, '取消').props.onClick(); await flush();
  membershipSession.value = session('single'); await flush();
  expect(nodes(root).filter(n => n.type === 'input' && n.props.type === 'checkbox')).toHaveLength(20);
  expect(nodes(root).filter(n => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked)).toHaveLength(1);
  app.unmount();
});

test('picker normalizes captured summary and chain text once, and invalidates on a new session', async () => {
  const { root, app } = mount();
  const data = session(); membershipSession.value = data; await flush();
  const normalize = vi.spyOn(String.prototype, 'toLocaleLowerCase');
  const isSource = (value: unknown) => String(value).includes('合成摘要') || /^事件 \d+$/.test(String(value));
  try {
    field(root, '摘要关键词').props['onUpdate:modelValue']('灯'); await flush();
    expect(normalize.mock.contexts.filter(value => String(value).includes('合成摘要'))).toHaveLength(55);
    normalize.mockClear(); field(root, '摘要关键词').props['onUpdate:modelValue']('灯会'); await flush();
    expect(normalize.mock.contexts.filter(isSource)).toHaveLength(0);
    field(root, '查找事件链').props['onUpdate:modelValue']('事件'); await flush();
    expect(normalize.mock.contexts.filter(value => /^事件 \d+$/.test(String(value)))).toHaveLength(25);
    normalize.mockClear(); field(root, '查找事件链').props['onUpdate:modelValue']('事件 2'); await flush();
    expect(normalize.mock.contexts.filter(value => /^事件 \d+$/.test(String(value)) && String(value) !== '事件 2')).toHaveLength(0);
    membershipSession.value = session(); await flush(); normalize.mockClear();
    field(root, '摘要关键词').props['onUpdate:modelValue']('调查'); await flush();
    expect(normalize.mock.contexts.filter(value => String(value).includes('合成摘要'))).toHaveLength(55);
  } finally { app.unmount(); }
});
