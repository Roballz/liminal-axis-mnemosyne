import { beforeEach, afterEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ apps: [] as any[], callbacks: new Map<string, Function>(), active: true, chat: [] as any[], aiChecks: vi.fn((m: any) => !!m && !m.is_user) }));
vi.mock('vue', async original => ({ ...await original<typeof import('vue')>(), createApp: (_component: any, props: any) => {
  const app = { props, mount: vi.fn(), unmount: vi.fn() }; mocks.apps.push(app); return app;
} }));
vi.mock('@/components/FloorPanel.vue', () => ({ default: {} }));
vi.mock('@/st/context', () => ({ getContext: () => ({ chat: mocks.chat, eventTypes: { CHARACTER_MESSAGE_RENDERED: 'render', MORE_MESSAGES_LOADED: 'more', CHAT_CHANGED: 'chat', MESSAGE_UPDATED: 'update' }, eventSource: { on: (event: string, cb: Function) => mocks.callbacks.set(event, cb) } }) }));
vi.mock('@/api/settings', () => ({ apiSettings: { ui: { showFloorPanel: true } }, engineActiveHere: () => mocks.active }));
vi.mock('@/memory/engine', () => ({ isRealAiReply: mocks.aiChecks }));
vi.mock('@/st/keyboard', () => ({ guardEditableArrowKeys: vi.fn() }));
vi.mock('@/version', () => ({ versionedAssetUrl: () => '' }));
import { syncFloorPanel } from './floorPanel';
let messages: any[], scans: ReturnType<typeof vi.fn>;
let mutations: (records: MutationRecord[]) => void;
const chatRoot = { nodeType: 1, closest: () => null };
function host() {
  const node: any = { nodeType: 1, isConnected: true, children: [] as any[], setAttribute: vi.fn(), querySelector: () => null, appendChild(child: any) { this.children.push(child); }, remove() { this.isConnected = false; }, attachShadow() { return { querySelector: () => null, appendChild: vi.fn(), adoptedStyleSheets: [] }; } };
  return node;
}
function message(index: number) {
  const attributes = new Map<string, string>([['mesid', String(index)]]), children: any[] = [];
  const result: any = { nodeType: 1, attributes, children, getAttribute: (key: string) => attributes.get(key), setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key),
    matches: (selector: string) => selector === '.mes[mesid]', closest: () => result,
    contains: (child: any) => children.includes(child) && child.isConnected,
    querySelectorAll: (selector: string) => selector === '.mes[mesid]' ? [] : children.filter(c => c.isConnected), querySelector: () => ({ insertAdjacentElement: (_where: string, child: any) => children.push(child) }), appendChild: (child: any) => children.push(child) };
  return result;
}
beforeEach(() => {
  vi.useFakeTimers(); mocks.apps.length = 0; mocks.active = true;
  mocks.chat = Array.from({ length: 155 }, () => ({ is_user: false })); messages = mocks.chat.map((_, i) => message(i));
  scans = vi.fn((selector: string) => selector === '.mes[mesid]' ? messages : selector === '.bbs-fp-host' ? messages.flatMap(m => m.children.filter((c: any) => c.isConnected)) : messages.filter(m => m.attributes.has('data-bbs-fp')));
  vi.stubGlobal('document', { getElementById: () => chatRoot, querySelectorAll: scans, querySelector: (selector: string) => selector === '#chat' ? chatRoot : messages.find(m => m.attributes.get('mesid') === selector.match(/mesid="(\d+)"/)?.[1]), createElement: host });
  vi.stubGlobal('MutationObserver', class { constructor(callback: typeof mutations) { mutations = callback; } observe() {} disconnect() {} }); vi.stubGlobal('CSSStyleSheet', undefined);
  syncFloorPanel(true); scans.mockClear(); mocks.aiChecks.mockClear();
});
afterEach(() => { syncFloorPanel(false); vi.useRealTimers(); vi.unstubAllGlobals(); });
test('155 rendered messages schedule one visible-floor sweep and one shared refresh', () => {
  const tick = mocks.apps[0].props.sig.tick;
  for (let i = 0; i < 155; i++) mocks.callbacks.get('render')!(i);
  vi.advanceTimersByTime(60);
  expect(scans.mock.calls.filter(([selector]) => selector === '.mes[mesid]')).toHaveLength(1);
  expect(mocks.apps[0].props.sig.tick - tick).toBe(1);
  expect(mocks.apps).toHaveLength(155);
});
test('replacing a rendered TT message unmounts the detached Vue app before replacement', () => {
  const old = mocks.apps[0], previousHost = messages[0].children[0];
  previousHost.isConnected = false; messages[0] = message(0);
  mocks.callbacks.get('render')!(0); vi.advanceTimersByTime(60);
  expect(old.unmount).toHaveBeenCalledOnce(); expect(mocks.apps).toHaveLength(156);
});
test('disabling the panel cancels pending refresh work', () => {
  mocks.callbacks.get('render')!(0); syncFloorPanel(false); scans.mockClear();
  vi.advanceTimersByTime(300);
  expect(scans).not.toHaveBeenCalled(); expect(mocks.apps).toHaveLength(155);
});

