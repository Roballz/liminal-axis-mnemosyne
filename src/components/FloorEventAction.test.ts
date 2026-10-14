import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, nextTick, ssrContextKey } from 'vue';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc';
const mocks = vi.hoisted(() => ({ open: vi.fn(), toggle: vi.fn(), leaf: { id: 'leaf-0', tags: { eventIds: ['not-a-formal-chain'] } } }));
vi.mock('@/st/context', () => ({ getContext: () => ({ chat: [{}] }) }));
vi.mock('@/memory/apply', () => ({ getLeaf: () => mocks.leaf }));
vi.mock('@/memory/store', async () => ({ derivedMeta: (await import('vue')).reactive({ rev: 0 }) }));
vi.mock('@/mnemosyne/manual-events', async () => ({ manualEventState: (await import('vue')).reactive({ busy: false }) }));
vi.mock('@/mnemosyne/jobs', async () => ({ jobState: (await import('vue')).reactive({ busy: false }) }));
vi.mock('@/mnemosyne/event-membership-ui', async () => {
  const { shallowRef, reactive } = await import('vue');
  return { membershipBadges: shallowRef(new Map()), membershipUi: reactive({ loading: false, saving: false }),
    openMemberships: mocks.open, membershipPicking: shallowRef(false), membershipRowsByHost: shallowRef(new Map()),
    membershipSelected: shallowRef(new Set()), toggleMembershipRow: mocks.toggle };
});
import Panel from './FloorEventAction.vue';
import { membershipBadges, membershipUi, membershipPicking, membershipRowsByHost } from '@/mnemosyne/event-membership-ui';
import { manualEventState } from '@/mnemosyne/manual-events';
import { jobState } from '@/mnemosyne/jobs';
const descriptor = parse(readFileSync(new URL('./FloorEventAction.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'floor-event-test' }).bindings;
const code = compileTemplate({ source: descriptor.template!.content, filename: 'FloorEventAction.vue', id: 'floor-event-test', compilerOptions: { bindingMetadata: bindings } }).code;
(Panel as any).render = new Function('Vue', code.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render'))(Vue);
const badges = membershipBadges as unknown as Vue.Ref<Map<string, any[]> | null>;
interface Node { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
const make = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] });
const renderer = createRenderer<Node, Node>({ createElement: type => make(type), createText: text => make('text', text), createComment: text => make('comment', text), setText: (n, t) => { n.text = t; }, setElementText: (n, t) => { n.text = t; n.children = []; }, patchProp: (n, key, _, value) => { n.props[key] = value; }, insert: (n, p, anchor) => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = p; const i = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(i < 0 ? p.children.length : i, 0, n); }, remove: n => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); }, parentNode: n => n.parent ?? null, nextSibling: n => { const siblings = n.parent?.children ?? []; return siblings[siblings.indexOf(n) + 1] ?? null; } });
const nodes = (n: Node): Node[] => [n, ...n.children.flatMap(nodes)];
const content = (n: Node): string => n.text + n.children.map(content).join('');
const button = (root: Node, label: string) => nodes(root).find(n => n.type === 'button' && content(n).includes(label))!;
const apps: ReturnType<typeof renderer.createApp>[] = [];
function mount(props: Record<string, unknown> = {}) { const root = make('root'), app = renderer.createApp(Panel, { floor: 0, ...props }); app.provide(ssrContextKey, {}); app.mount(root); apps.push(app); return root; }
async function flush() { await nextTick(); await nextTick(); await nextTick(); }
beforeEach(() => {
  badges.value = new Map(); membershipUi.loading = false; membershipUi.saving = false;
  manualEventState.busy = false; jobState.busy = false; membershipPicking.value = false;
  mocks.open.mockReset(); mocks.toggle.mockReset();
});
afterEach(() => apps.splice(0).forEach(app => app.unmount()));
const status = (root: Node) => nodes(root).find(n => n.type === 'span' && String(n.props.class).includes('mn-floor-event-text'))!;
const action = (root: Node) => nodes(root).find(n => n.type === 'button')!;

