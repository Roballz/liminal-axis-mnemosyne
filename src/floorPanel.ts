/**
 * 楼内摘要面板注入(生命周期宿主)。
 *
 * 每条**真实 AI 楼**(isRealAiReply,含已标番外者)在 .mes_text 后挂一个 host,
 * host 内 attachShadow + 共享 dist/index.css → 挂一个 FloorPanel.vue 实例(props: floor, tick)。
 * 卡片外观、抽屉动画、只读/编辑全在组件里;本模块只管:注入/清理、事件驱动、防重复、样式共享。
 *
 * chat 非 reactive:用一个共享 reactive tick,相关事件触发时 +1,组件 watch 它重读当前楼数据。
 * 样式隔离:每楼独立 shadow,共享同一份构造样式表(adoptedStyleSheets,一次解析 N 次采用),
 * 避免 Horae「每楼一份 CSS 副本」的开销;构造失败回退 <link>。
 */
import { createApp, reactive, type App } from 'vue';
import FloorPanel from '@/components/FloorPanel.vue';
import { getContext } from '@/st/context';
import { guardEditableArrowKeys } from '@/st/keyboard';
import { isRealAiReply } from '@/memory/engine';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { watch } from 'vue';
import { versionedAssetUrl } from '@/version';

const HOST_CLASS = 'bbs-fp-host';
const MARK_ATTR = 'data-bbs-fp'; // 标在 .mes 上,防重复注入

let enabled = false;
let observer: MutationObserver | null = null;
let sharedSheet: CSSStyleSheet | null = null;
let cssHref = '';
const bound = new Set<string>(); // 已绑定的事件名(幂等)

// 共享刷新信号:任何会改变楼层叶子/番外态的事件都 +1,组件据此重读 chat。
const signal = reactive({ tick: 0 });
function bumpTick(): void {
  signal.tick++;
}

interface Mounted {
  host: HTMLElement;
  app: App;
}
const mountedByFloor = new Map<number, Mounted>();

/* ============ 共享样式表 ============ */

function resolveCssHref(): string {
  if (cssHref) return cssHref;
  try {
    cssHref = versionedAssetUrl('./index.css', import.meta.url);
  } catch {
    cssHref = '';
  }
  return cssHref;
}

/** 异步构造一份共享样式表(仅一次)。失败静默,注入时回退 <link>。 */
async function ensureSharedSheet(): Promise<void> {
  if (sharedSheet || typeof CSSStyleSheet === 'undefined') return;
  const href = resolveCssHref();
  if (!href) return;
  try {
    const res = await fetch(href);
    const text = await res.text();
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    sharedSheet = sheet;
    // 已挂载的补采用(首屏可能先于样式表就绪注入)
    for (const host of document.querySelectorAll(`.${HOST_CLASS}`)) {
      const root = (host as HTMLElement).shadowRoot;
      if (root && !root.adoptedStyleSheets.includes(sheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      }
    }
  } catch {
    /* 回退 <link>,见 attachStyles */
  }
}

function attachStyles(root: ShadowRoot): void {
  if (sharedSheet) {
    if (!root.adoptedStyleSheets.includes(sharedSheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedSheet];
    }
    return;
  }
  const href = resolveCssHref();
  if (href && !root.querySelector('link[data-bbs-fp-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-bbs-fp-css', '');
    root.appendChild(link);
  }
}

/* ============ 注入 / 清理 ============ */

function mesEl(idx: number): HTMLElement | null {
  return document.querySelector(`.mes[mesid="${idx}"]`);
}
function activeNow(): boolean {
  return enabled && engineActiveHere();
}

/** 给某楼注入 FloorPanel(幂等)。 */
function injectFloor(idx: number, el: Element | null = mesEl(idx)): void {
  const chat = getContext()?.chat ?? [];
  if (!isRealAiReply(chat[idx])) return;

  if (!el) return;
  const previous = mountedByFloor.get(idx);
  if (previous?.host.isConnected && el.contains(previous.host)) return;
  // TT may replace a message before the observer runs. Dispose the old app
  // before replacing the map entry, otherwise detached reactive watchers leak.
  if (previous) removeFloor(idx);

  // 移除该楼可能残留的旧 host(mesid 复用/重渲)
  el.querySelectorAll(`.${HOST_CLASS}`).forEach(n => n.remove());

  const host = document.createElement('div');
  host.className = HOST_CLASS;
  host.setAttribute('data-bbs-fp-floor', String(idx));
  const root = host.attachShadow({ mode: 'open' });
  guardEditableArrowKeys(root);
  attachStyles(root);
  const container = document.createElement('div');
  root.appendChild(container);

  // 传 reactive signal 对象本身(引用稳定):组件读 sig.tick 即可响应式追踪。
  // createApp 的 props 是静态快照,传原始值(number)不会更新,故必须传对象。
  const app = createApp(FloorPanel, { floor: idx, sig: signal });
  app.mount(container);

  const mesText = el.querySelector('.mes_text');
  if (mesText) mesText.insertAdjacentElement('afterend', host);
  else el.appendChild(host);

  mountedByFloor.set(idx, { host, app });
  el.setAttribute(MARK_ATTR, '1');
}

function removeFloor(idx: number): void {
  const m = mountedByFloor.get(idx);
  if (m) {
    m.app.unmount();
    m.host.remove();
    mountedByFloor.delete(idx);
  }
  mesEl(idx)?.removeAttribute(MARK_ATTR);
}

/** 全量重扫:清全部再逐楼补挂。切聊天/大改动用。 */
function rebuildAll(): void {
  for (const idx of [...mountedByFloor.keys()]) removeFloor(idx);
  document.querySelectorAll(`.${HOST_CLASS}`).forEach(n => n.remove());
  document.querySelectorAll(`.mes[${MARK_ATTR}]`).forEach(n => n.removeAttribute(MARK_ATTR));
  if (!activeNow()) return;
  scanMissing(); // Only rendered messages need a DOM lookup / mounted panel.
}

/** 补挂 DOM 里已有 .mes 但尚未挂载的 AI 楼(首屏、批量加载)。 */
function scanMissing(): void {
  if (!activeNow()) return;
  // Clean detached apps first so this same pass can remount their replacement.
  for (const [idx, mounted] of mountedByFloor) if (!mounted.host.isConnected) removeFloor(idx);
  const chat = getContext()?.chat ?? [];
  document.querySelectorAll('.mes[mesid]').forEach(el => {
    const idx = Number((el as HTMLElement).getAttribute('mesid'));
    if (Number.isFinite(idx) && isRealAiReply(chat[idx])) injectFloor(idx, el);
  });
}

/* ============ 事件 ============ */

// Loading history can emit CHARACTER_MESSAGE_RENDERED once per visible message.
// Merge the burst into one DOM scan and one shared reactive tick.
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let needsScan = false, needsTick = false, needsRebuild = false;
const affectedFloors = new Set<number>();
function queueRefresh(scan: boolean, tick: boolean, rebuild = false, delay = 50): void {
  if (!enabled || (!activeNow() && !rebuild)) return;
  needsScan ||= scan; needsTick ||= tick; needsRebuild ||= rebuild;
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const scan = needsScan, tick = needsTick, rebuild = needsRebuild;
    needsScan = needsTick = needsRebuild = false;
    const floors = [...affectedFloors]; affectedFloors.clear();
    // A chat switch must dispose the previous chat even when the destination
    // excludes this engine. rebuildAll itself only remounts in an active chat.
    if (rebuild) rebuildAll();
    else if (activeNow() && scan) scanMissing();
    else if (activeNow()) for (const idx of floors) {
      const el = mesEl(idx);
      if (!el || !isRealAiReply(getContext()?.chat?.[idx])) removeFloor(idx);
      else injectFloor(idx, el);
    }
    if (activeNow() && tick) bumpTick();
  }, delay);
}
function cancelRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null; needsScan = needsTick = needsRebuild = false;
  affectedFloors.clear();
}
function onRendered(): void { queueRefresh(true, true); }
function onSwiped(): void { queueRefresh(true, true); }