test('switching to an excluded chat disposes all previous apps without remounting', () => {
  const previous = [...mocks.apps];
  mocks.callbacks.get('render')!(0); mocks.active = false; mocks.callbacks.get('chat')!();
  vi.advanceTimersByTime(300);
  expect(previous.every(app => app.unmount.mock.calls.length === 1)).toBe(true);
  expect(mocks.apps).toHaveLength(155);
});

function changed(target: any, addedNodes: any[] = [], removedNodes: any[] = []) {
  mutations([{ type: 'childList', target, addedNodes, removedNodes } as unknown as MutationRecord]);
}

test('50 body fragment replacements over one second perform no floor sweep or AI-floor checks', () => {
  const body = { nodeType: 1, closest: () => messages[100] }, tick = mocks.apps[0].props.sig.tick;
  for (let i = 0; i < 50; i++) { changed(body, [{ nodeType: 3 }], [{ nodeType: 3 }]); vi.advanceTimersByTime(20); }
  expect(scans).not.toHaveBeenCalled(); expect(mocks.aiChecks).not.toHaveBeenCalled();
  expect(mocks.apps).toHaveLength(155); expect(mocks.apps[0].props.sig.tick).toBe(tick);
});

test('added message roots and roots inside a loaded wrapper mount only the affected floors', () => {
  mocks.chat.push({ is_user: false }, { is_user: false });
  const first = message(155), second = message(156); messages.push(first, second);
  changed(chatRoot, [first, { nodeType: 1, matches: () => false, querySelectorAll: () => [second] }]);
  vi.advanceTimersByTime(200);
  expect(scans).not.toHaveBeenCalled(); expect(mocks.apps).toHaveLength(157);
  expect(mocks.apps.slice(155).map(app => app.props.floor)).toEqual([155, 156]);
  expect(mocks.apps.slice(0, 155).every(app => app.unmount.mock.calls.length === 0)).toBe(true);
});

test('removing a message root disposes only that app without a replacement render event', () => {
  const removed = messages[70], app = mocks.apps[70]; removed.children[0].isConnected = false;
  messages.splice(70, 1); changed(chatRoot, [], [removed]); vi.advanceTimersByTime(200);
  expect(app.unmount).toHaveBeenCalledOnce(); expect(scans).not.toHaveBeenCalled();
  expect(mocks.apps).toHaveLength(155); expect(mocks.apps.filter(item => item.unmount.mock.calls.length)).toHaveLength(1);
});

test('a replaced message or lost panel is repaired locally and queued repair cancels on disable', () => {
  const old = messages[0], first = mocks.apps[0]; old.children[0].isConnected = false;
  messages[0] = message(0); changed(chatRoot, [messages[0]], [old]); vi.advanceTimersByTime(200);
  expect(first.unmount).toHaveBeenCalledOnce(); expect(mocks.apps).toHaveLength(156);
  const lost = messages[1].children[0]; lost.isConnected = false;
  changed(messages[1], [], [lost]); vi.advanceTimersByTime(200);
  expect(mocks.apps[1].unmount).toHaveBeenCalledOnce(); expect(mocks.apps).toHaveLength(157);
  expect(scans).not.toHaveBeenCalled();
  messages[2].children[0].isConnected = false; changed(messages[2]); syncFloorPanel(false);
  scans.mockClear(); vi.advanceTimersByTime(300); expect(scans).not.toHaveBeenCalled(); expect(mocks.apps).toHaveLength(157);
});