test('known empty uses italic status, ignoring legacy event tags, and an icon-only dialog action', () => {
  const root = mount();
  expect(content(status(root))).toBe('本楼层尚未加入事件链');
  expect(status(root).props.class).toContain('is-muted');
  expect(content(action(root))).toBe('');
  expect(action(root).props['aria-haspopup']).toBe('dialog');
  expect(action(root).props['aria-label']).toContain('管理本楼层事件链关联');
  expect(action(root).props.title).toBe(action(root).props['aria-label']);
  expect(content(root)).not.toContain('not-a-formal-chain');
});
test('all formal chain names remain visible, including long names and review metadata in title', () => {
  const names = ['非常长的事件链名称'.repeat(30), 'AnotherLongUnbrokenChainName'.repeat(30), '事件链三'];
  badges.value = new Map([['leaf-0', names.map((title, i) => ({ title, archived: i === 0, needsReview: i === 1 }))]]);
  const root = mount();
  expect(content(status(root))).toBe(`关联事件链:${names.join('，')}`);
  expect(status(root).props.class).not.toContain('is-muted');
  expect(status(root).props.title).toContain('（已归档）');
  expect(status(root).props.title).toContain('（待审核）');
});
test('stale and loading projections never claim empty membership or show stale names', async () => {
  badges.value = new Map([['leaf-0', [{ title: '旧事件链' }]]]);
  const root = mount(); badges.value = null; await flush();
  expect(content(status(root))).toBe('事件链 · 待刷新');
  expect(content(root)).not.toContain('旧事件链');
  membershipUi.loading = true; await flush();
  expect(content(status(root))).toBe('事件链 · 加载中');
  expect(action(root).props.disabled).toBe(true);
});
test('click opens the same floor and explicit leaf; unmount invalidates its currentness guard', () => {
  const root = mount({ leafId: 'explicit-leaf' });
  const stopPropagation = vi.fn(); action(root).props.onClick({ stopPropagation });
  expect(stopPropagation).toHaveBeenCalledOnce();
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ floor: 0, expectedLeafId: 'explicit-leaf' }));
  const guard = mocks.open.mock.calls[0][0].isCurrent;
  expect(guard()).toBe(true); apps.pop()!.unmount(); expect(guard()).toBe(false);
});
test('busy/loading/saving gates and existing-membership editing preserve previous behavior', async () => {
  const root = mount({ disabled: true }); expect(action(root).props.disabled).toBe(true);
  badges.value = new Map([['leaf-0', [{ title: '已有事件链' }]]]); await flush();
  expect(action(root).props.disabled).toBe(false);
  for (const state of [membershipUi, manualEventState, jobState]) {
    const key = state === membershipUi ? 'saving' : 'busy';
    (state as any)[key] = true; await flush(); expect(action(root).props.disabled).toBe(true);
    (state as any)[key] = false; await flush();
  }
});
test('bulk picking remains a checkbox and preserves selection handling', () => {
  membershipPicking.value = true;
  (membershipRowsByHost as unknown as Vue.Ref<Map<string, any>>).value = new Map([['leaf-0', { id: 'row-0', valid: true }]]);
  const root = mount(); const input = nodes(root).find(n => n.type === 'input')!;
  expect(input.props.disabled).toBe(false); input.props.onChange();
  expect(mocks.toggle).toHaveBeenCalledWith('row-0'); expect(action(root)).toBeUndefined();
});

test.each([320, 360])('CSS layout contract at %ipx reserves a non-overlapping action rail and wrapping text (not browser geometry)', width => {
  const css = descriptor.styles[0].content;
  const panel = parse(readFileSync(new URL('./FloorPanel.vue', import.meta.url), 'utf8')).descriptor.styles.map(s => s.content).join('\n');
  expect(css).toContain('grid-template-columns: minmax(0, 1fr) var(--mn-floor-actions-width, 60px)');
  const compiled = compileStyle({ source: css, filename: 'FloorEventAction.vue', id: 'data-v-test', scoped: true });
  expect(compiled.errors).toEqual([]);
  expect(compiled.code).toContain(".bbs-root[data-theme='night'] .mn-floor-event-text:not(.is-muted) { color: #fff;");
  expect(css).toContain('overflow-wrap: anywhere'); expect(css).toContain('white-space: normal');
  expect(css).not.toContain('text-overflow: ellipsis'); expect(css).not.toContain('position: absolute');
  expect(css).toMatch(/mn-floor-event-actions \{[^}]*justify-content: center/);
  expect(panel).toContain('--mn-floor-actions-width: 60px');
  // Existing card insets + grid gap + fixed action rail leave positive wrapping space.
  expect(width - 2 * 14 - 8 - 60).toBeGreaterThan(200);
  expect(60 / 2).toBe((26 / 2 + (26 + 8 + 26 / 2)) / 2);
});
