import { beforeEach, afterEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ apps: [] as any[], callbacks: new Map<string, Function>(), active: true, chat: [] as any[] }));
vi.mock('vue', async original => ({ ...await original<typeof import('vue')>(), createApp: (_component: any, props: any) => {
  const app = { props, mount: vi.fn(), unmount: vi.fn() }; mocks.apps.push(app); return app;
} }));
vi.mock('@/components/FloorPanel.vue', () => ({ default: {} }));
vi.mock('@/st/context', () => ({ getContext: () => ({ chat: mocks.chat, eventTypes: { CHARACTER_MESSAGE_RENDERED: 'render', MORE_MESSAGES_LOADED: 'more', CHAT_CHANGED: 'chat', MESSAGE_UPDATED: 'update' }, eventSource: { on: (event: string, cb: Function) => mocks.callbacks.set(event, cb) } }) }));
vi.mock('@/api/settings', () => ({ apiSettings: { ui: { showFloorPanel: true } }, engineActiveHere: () => mocks.active }));
vi.mock('@/memory/engine', () => ({ isRealAiReply: (m: any) => !!m && !m.is_user }));
vi.mock('@/st/keyboard', () => ({ guardEditableArrowKeys: vi.fn() }));
vi.mock('@/version', () => ({ versionedAssetUrl: () => '' }));
import { syncFloorPanel } from './floorPanel';
let messages: any[], scans: ReturnType<typeof vi.fn>;
function host() {
  const node: any = { isConnected: true, children: [] as any[], setAttribute: vi.fn(), querySelector: () => null, appendChild(child: any) { this.children.push(child); }, remove() { this.isConnected = false; }, attachShadow() { return { querySelector: () => null, appendChild: vi.fn(), adoptedStyleSheets: [] }; } };
  return node;
}
function message(index: number) {
  const attributes = new Map<string, string>([['mesid', String(index)]]), children: any[] = [];
  return { attributes, children, getAttribute: (key: string) => attributes.get(key), setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key),
    contains: (child: any) => children.includes(child) && child.isConnected,
    querySelectorAll: () => children.filter(c => c.isConnected), querySelector: () => ({ insertAdjacentElement: (_where: string, child: any) => children.push(child) }), appendChild: (child: any) => children.push(child) };
}
beforeEach(() => {
  vi.useFakeTimers(); mocks.apps.length = 0; mocks.active = true;
  mocks.chat = Array.from({ length: 155 }, () => ({ is_user: false })); messages = mocks.chat.map((_, i) => message(i));
  scans = vi.fn((selector: string) => selector === '.mes[mesid]' ? messages : selector === '.bbs-fp-host' ? messages.flatMap(m => m.children.filter((c: any) => c.isConnected)) : messages.filter(m => m.attributes.has('data-bbs-fp')));
  vi.stubGlobal('document', { getElementById: () => ({}), querySelectorAll: scans, querySelector: (selector: string) => selector === '#chat' ? {} : messages[Number(selector.match(/mesid="(\d+)"/)?.[1])], createElement: host });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} }); vi.stubGlobal('CSSStyleSheet', undefined);
  syncFloorPanel(true); scans.mockClear();
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
