import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, nextTick, ssrContextKey } from 'vue';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), locate: vi.fn(), close: vi.fn(), toast: vi.fn() }));
vi.mock('@/mnemosyne/bridge', async () => ({ readReplyBlockers: mocks.inspect, locateReplyBlocker: mocks.locate,
    replyDiagnosticEpoch: (await import('vue')).ref(0) }));
vi.mock('@/state/ui', () => ({ closeBook: mocks.close }));
vi.mock('@/st/toast', () => ({ toast: mocks.toast }));
import Panel from './ReplyBlockerPanel.vue';
import { replyDiagnosticEpoch } from '@/mnemosyne/bridge';
const issue = (floor: number) => ({ floor, swipe: 0, reason: 'api_error' as const, current: () => true });
const descriptor = parse(readFileSync(new URL('./ReplyBlockerPanel.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'reply-blocker-test' }).bindings;
const code = compileTemplate({ source: descriptor.template!.content, filename: 'ReplyBlockerPanel.vue', id: 'reply-blocker-test', compilerOptions: { bindingMetadata: bindings } }).code;
(Panel as any).render = new Function('Vue', code.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render'))(Vue);
interface Node { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
const make = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] });
const renderer = createRenderer<Node, Node>({ createElement: type => make(type), createText: text => make('text', text), createComment: text => make('comment', text), setText: (n, t) => { n.text = t; }, setElementText: (n, t) => { n.text = t; n.children = []; }, patchProp: (n, key, _, value) => { n.props[key] = value; }, insert: (n, p, anchor) => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = p; const i = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(i < 0 ? p.children.length : i, 0, n); }, remove: n => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); }, parentNode: n => n.parent ?? null, nextSibling: n => { const siblings = n.parent?.children ?? []; return siblings[siblings.indexOf(n) + 1] ?? null; } });
const nodes = (n: Node): Node[] => [n, ...n.children.flatMap(nodes)];
const content = (n: Node): string => n.text + n.children.map(content).join('');
const button = (root: Node, label: string) => nodes(root).find(n => n.type === 'button' && content(n).includes(label))!;
const apps: ReturnType<typeof renderer.createApp>[] = [];
function mount(props: Record<string, unknown> = {}) { const root = make('root'), app = renderer.createApp(Panel, { initial: issue(4), ...props }); app.provide(ssrContextKey, {}); app.mount(root); apps.push(app); return root; }
async function flush() { await nextTick(); await nextTick(); await nextTick(); }
beforeEach(() => { mocks.inspect.mockReset(); mocks.locate.mockReset(); mocks.close.mockReset(); mocks.toast.mockReset(); replyDiagnosticEpoch.value = 0; });
afterEach(() => apps.splice(0).forEach(app => app.unmount()));

test('shows first blocked floor and reason immediately without any diagnostic scan or acceptance control', () => {
    const root = mount();
    expect(content(root)).toContain('楼层 #4'); expect(content(root)).toContain('疑似 API 错误');
    expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.locate).not.toHaveBeenCalled();
    expect(nodes(root).filter(n => n.type === 'button').map(content)).toEqual(['定位原文', '检查其他楼层', '重新检查']);
    for (const path of ['./SummaryEditPrompt.vue', '../pages/archive/index.vue'])
        expect(readFileSync(new URL(path, import.meta.url), 'utf8')).toContain('<ReplyBlockerPanel');
});

test('inspection is explicit, partial is visible, and later pages replace rather than accumulate DOM rows', async () => {
    const root = mount();
    mocks.inspect.mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => issue(10 + i)), examined: 100, total: 300,
        next: { offset: 100, candidateFloor: -1, current: () => true }, current: () => true });
    await button(root, '检查其他楼层').props.onClick(); await flush();
    expect(content(root)).toContain('仅部分结果，尚未检查完');
    expect(nodes(root).filter(n => n.type === 'li')).toHaveLength(11);
    mocks.inspect.mockResolvedValueOnce({ items: [issue(150)], examined: 200, total: 300,
        next: { offset: 200, candidateFloor: -1, current: () => true }, current: () => true });
    await button(root, '继续检查').props.onClick(); await flush();
    expect(mocks.inspect.mock.calls[1][0].offset).toBe(100);
    expect(nodes(root).filter(n => n.type === 'li')).toHaveLength(2);
    expect(content(root)).not.toContain('楼层 #10 '); expect(content(root)).toContain('楼层 #150');
});

test('context invalidation discards a delayed page without automatically restarting it', async () => {
    const root = mount(); let release!: (value: any) => void;
    mocks.inspect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = button(root, '检查其他楼层').props.onClick();
    replyDiagnosticEpoch.value++;
    release({ items: [issue(999)], examined: 100, total: 100, current: () => true });
    await pending; await flush(); expect(content(root)).not.toContain('#999'); expect(mocks.inspect).toHaveBeenCalledTimes(1);
});

test('unsupported navigation keeps explicit floor fallback and never closes the panel as success', async () => {
    const root = mount(); mocks.locate.mockResolvedValue('unsupported');
    await button(root, '定位原文').props.onClick(); await flush();
    expect(content(root)).toContain('当前宿主无法自动定位'); expect(content(root)).toContain('查找楼层 #4');
    expect(mocks.close).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
});

test('navigation only reports a request; dismissing while it is pending prevents late UI effects', async () => {
    let root = mount(); mocks.locate.mockResolvedValueOnce('requested');
    await button(root, '定位原文').props.onClick(); await flush();
    expect(mocks.toast.mock.calls[0][0]).toContain('已请求定位'); expect(mocks.close).toHaveBeenCalledTimes(1);
    apps.pop()!.unmount(); mocks.close.mockClear(); mocks.toast.mockClear(); root = mount();
    let release!: (value: string) => void; mocks.locate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = button(root, '定位原文').props.onClick(); apps.pop()!.unmount(); release('requested');
    await pending; await flush(); expect(mocks.close).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
});
