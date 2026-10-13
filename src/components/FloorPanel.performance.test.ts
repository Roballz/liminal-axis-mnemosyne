import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { createSSRApp, createRenderer, defineComponent, h, nextTick, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
const mocks = vi.hoisted(() => ({ chat: [] as any[], writes: vi.fn() }));
vi.mock('@/st/context', () => ({ getContext: () => ({ chat: mocks.chat, getCurrentChatId: () => 'synthetic' }) }));
vi.mock('@/memory/apply', () => ({ getLeaf: (m: any) => m?.extra?.bbs_leaf ?? null, leafValid: () => true, deleteLeafAt: vi.fn(), editLeafFull: mocks.writes, planContentById: vi.fn(), describeVarOp: vi.fn() }));
vi.mock('@/memory/engine', async () => ({ engineState: (await import('vue')).reactive({ running: false }), floorBackfillState: (await import('vue')).reactive({ running: false }), regenerateFloor: vi.fn(), setFloorOmit: vi.fn(), summarizeFloor: vi.fn() }));
vi.mock('@/memory/store', async () => ({ derivedMeta: (await import('vue')).reactive({ rev: 0 }) }));
vi.mock('@/state/ui', () => ({ ui: { theme: 'day' } }));
vi.mock('./FloorEventAction.vue', () => ({ default: defineComponent({ render: () => null }) }));
vi.mock('./ConfirmDialog.vue', () => ({ default: defineComponent({ render: () => null }) }));
vi.mock('./BbsSelect.vue', () => ({ default: defineComponent({ render: () => null }) }));
import Panel from './FloorPanel.vue';
import { derivedMeta } from '@/memory/store';
const descriptor = parse(readFileSync(new URL('./FloorPanel.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'floor-panel-test' }).bindings;
const code = compileTemplate({ source: descriptor.template!.content, filename: 'FloorPanel.vue', id: 'floor-panel-test', compilerOptions: { bindingMetadata: bindings } }).code;
(Panel as any).render = new Function('Vue', code.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render'))({ ...Vue, vModelText: {} });
interface Node { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
const make = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] });
const renderer = createRenderer<Node, Node>({ createElement: type => make(type), createText: text => make('text', text), createComment: text => make('comment', text), setText: (n, t) => { n.text = t; }, setElementText: (n, t) => { n.text = t; n.children = []; }, patchProp: (n, key, _, value) => { n.props[key] = value; }, insert: (n, p, anchor) => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = p; const i = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(i < 0 ? p.children.length : i, 0, n); }, remove: n => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); }, parentNode: n => n.parent ?? null, nextSibling: n => { const siblings = n.parent?.children ?? []; return siblings[siblings.indexOf(n) + 1] ?? null; } });
const nodes = (n: Node): Node[] => [n, ...n.children.flatMap(nodes)];
const content = (n: Node): string => n.text + n.children.map(content).join('');
const button = (root: Node, label: string) => nodes(root).find(n => n.type === 'button' && content(n).includes(label))!;
const apps: ReturnType<typeof renderer.createApp>[] = [];
function mount() { const root = make('root'), app = renderer.createApp(Panel, { floor: 0, sig: { tick: 0 } }); app.provide(ssrContextKey, {}); app.mount(root); apps.push(app); return root; }
async function flush() { await nextTick(); await nextTick(); await nextTick(); }
let deltaReads = 0;
beforeEach(() => {
  deltaReads = 0; mocks.writes.mockReset();
  mocks.chat = Array.from({ length: 155 }, (_, i) => ({ mes: '合成正文', extra: { bbs_leaf: {
    id: `leaf-${i}`, text: '合成长摘要'.repeat(2_000), delta: { get items() { deltaReads++; return { add: [{ name: '保留草稿测试物品', qty: 1 }] }; } },
  } } }));
  vi.stubGlobal('HTMLInputElement', class {}); vi.stubGlobal('HTMLTextAreaElement', class {});
});
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); vi.unstubAllGlobals(); });
test('155 collapsed host cards omit hidden delta DOM and bound their preview text', async () => {
  const html = await renderToString(createSSRApp({ render: () => h('main', mocks.chat.map((_, floor) => h(Panel, { floor, sig: { tick: 0 } }))) }));
  expect(html.match(/bbs-fp-preview/g)).toHaveLength(155);
  expect(html).not.toContain('保留草稿测试物品'); expect(html).not.toContain('bbs-fp-drawer-body');
  expect(deltaReads).toBe(0); expect(html.length).toBeLessThan(500_000);
});
test('opening mounts details; closing removes details but preserves the edit draft until explicit save', async () => {
  const root = mount(); await flush();
  const toggle = () => nodes(root).find(n => n.type === 'header')!.props.onClick();
  expect(deltaReads).toBe(0); toggle(); await flush(); expect(content(root)).toContain('保留草稿测试物品');
  nodes(root).find(n => n.type === 'p' && String(n.props.class).includes('bbs-fp-text'))!.props.onClick(); await flush();
  nodes(root).find(n => n.type === 'textarea')!.props['onUpdate:modelValue']('未保存的人工草稿'); await flush();
  toggle(); await flush(); expect(nodes(root).filter(n => n.type === 'textarea')).toHaveLength(0);
  const reads = deltaReads; derivedMeta.rev++; await flush(); expect(deltaReads).toBe(reads);
  toggle(); await flush(); expect(nodes(root).find(n => n.type === 'textarea')!.props['onUpdate:modelValue']).toBeTypeOf('function');
  button(root, '保存').props.onClick(); await flush();
  expect(mocks.writes).toHaveBeenCalledWith(0, expect.objectContaining({ text: '未保存的人工草稿' }));
});
