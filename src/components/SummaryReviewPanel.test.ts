import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, ssrContextKey } from 'vue';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
const mocks = vi.hoisted(() => ({ read: vi.fn(), host: vi.fn(() => 'host'), keep: vi.fn(), recover: vi.fn(), current: vi.fn(), sync: vi.fn() }));
vi.mock('@/mnemosyne/bridge', async () => ({
  dailyState: (await import('vue')).reactive({ generation: 1, revision: 1, scope: 'scope', review: 155, pending: false }),
  readDailyReview: mocks.read, hostVersion: mocks.host, dailyCurrent: mocks.current, syncDaily: mocks.sync, invalidateDaily: vi.fn(),
}));
vi.mock('@/mnemosyne/db', () => ({ activeLibrary: vi.fn(async () => ({})) }));
vi.mock('@/mnemosyne/canonical', () => ({ keepSummaries: mocks.keep }));
vi.mock('@/mnemosyne/summary-review-actions', () => ({ rebuildSummaryOwners: vi.fn() }));
vi.mock('@/mnemosyne/summary-recovery-confirmation', () => ({ summaryConfirmationPlan: (view: any, ids: Set<string>) => {
  const pending=view.memories.filter((m:any)=>ids.has(m.id)), high=pending.filter((m:any)=>m.level).length;
  return {targets:pending.filter((m:any)=>!m.level),exclusions:new Map(high?[['上层摘要',high]]:[])};
}, retainRecoveredSummaries: mocks.recover }));
vi.mock('@/memory/engine', async () => ({ engineState: (await import('vue')).reactive({ running: false }) }));
vi.mock('@/memory/apply', () => ({ editLeafAt: vi.fn(), editSummary: vi.fn(), getLeaf: vi.fn() }));
vi.mock('./ModalMask.vue', () => ({ default: defineComponent({ props: ['open'], setup: (p, { slots }) => () => p.open ? h('section', slots.default?.()) : null }) }));
vi.mock('./ConfirmDialog.vue', () => ({ default: defineComponent({ props: ['open', 'title', 'busy', 'confirmText'], emits: ['confirm', 'update:open'], setup: (p, { slots, emit }) => () => p.open ? h('section', { role: 'dialog' }, [h('h3', p.title), slots.default?.(), h('button', { onClick: () => emit('update:open', false) }, '取消'), h('button', { disabled: p.busy, onClick: () => emit('confirm') }, p.confirmText)]) : null }) }));
vi.mock('./TableTextField.vue', () => ({ default: defineComponent({ render: () => h('textarea') }) }));
import Panel from './SummaryReviewPanel.vue';
import { dailyState } from '@/mnemosyne/bridge';
const descriptor = parse(readFileSync(new URL('./SummaryReviewPanel.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'summary-review-test' }).bindings;
const code = compileTemplate({ source: descriptor.template!.content, filename: 'SummaryReviewPanel.vue', id: 'summary-review-test', compilerOptions: { bindingMetadata: bindings } }).code;
(Panel as any).render = new Function('Vue', code.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render'))({ ...Vue, vModelText: {} });
interface Node { type: string; text: string; props: Record<string, any>; children: Node[]; parent?: Node }
const make = (type: string, text = ''): Node => ({ type, text, props: {}, children: [] });
const renderer = createRenderer<Node, Node>({ createElement: type => make(type), createText: text => make('text', text), createComment: text => make('comment', text), setText: (n, t) => { n.text = t; }, setElementText: (n, t) => { n.text = t; n.children = []; }, patchProp: (n, key, _, value) => { n.props[key] = value; }, insert: (n, p, anchor) => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = p; const i = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(i < 0 ? p.children.length : i, 0, n); }, remove: n => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); }, parentNode: n => n.parent ?? null, nextSibling: n => { const siblings = n.parent?.children ?? []; return siblings[siblings.indexOf(n) + 1] ?? null; } });
const nodes = (n: Node): Node[] => [n, ...n.children.flatMap(nodes)];
const content = (n: Node): string => n.text + n.children.map(content).join('');
const button = (root: Node, label: string) => nodes(root).find(n => n.type === 'button' && content(n).includes(label))!;
const apps: ReturnType<typeof renderer.createApp>[] = [];
function mount() { const root = make('root'), app = renderer.createApp(Panel); app.provide(ssrContextKey, {}); app.mount(root); apps.push(app); return root; }
async function flush() { await nextTick(); await nextTick(); await nextTick(); }
function result(count = 155, recovery = true) {
  const memories = Array.from({ length: count }, (_, i) => ({ id: `memory-${i}`, owner: `owner-${i}`, hostId: `leaf-${i}`, level: 0, content: `摘要${i}：` + '合成摘要正文'.repeat(2_000), ...(recovery ? { sourceRecovery: { reason: 'missing_basis' } } : {}) }));
  return { view: { branch: { id: 'branch', head: 'head', view: 'view', epoch: 1 }, memories, refs: [] }, validity: new Map(memories.map(m => [m.id, 'needs_review'])), host: 'host', generation: 1, lib: {} } as any;
}
beforeEach(() => { Object.assign(dailyState, { generation: 1, revision: 1, scope: 'scope', review: 155, pending: false }); mocks.read.mockReset().mockResolvedValue(result()); mocks.host.mockClear(); mocks.keep.mockReset(); mocks.recover.mockReset().mockResolvedValue({}); mocks.current.mockReset().mockResolvedValue(true); mocks.sync.mockReset(); });
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); vi.restoreAllMocks(); });
test('155 review summaries mount no collapsed rows; pagination stays at ten and does not reread the host', async () => {
  const root = mount(); await flush();
  expect(nodes(root).filter(n => n.type === 'article')).toHaveLength(0);
  const detail = nodes(root).find(n => n.type === 'details')!;
  detail.props.onToggle({ target: { open: true } }); await flush();
  expect(nodes(root).filter(n => n.type === 'article')).toHaveLength(10);
  expect(content(root).length).toBeLessThan(7_000);
  const reads = mocks.read.mock.calls.length, hashes = mocks.host.mock.calls.length;
  for (let page = 0; page < 14; page++) { button(root, '下一页').props.onClick(); await flush(); expect(nodes(root).filter(n => n.type === 'article')).toHaveLength(10); }
  button(root, '下一页').props.onClick(); await flush(); expect(nodes(root).filter(n => n.type === 'article')).toHaveLength(5);
  expect(mocks.read).toHaveBeenCalledTimes(reads); expect(mocks.host).toHaveBeenCalledTimes(hashes);
});
test('successive archive revisions coalesce review reads while one read is pending', async () => {
  let resolve!: (value: any) => void;
  mocks.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mount(); await flush();
  for (let i = 0; i < 4; i++) { dailyState.revision++; await flush(); }
  expect(mocks.read).toHaveBeenCalledTimes(1);
  resolve(result()); await flush();
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
test('archive pending defers review reads until completion and a chat switch drops the old rows', async () => {
  dailyState.pending = true;
  const root = mount(); await flush(); expect(mocks.read).not.toHaveBeenCalled();
  dailyState.pending = false; await flush(); expect(mocks.read).toHaveBeenCalledOnce();
  button(root, '核对并保留 155').props.onClick(); await flush(); expect(content(root)).toContain('人工确认并保留摘要');
  dailyState.scope = 'other'; dailyState.generation++; dailyState.pending = true; await flush();
  expect(nodes(root).some(n => n.props.role === 'dialog')).toBe(false);
  expect(content(root)).not.toContain('155 条摘要待确认');
});
async function settleAction() { await new Promise(resolve => setTimeout(resolve, 5)); await flush(); }
test('bulk recovery is explicit, count-bounded and double confirmation writes only once', async () => {
  const fixture = result(); fixture.view.memories.push({ id: 'high', content: '高层', level: 1, sourceRecovery: {} }); fixture.validity.set('high', 'needs_review');
  mocks.read.mockResolvedValue(fixture);
  const root = mount(); await flush();
  expect(content(root)).toContain('其中 1 条无法在逐楼批次');
  expect(content(root)).toContain('上层摘要：1 条');
  button(root, '核对并保留 155').props.onClick(); await flush();
  expect(mocks.recover).not.toHaveBeenCalled(); expect(content(root)).toContain('不调用模型');
  expect(content(root)).toContain('旧生成时引用的摘要和来源保留在旧版本中');
  const confirm = button(root, '已核对，保留这些摘要'); confirm.props.onClick(); confirm.props.onClick(); await settleAction();
  expect(mocks.recover).toHaveBeenCalledOnce();
  expect(mocks.recover.mock.calls[0][1]).toHaveLength(155); expect(mocks.recover.mock.calls[0][1]).not.toContain('high');
  expect(mocks.keep).not.toHaveBeenCalled(); expect(content(root)).toContain('已人工确认并保留 155');
});
test.each([0,24])('bulk review includes ordinary L0 rows with %s recovered rows but excludes valid and high summaries',async recoveryCount=>{
  const fixture=result(156,false);
  for(let i=0;i<recoveryCount;i++) fixture.view.memories[i].sourceRecovery={reason:'missing_basis'};
  fixture.validity.set('memory-155','valid');
  fixture.view.memories.push({id:'high',content:'higher summary',level:1});fixture.validity.set('high','needs_review');
  mocks.read.mockResolvedValue(fixture);const root=mount();await flush();
  expect(content(root)).toContain('156 条摘要待确认');expect(content(root)).toContain('其中 1 条无法在逐楼批次');
  button(root,'核对并保留 155').props.onClick();await flush();expect(mocks.recover).not.toHaveBeenCalled();
  button(root,'已核对，保留这些摘要').props.onClick();await settleAction();
  expect(mocks.recover).toHaveBeenCalledOnce();expect(mocks.recover.mock.calls[0][1]).toHaveLength(155);
  expect(mocks.recover.mock.calls[0][1]).not.toContain('memory-155');expect(mocks.recover.mock.calls[0][1]).not.toContain('high');
  expect(mocks.keep).not.toHaveBeenCalled();
});
test('a remaining ordinary high-level queue retains its original strict keep workflow',async()=>{
  const fixture=result(2,false);fixture.view.memories.forEach((m:any)=>{m.level=1;});mocks.read.mockResolvedValue(fixture);
  const root=mount();await flush();button(root,'保留全部现有摘要').props.onClick();await settleAction();
  expect(content(root)).toContain('上层摘要：2 条');
  expect(mocks.keep).toHaveBeenCalledWith(expect.anything(),fixture.view,['memory-0','memory-1'],expect.any(Function));
  expect(mocks.recover).not.toHaveBeenCalled();
});
test('single recovery opens the same explicit dialog and cancel makes no write', async () => {
  const root = mount(); await flush();
  nodes(root).find(n => n.type === 'details')!.props.onToggle({ target: { open: true } }); await flush();
  const keep = button(root, '核对并保留此摘要'); expect(keep.props.disabled).toBe(false);
  keep.props.onClick(); await flush(); expect(content(root)).toContain('选定的 1 条逐楼摘要');
  button(root, '取消').props.onClick(); await flush(); expect(mocks.recover).not.toHaveBeenCalled();
  keep.props.onClick(); await flush(); button(root, '已核对，保留这些摘要').props.onClick(); await settleAction();
  expect(mocks.recover).toHaveBeenCalledWith(expect.anything(), ['memory-0'], expect.any(Function));
});
test('a changed source rejects confirmation and keeps the actionable error after reload', async () => {
  const root = mount(); await flush(); button(root, '核对并保留 155').props.onClick(); await flush();
  mocks.current.mockResolvedValue(false);
  button(root, '已核对，保留这些摘要').props.onClick(); await settleAction();
  expect(mocks.recover).not.toHaveBeenCalled(); expect(content(root)).toContain('聊天或摘要已改变，请重新核对');
});
test('cancel during asynchronous revalidation revokes that exact confirmation session', async () => {
  const root = mount(); await flush(); button(root, '核对并保留 155').props.onClick(); await flush();
  let resolve!: (value: boolean) => void; mocks.current.mockImplementation(() => new Promise(done => { resolve = done; }));
  button(root, '已核对，保留这些摘要').props.onClick(); await settleAction();
  button(root, '取消').props.onClick(); resolve(true); await settleAction();
  expect(mocks.recover).not.toHaveBeenCalled();
});