function bindEvents(): void {
  const ctx = getContext();
  const es = ctx?.eventSource;
  const et = ctx?.eventTypes;
  if (!es || !et) return;
  const on = (name: string | undefined, fn: (...a: unknown[]) => void) => {
    if (!name || bound.has(name)) return;
    es.on(name, fn);
    bound.add(name);
  };
  on(et.CHARACTER_MESSAGE_RENDERED, onRendered);
  on(et.USER_MESSAGE_RENDERED, () => queueRefresh(true, false));
  on(et.MESSAGE_SWIPED, onSwiped);
  on(et.MESSAGE_DELETED, () => queueRefresh(true, true, true));
  on(et.MESSAGE_UPDATED, () => queueRefresh(false, true));
  on(et.MESSAGE_EDITED, () => queueRefresh(false, true));
  on(et.CHAT_CHANGED, () => queueRefresh(true, true, true, 80));
  if (et.MORE_MESSAGES_LOADED) on(et.MORE_MESSAGES_LOADED, () => queueRefresh(true, false));
}

function affectedFloor(el: Element): void {
  const idx = Number(el.getAttribute('mesid'));
  if (Number.isInteger(idx) && idx >= 0) affectedFloors.add(idx);
}

/** Body fragments do not change mounted panels. Reconcile only message roots
 * added/removed by the host, or a message whose panel has actually disappeared. */
function onChatMutations(records: MutationRecord[]): void {
  if (!activeNow()) return;
  for (const record of records) {
    const target = record.target.nodeType === 1 ? record.target as Element : null;
    const floor = target?.closest('.mes[mesid]');
    if (floor) {
      const mounted = mountedByFloor.get(Number(floor.getAttribute('mesid')));
      if (!mounted?.host.isConnected || !floor.contains(mounted.host)) affectedFloor(floor);
      continue;
    }
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      if (el.matches('.mes[mesid]')) affectedFloor(el);
      else el.querySelectorAll('.mes[mesid]').forEach(affectedFloor);
    }
  }
  if (affectedFloors.size) queueRefresh(false, false, false, 200);
}

/** 盯聊天区:仅补挂结构变化所影响的楼层,不因正文内部更新全页扫描。 */
function startObserver(): void {
  if (observer) return;
  const chatEl = document.getElementById('chat');
  if (!chatEl) return;
  observer = new MutationObserver(onChatMutations);
  observer.observe(chatEl, { childList: true, subtree: true });
}
function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  cancelRefresh();
}

/* ============ 对外 ============ */

/** 按开关同步楼内面板的有无(幂等)。 */
export function syncFloorPanel(on: boolean): void {
  enabled = on;
  if (!on) {
    stopObserver();
    rebuildAll(); // activeNow=false → 只清不建
    return;
  }
  void ensureSharedSheet();
  bindEvents();
  startObserver();
  rebuildAll();
}

/** 启动链调用一次:开关跟随(设置项 apiSettings.ui.showFloorPanel)。主题由组件内 ui.theme 响应式绑定。 */
export function bindFloorPanel(): void {
  watch(
    () => apiSettings.ui.showFloorPanel,
    v => syncFloorPanel(!!v),
    { immediate: true },
  );
}
