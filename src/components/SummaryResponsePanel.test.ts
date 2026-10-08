import { beforeEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, ssrContextKey } from 'vue';
import { readFileSync } from 'node:fs';
import { parse as parseSfc, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { requestSummaryResponse, summaryResponses, summaryResponseUi } from '@/memory/summary-response';
const mocks = vi.hoisted(() => ({ recover: vi.fn(), scope: 'chat-a' }));
vi.mock('@/memory/engine', () => ({ recoverSummaryResponse: mocks.recover, engineState: { running: false } }));
vi.mock('@/mnemosyne/bridge', async () => ({ hostScope: () => mocks.scope, dailyState: (await import('vue')).reactive({ generation: 0 }) }));
vi.mock('@/memory/store', () => ({ derivedMeta: { rev: 0 } }));
vi.mock('./ModalMask.vue', () => ({ default: defineComponent({ props: ['open'], setup: (p, { slots }) => () => p.open ? h('section', slots.default?.()) : null }) }));
vi.mock('./TableTextField.vue', () => ({ default: defineComponent({ props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('textarea', { value: p.modelValue, disabled: p.disabled, onInput: (e: any) => emit('update:modelValue', e.target.value) }) }) }));
import Panel from './SummaryResponsePanel.vue';
import { dailyState } from '@/mnemosyne/bridge';
// Node's Vite transform supplies SSR setup; compile the same template for our in-memory renderer.
const descriptor = parseSfc(readFileSync(new URL('./SummaryResponsePanel.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'response-test' }).bindings;
const template = compileTemplate({ source: descriptor.template!.content, filename: 'SummaryResponsePanel.vue', id: 'response-test', compilerOptions: { bindingMetadata: bindings } }).code;
const renderCode = template.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`)
  .replace('export function render', 'return function render');
(Panel as any).render = new Function('Vue', renderCode)(Vue);

interface Node { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
const make = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] });
const renderer = createRenderer<Node, Node>({
  createElement: type => make(type), createText: text => make('text', text), createComment: text => make('comment', text),
  setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
  patchProp: (node, key, _, value) => { node.props[key] = value; },
  insert: (node, parent, anchor) => { node.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(i < 0 ? parent.children.length : i, 0, node); },
  remove: node => { const p = node.parent; if (p) p.children.splice(p.children.indexOf(node), 1); },
  parentNode: node => node.parent ?? null, nextSibling: node => { const siblings = node.parent?.children ?? []; return siblings[siblings.indexOf(node) + 1] ?? null; },
});
const nodes = (root: Node): Node[] => [root, ...root.children.flatMap(nodes)];
const text = (root: Node): string => root.text + root.children.map(text).join('');
function mount() { const root = make('root'), app = renderer.createApp(Panel); app.provide(ssrContextKey, {}); app.mount(root); return { root, app }; }
const button = (root: Node, label: string) => nodes(root).find(n => n.type === 'button' && text(n).includes(label))!;
async function failed() {
  await requestSummaryResponse({ scope: 'chat-a', title: '单楼 #1', retries: 0, send: async () => 'bad', messages: [],
    parse: JSON.parse, apply: async () => {}, guard: () => {} }).catch(() => {});
}
beforeEach(() => { summaryResponses.splice(0); summaryResponseUi.selectedId = 0; mocks.scope = 'chat-a'; mocks.recover.mockReset(); });
it('渲染失败原文，编辑关闭后重开保留草稿；确认不会触发重复处理', async () => {
  await failed(); const { root, app } = mount();
  button(root, '查看').props.onClick(); await nextTick();
  const field = nodes(root).find(n => n.type === 'textarea')!;
  field.props.onInput({ target: { value: '{"summary":"修复"}' } }); await nextTick();
  button(root, '关闭').props.onClick(); await nextTick();
  expect(nodes(root).some(n => n.type === 'form')).toBe(false);
  button(root, '查看').props.onClick(); await nextTick();
  expect(nodes(root).find(n => n.type === 'textarea')!.props.value).toBe('{"summary":"修复"}');
  let done!: () => void;
  mocks.recover.mockImplementation(() => new Promise<void>(resolve => { done = resolve; }));
  const form = nodes(root).find(n => n.type === 'form')!;
  const event = { preventDefault() {} };
  form.props.onSubmit(event); form.props.onSubmit(event); await nextTick();
  expect(mocks.recover).toHaveBeenCalledOnce();
  expect(button(root, '关闭').props.disabled).toBe(true);
  done(); await nextTick(); await nextTick();
  app.unmount();
});
it('组件卸载重开仍有失败记录和草稿；换聊天关闭旧弹窗并隔离记录', async () => {
  await failed(); summaryResponses[0].attempts[0].draft = '{"summary":"保留"}';
  const first = mount(); first.app.unmount();
  const { root, app } = mount();
  button(root, '查看').props.onClick(); await nextTick();
  expect(nodes(root).find(n => n.type === 'textarea')!.props.value).toContain('保留');
  mocks.scope = 'chat-b'; dailyState.generation++; await nextTick();
  expect(text(root)).not.toContain('单楼 #1');
  expect(nodes(root).some(n => n.type === 'form')).toBe(false);
  app.unmount();
});
it('已应用返回只读，API 无正文不显示复用按钮', async () => {
  await failed(); summaryResponses[0].applied = true;
  const { root, app } = mount(); button(root, '查看').props.onClick(); await nextTick();
  expect(nodes(root).find(n => n.type === 'textarea')!.props.disabled).toBe(true);
  expect(button(root, '确认应用')).toBeUndefined(); app.unmount();
  summaryResponses[0].applied = false; summaryResponses[0].attempts[0].raw = null;
  const second = mount(); button(second.root, '查看').props.onClick(); await nextTick();
  expect(button(second.root, '确认应用')).toBeUndefined();
  expect(text(second.root)).toContain('未提供正文'); second.app.unmount();
});

it('全局弹窗可自动显示手动成功返回，关闭不提交，历史入口仍可重开', async () => {
  await requestSummaryResponse({ scope: 'chat-a', title: '手动单楼 #1', retries: 0, preview: true,
    send: async () => '{"summary":"待确认"}', messages: [], parse: JSON.parse, apply: vi.fn(), guard: () => {} });
  const root = make('root'), app = renderer.createApp(Panel, { dialogOnly: true });
  app.provide(ssrContextKey, {}); app.mount(root); await nextTick();
  expect(nodes(root).find(n => n.type === 'textarea')!.props.value).toContain('待确认');
  expect(button(root, '确认应用').props.disabled).toBe(false);
  button(root, '关闭').props.onClick(); await nextTick();
  expect(mocks.recover).not.toHaveBeenCalled();
  expect(summaryResponses[0].applied).toBe(false);
  app.unmount();
  const history = mount(); button(history.root, '查看').props.onClick(); await nextTick();
  expect(nodes(history.root).some(n => n.type === 'form')).toBe(true); history.app.unmount();
});
