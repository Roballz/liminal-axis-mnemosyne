import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import Collapsible from './Collapsible.vue';

// Exercise the component's actual client template in a deterministic renderer.
vi.mock('./Icon.vue', () => ({ default: { render: () => null } }));
const descriptor = parse(readFileSync(new URL('./Collapsible.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'collapsible-test' }).bindings;
const template = compileTemplate({ source: descriptor.template!.content, filename: 'Collapsible.vue', id: 'collapsible-test',
  compilerOptions: { bindingMetadata: bindings } }).code;
const renderCode = template.replace(/import \{([^}]+)\} from "vue"/g,
  (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render');
(Collapsible as any).render = new Function('Vue', renderCode)(Vue);
interface Node { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
const make = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] });
const nodes = (root: Node): Node[] => [root, ...root.children.flatMap(nodes)];
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

test('closed content is lazy until first open, and closing preserves mounted drafts and cached work', async () => {
  const mount = vi.fn(), calculate = vi.fn(() => 'preview'), slot = vi.fn();
  const preview = Vue.computed(calculate);
  const Editor = Vue.defineComponent({ setup() {
    mount(); const draft = Vue.ref('');
    return () => Vue.h('input', { value: draft.value, onInput: (value: string) => { draft.value = value; } });
  } });
  const root = make('root');
  const Parent = Vue.defineComponent({ setup: () => () => Vue.h(Collapsible, { title: 'Advanced', open: false }, {
    default: () => { slot(); return [Vue.h('p', preview.value), Vue.h(Editor)]; },
  }) });
  const app = renderer.createApp(Parent); app.provide(Vue.ssrContextKey, {}); app.mount(root);
  try {
    expect(mount).not.toHaveBeenCalled(); expect(calculate).not.toHaveBeenCalled(); expect(slot).not.toHaveBeenCalled();
    const button = () => nodes(root).find(node => node.type === 'button')!;
    const input = () => nodes(root).find(node => node.type === 'input')!;
    button().props.onClick(); await Vue.nextTick();
    expect(mount).toHaveBeenCalledTimes(1); expect(calculate).toHaveBeenCalledTimes(1);
    const editor = input(); editor.props.onInput('unsaved draft'); await Vue.nextTick();
    button().props.onClick(); await Vue.nextTick();
    expect(button().props['aria-expanded']).toBe(false); expect(input()).toBe(editor);
    button().props.onClick(); await Vue.nextTick();
    expect(button().props['aria-expanded']).toBe(true); expect(input().props.value).toBe('unsaved draft');
    expect(mount).toHaveBeenCalledTimes(1); expect(calculate).toHaveBeenCalledTimes(1);
  } finally { app.unmount(); }
});

test('initially open sections still mount their content immediately', () => {
  const mounted = vi.fn();
  const Child = Vue.defineComponent({ setup() { mounted(); return () => Vue.h('p', 'content'); } });
  const app = renderer.createApp({ render: () => Vue.h(Collapsible, { title: 'Default' }, { default: () => Vue.h(Child) }) });
  app.provide(Vue.ssrContextKey, {}); app.mount(make('root'));
  expect(mounted).toHaveBeenCalledTimes(1); app.unmount();
});
