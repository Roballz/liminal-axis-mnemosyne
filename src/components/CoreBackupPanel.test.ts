import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, ssrContextKey } from 'vue';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
const mocks = vi.hoisted(() => ({ inventory: vi.fn(), connect: vi.fn(), configure: vi.fn() }));
vi.mock('@/mnemosyne/core-backup-runtime', async importOriginal => ({
    ...await importOriginal<typeof import('@/mnemosyne/core-backup-runtime')>(),
    getCoreBackups: mocks.connect, configureCoreBackups: mocks.configure,
}));
vi.mock('@/mnemosyne/bridge', async () => ({
    dailyState: (await import('vue')).reactive({ pending: false, error: '', conflict: false, tableError: '', generation: 0, revision: 0, tableRevision: 0 }),
    invalidateDaily: vi.fn(), syncDaily: vi.fn(), serializeDailyActivation: vi.fn(),
}));
vi.mock('./BbsSelect.vue', () => ({ default: defineComponent({ setup: () => () => h('select') }) }));
import Panel from './CoreBackupPanel.vue';
import { dailyState } from '@/mnemosyne/bridge';
import { BACKUP_WAITING_STATUS, coreBackupState } from '@/mnemosyne/core-backup-runtime';
// Render the actual SFC template against a small in-memory host, as in the other UI suites.
const descriptor = parse(readFileSync(new URL('./CoreBackupPanel.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'backup-test' }).bindings;
const template = compileTemplate({ source: descriptor.template!.content, filename: 'CoreBackupPanel.vue', id: 'backup-test', compilerOptions: { bindingMetadata: bindings } }).code;
const renderCode = template.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render');
(Panel as any).render = new Function('Vue', renderCode)({ ...Vue, vModelSelect: {} });
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
beforeEach(() => {
    mocks.inventory.mockReset().mockResolvedValue({ entries: [], invalid: [] });
    mocks.connect.mockReset().mockResolvedValue({ inventory: mocks.inventory }); mocks.configure.mockReset();
    Object.assign(coreBackupState, { available: true, enabled: true, keep: 20, busy: false, status: BACKUP_WAITING_STATUS, error: '', lastSavedAt: 0 });
    Object.assign(dailyState, { pending: false, error: '', conflict: false, tableError: '' });
    vi.stubGlobal('localStorage', { getItem: () => null });
});
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); vi.unstubAllGlobals(); });
test('empty inventory reads show progress and success without claiming a write or treating the initial list as empty', async () => {
    dailyState.pending = true; dailyState.error = '摘要基线缺失';
    let finish!: (value: any) => void;
    mocks.inventory.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { root } = mount();
    expect(text(root)).toContain('备份数量未知'); expect(text(root)).not.toContain('已验证 0 份');
    expect(text(root)).toContain('归档未完成：摘要基线缺失');
    expect(button(root, '手动保存').props.disabled).toBe(true);
    const load = button(root, '读取备份列表'), operation = load.props.onClick();
    await nextTick(); await nextTick();
    expect(text(root)).toContain('正在连接原生接口并读取备份列表');
    expect(button(root, '正在读取备份列表').props.disabled).toBe(true);
    await load.props.onClick(); expect(mocks.inventory).toHaveBeenCalledOnce();
    finish({ entries: [], invalid: [] }); await operation; await nextTick();
    expect(text(root)).toContain('接口读取成功（'); expect(text(root)).toContain('已验证 0 份');
    expect(text(root)).toContain('当前没有已验证的可恢复备份');
    expect(text(root)).not.toContain('正在连接'); expect(text(root)).not.toContain('自动磁盘备份已写入');
    expect(coreBackupState.status).toBe(BACKUP_WAITING_STATUS); expect(coreBackupState.lastSavedAt).toBe(0);
    expect(button(root, '读取备份列表').props.disabled).toBe(false);
});
test('archive blockers and recovery update immediately without a scheduler tick', async () => {
    const { root } = mount();
    dailyState.pending = true; await nextTick();
    expect(text(root)).toContain('自动备份已启用，当前暂缓'); expect(text(root)).toContain('等待当前聊天归档完成');
    dailyState.error = '摘要基线缺失'; await nextTick(); expect(text(root)).toContain('归档未完成：摘要基线缺失');
    dailyState.error = ''; dailyState.conflict = true; await nextTick(); expect(text(root)).toContain('档案绑定冲突');
    dailyState.conflict = false; dailyState.tableError = '填表待处理'; await nextTick(); expect(text(root)).toContain('表格处理未完成：填表待处理');
    dailyState.pending = false; dailyState.tableError = ''; await nextTick();
    expect(text(root)).toContain(BACKUP_WAITING_STATUS); expect(text(root)).not.toContain('自动备份暂缓');
    dailyState.error = '其他错误'; coreBackupState.enabled = false; coreBackupState.status = '自动备份已关闭，旧文件保留'; await nextTick();
    expect(text(root)).not.toContain('自动备份暂缓'); expect(text(root)).toContain('自动备份已关闭');
});
test('checking inventory preserves actual save errors and earlier successful-save status', async () => {
    dailyState.pending = true; dailyState.error = '摘要基线缺失';
    Object.assign(coreBackupState, { status: '自动备份暂停，旧备份保留', error: '磁盘读取失败' });
    const { root } = mount();
    await button(root, '读取备份列表').props.onClick(); await nextTick();
    expect(text(root)).toContain('接口读取成功'); expect(text(root)).toContain('自动备份暂停，旧备份保留');
    expect(nodes(root).filter(n => n.props.role === 'alert').map(text)).toContain('磁盘读取失败');
    Object.assign(coreBackupState, { status: '自动磁盘备份已写入并读回验证', error: '', lastSavedAt: 1234 }); await nextTick();
    expect(text(root)).toContain('自动磁盘备份已写入并读回验证'); expect(text(root)).toContain('归档未完成：摘要基线缺失');
    expect(coreBackupState.lastSavedAt).toBe(1234);
});
test('failed reads expose the error, release controls and never advertise an unread empty list', async () => {
    mocks.inventory.mockRejectedValue(new Error('原生目录读取失败'));
    const { root } = mount(); await button(root, '读取备份列表').props.onClick(); await nextTick();
    expect(text(root)).toContain('原生目录读取失败'); expect(text(root)).toContain('备份数量未知');
    expect(text(root)).not.toContain('接口读取成功'); expect(text(root)).not.toContain('正在连接');
    expect(button(root, '读取备份列表').props.disabled).toBe(false);
    mocks.inventory.mockResolvedValue({ entries: [], invalid: [{ key: 'bad', error: 'checksum' }] });
    await button(root, '读取备份列表').props.onClick(); await nextTick();
    expect(text(root)).toContain('1 份文件无法验证，未删除'); expect(text(root)).toContain('当前没有已验证的可恢复备份');
    expect(text(root)).not.toContain('原生目录读取失败');
});
test('late inventory completion after unmount cannot publish a result into a reopened panel', async () => {
    let finish!: (value: any) => void;
    mocks.inventory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = mount(), operation = button(first.root, '读取备份列表').props.onClick();
    await nextTick(); first.app.unmount(); apps.splice(apps.indexOf(first.app), 1);
    const second = mount(); expect(button(second.root, '读取备份列表').props.disabled).toBe(true);
    finish({ entries: [], invalid: [] }); await operation; await nextTick();
    expect(text(second.root)).toContain('备份数量未知'); expect(text(second.root)).not.toContain('接口读取成功');
    expect(button(second.root, '读取备份列表').props.disabled).toBe(false);
});

test('panel advertises fixed 20 retention, no deletion packages and qualified coverage', async () => {
    const { root } = mount();
    expect(text(root)).toContain('固定保留最近 20 份');
    expect(text(root)).toContain('不再额外备份'); expect(text(root)).toContain('不保证连续覆盖最近 10 小时');
    expect(text(root)).toContain('已有历史保护包仍保留');
    expect(text(root)).not.toContain('保护旧包并接受当前档案'); expect(text(root)).not.toContain('重试删除前保护');
    expect(nodes(root).some(n => n.type === 'option' && ['5', '10'].includes(String(n.props.value)))).toBe(false);
});
