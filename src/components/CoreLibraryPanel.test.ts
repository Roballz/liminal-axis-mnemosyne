import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, nextTick, ssrContextKey } from 'vue';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), change: vi.fn() }));
vi.mock('@/mnemosyne/library-management', () => ({ inspectCoreLibraries: mocks.inspect, setCoreLibraryDisabled: mocks.change }));
import Panel from './CoreLibraryPanel.vue';
const descriptor = parse(readFileSync(new URL('./CoreLibraryPanel.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'library-test' }).bindings;
const template = compileTemplate({ source: descriptor.template!.content, filename: 'CoreLibraryPanel.vue', id: 'library-test', compilerOptions: { bindingMetadata: bindings } }).code;
const renderCode = template.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render');
(Panel as any).render = new Function('Vue', renderCode)(Vue);
interface Node { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
const make = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] });
const renderer = createRenderer<Node, Node>({
    createElement: type => make(type), createText: text => make('text', text), createComment: text => make('comment', text),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    patchProp: (node, key, _, value) => { node.props[key] = value; },
    insert: (node, parent, anchor) => { node.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(i < 0 ? parent.children.length : i, 0, node); },
    remove: node => { const p = node.parent; if (p) p.children.splice(p.children.indexOf(node), 1); },
    parentNode: node => node.parent ?? null,
    nextSibling: node => { const siblings = node.parent?.children ?? []; return siblings[siblings.indexOf(node) + 1] ?? null; },
});
const nodes = (root: Node): Node[] => [root, ...root.children.flatMap(nodes)];
const text = (root: Node): string => root.text + root.children.map(text).join('');
const button = (root: Node, label: string) => nodes(root).find(n => n.type === 'button' && text(n).includes(label))!;
const apps: ReturnType<typeof renderer.createApp>[] = [];
function mount() { const root = make('root'), app = renderer.createApp(Panel); app.provide(ssrContextKey, {}); app.mount(root); apps.push(app); return { root, app }; }

const inventory = (disabled = false) => ({current:'current-core',shared:true,enumerable:true,entries:[
    {name:'current-core',current:true,disabled:false},{name:'old-core',current:false,disabled}]});
beforeEach(()=>{mocks.inspect.mockReset().mockResolvedValue(inventory());mocks.change.mockReset().mockResolvedValue(undefined);});
afterEach(()=>{apps.splice(0).forEach(app=>app.unmount());});
test('manual metadata inspection shows shared current library, only old library can be disabled, enabling never claims activation',async()=>{
    const {root}=mount();expect(mocks.inspect).not.toHaveBeenCalled();
    await button(root,'检查当前库').props.onClick();await nextTick();
    expect(text(root)).toContain('共享存储新库');expect(text(root)).toContain('当前使用中');
    expect(nodes(root).filter(n=>n.type==='button'&&text(n)==='禁用此旧库')).toHaveLength(1);
    mocks.inspect.mockResolvedValue(inventory(true));
    await button(root,'禁用此旧库').props.onClick();await nextTick();
    expect(mocks.change).toHaveBeenLastCalledWith('old-core',true,'current-core');
    expect(text(root)).toContain('已禁用此旧库');expect(text(root)).toContain('不释放占用空间');
    mocks.inspect.mockResolvedValue(inventory(false));
    await button(root,'解除禁用').props.onClick();await nextTick();
    expect(mocks.change).toHaveBeenLastCalledWith('old-core',false,'current-core');
    expect(text(root)).toContain('当前使用的核心库未切换');
});
test('failed disable remains visible, reports error, and does not claim success',async()=>{
    const {root}=mount();await button(root,'检查当前库').props.onClick();await nextTick();
    mocks.change.mockRejectedValue(new Error('当前核心库已改变，请刷新列表'));
    await button(root,'禁用此旧库').props.onClick();await nextTick();
    expect(text(root)).toContain('当前核心库已改变');expect(text(root)).not.toContain('已禁用此旧库');
    expect(button(root,'禁用此旧库').props.disabled).toBe(false);
});
