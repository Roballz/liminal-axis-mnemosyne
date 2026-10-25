import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, ssrContextKey } from 'vue';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
const mocks = vi.hoisted(() => ({ inventory: vi.fn(), connect: vi.fn(), configure: vi.fn(), preview: vi.fn(), hints: vi.fn(), save: vi.fn(), pin: vi.fn(), restore: vi.fn(), active: vi.fn() }));
vi.mock('@/mnemosyne/core-backup-runtime', async importOriginal => ({
    ...await importOriginal<typeof import('@/mnemosyne/core-backup-runtime')>(),
    getCoreBackups: mocks.connect, configureCoreBackups: mocks.configure, readCoreBackupPreview: mocks.preview,
    saveCoreBackup: mocks.save, pinCoreBackup: mocks.pin, restoreCoreBackup: mocks.restore,
}));
vi.mock('@/mnemosyne/db', async importOriginal => ({ ...await importOriginal<typeof import('@/mnemosyne/db')>(), activeLibrary: mocks.active }));
vi.mock('@/mnemosyne/bridge', async () => ({
    dailyState: (await import('vue')).reactive({ pending: false, error: '', conflict: false, tableError: '', generation: 0, revision: 0, tableRevision: 0 }),
    invalidateDaily: vi.fn(), syncDaily: vi.fn(), serializeDailyActivation: vi.fn(task => task()),
}));
vi.mock('./BbsSelect.vue', () => ({ default: defineComponent({ props: ['modelValue', 'options'], emits: ['update:modelValue'], setup: (props, { emit }) => () => h('select', { value: props.modelValue, onChange: (value: string) => emit('update:modelValue', value) }, props.options.map((option: any) => h('option', { value: option.value }, option.label))) }) }));
import Panel from './CoreBackupPanel.vue';
import { dailyState, invalidateDaily, syncDaily } from '@/mnemosyne/bridge';
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
    mocks.connect.mockReset().mockResolvedValue({ inventory: mocks.inventory, previewHints: mocks.hints, save: mocks.save, pin: mocks.pin, restore: mocks.restore }); mocks.configure.mockReset();
    mocks.save.mockReset().mockResolvedValue({ state: 'saved' }); mocks.pin.mockReset(); mocks.restore.mockReset(); mocks.active.mockReset().mockResolvedValue({ id: 'synthetic' });
    vi.mocked(syncDaily).mockClear(); vi.mocked(invalidateDaily).mockClear();
    mocks.preview.mockReset(); mocks.hints.mockReset().mockResolvedValue([]);
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
    expect(text(root)).toContain('备份数量未知'); expect(text(root)).not.toContain('找到 0 份');
    expect(text(root)).toContain('归档未完成：摘要基线缺失');
    expect(button(root, '手动保存').props.disabled).toBe(true);
    const load = button(root, '备份列表'), operation = load.props.onClick();
    await nextTick(); await nextTick();
    expect(text(root)).toContain('正在连接原生接口并读取备份列表');
    expect(button(root, '正在读取备份列表').props.disabled).toBe(true);
    await load.props.onClick(); expect(mocks.inventory).toHaveBeenCalledOnce();
    finish({ entries: [], invalid: [] }); await operation; await nextTick();
    expect(text(root)).toContain('已读取（'); expect(text(root)).toContain('找到 0 份');
    expect(text(root)).toContain('当前目录没有本功能识别的备份文件');
    expect(text(root)).not.toContain('正在连接'); expect(text(root)).not.toContain('自动磁盘备份已写入');
    expect(coreBackupState.status).toBe(BACKUP_WAITING_STATUS); expect(coreBackupState.lastSavedAt).toBe(0);
    expect(button(root, '备份列表').props.disabled).toBe(false);
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
    await button(root, '备份列表').props.onClick(); await nextTick();
    expect(text(root)).toContain('已读取（'); expect(text(root)).toContain('自动备份暂停，旧备份保留');
    expect(nodes(root).filter(n => n.props.role === 'alert').map(text)).toContain('磁盘读取失败');
    Object.assign(coreBackupState, { status: '自动磁盘备份已写入并读回验证', error: '', lastSavedAt: 1234 }); await nextTick();
    expect(text(root)).toContain('自动磁盘备份已写入并读回验证'); expect(text(root)).toContain('归档未完成：摘要基线缺失');
    expect(coreBackupState.lastSavedAt).toBe(1234);
});
test('failed reads expose the error, release controls and never advertise an unread empty list', async () => {
    mocks.inventory.mockRejectedValue(new Error('原生目录读取失败'));
    const { root } = mount(); await button(root, '备份列表').props.onClick(); await nextTick();
    expect(text(root)).toContain('原生目录读取失败'); expect(text(root)).toContain('备份数量未知');
    expect(text(root)).not.toContain('已读取（'); expect(text(root)).not.toContain('正在连接');
    expect(button(root, '备份列表').props.disabled).toBe(false);
    mocks.inventory.mockResolvedValue({ entries: [], invalid: [{ key: 'bad', error: 'checksum' }] });
    await button(root, '备份列表').props.onClick(); await nextTick();
    expect(text(root)).toContain('当前目录没有本功能识别的备份文件');
    expect(text(root)).not.toContain('原生目录读取失败');
});
test('late inventory completion after unmount cannot publish a result into a reopened panel', async () => {
    let finish!: (value: any) => void;
    mocks.inventory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = mount(), operation = button(first.root, '备份列表').props.onClick();
    await nextTick(); first.app.unmount(); apps.splice(apps.indexOf(first.app), 1);
    const second = mount(); expect(button(second.root, '备份列表').props.disabled).toBe(true);
    finish({ entries: [], invalid: [] }); await operation; await nextTick();
    expect(text(second.root)).toContain('备份数量未知'); expect(text(second.root)).not.toContain('已读取（');
    expect(button(second.root, '备份列表').props.disabled).toBe(false);
});

test('panel advertises fixed 20 retention, no deletion packages and qualified coverage', async () => {
    const { root } = mount();
    expect(text(root)).toContain('固定保留最近 20 份');
    expect(text(root)).toContain('不再额外备份'); expect(text(root)).toContain('不保证连续覆盖最近 10 小时');
    expect(text(root)).toContain('已有历史保护包仍保留');
    expect(text(root)).not.toContain('保护旧包并接受当前档案'); expect(text(root)).not.toContain('重试删除前保护');
    expect(nodes(root).some(n => n.type === 'option' && ['5', '10'].includes(String(n.props.value)))).toBe(false);
});

const listing = (key: string) => ({ key, kind: 'auto' as const, savedAt: 1_800_000_000_000, bank: '0123456789abcdef' });
const preview = (key: string, stories = 1) => ({ ...listing(key), snapshotAt: 1_800_000_000_000, sourceLibrary: 'mnemosyne_daily_test', bytes: 100,
    checksum: 'a'.repeat(64), counts: { stories, branches: 1, source_messages: 2, memories: 3, event_chains: 0, custom_table_rows: 0 } });
const select = async (root: Node, key: string) => { nodes(root).find(node => node.type === 'select')!.props.onChange(key); await nextTick(); await nextTick(); };
const flush = async () => { for (let i = 0; i < 8; i++) await nextTick(); };

test('filename list appears before optional metadata and does not verify any file', async () => {
    mocks.inventory.mockResolvedValue({ entries: [listing('old'), listing('new')] });
    let finish!: (value: any) => void;
    mocks.hints.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { root } = mount(); await button(root, '备份列表').props.onClick(); await nextTick();
    expect(text(root)).toContain('找到 2 份备份文件，尚未逐份校验');
    expect(text(root)).toContain('详情待读取'); expect(mocks.preview).not.toHaveBeenCalled();
    expect(button(root, '备份列表').props.disabled).toBe(false);
    finish([preview('new', 999), preview('missing-on-disk')]); await flush();
    expect(text(root)).toContain('999 故事'); expect(text(root)).toContain('缓存，待校验');
    expect(nodes(root).filter(node => node.type === 'option')).toHaveLength(3);
    expect(text(root)).not.toContain('完整校验通过'); expect(mocks.preview).not.toHaveBeenCalled();
});

test('only selected details are validated, changed choices discard late results, and actions require verified details', async () => {
    mocks.inventory.mockResolvedValue({ entries: [listing('first'), listing('second')] });
    const pending = new Map<string, { finish(value: any): void; current(): boolean }>();
    mocks.preview.mockImplementation((key, current) => new Promise(resolve => { pending.set(key, { finish: resolve, current }); }));
    const { root } = mount(); await button(root, '备份列表').props.onClick();
    await select(root, 'first');
    expect(mocks.preview).toHaveBeenCalledOnce(); expect(pending.get('first')!.current()).toBe(true);
    expect(text(root)).toContain('正在后台读取并校验所选备份');
    expect(button(root, '从这份核心包恢复').props.disabled).toBe(true);
    await select(root, 'second'); expect(pending.get('first')!.current()).toBe(false);
    pending.get('first')!.finish(preview('first', 999)); await flush();
    expect(text(root)).not.toContain('999 故事'); expect(button(root, '从这份核心包恢复').props.disabled).toBe(true);
    pending.get('second')!.finish(preview('second', 2)); await flush();
    expect(text(root)).toContain('2 故事'); expect(text(root)).toContain('所选备份完整校验通过');
    expect(button(root, '从这份核心包恢复').props.disabled).toBe(false);
    expect(button(root, '固定保留').props.disabled).toBe(false);
    await button(root, '备份列表').props.onClick(); await flush();
    expect(mocks.preview).toHaveBeenCalledTimes(2); // Refresh is directory-only, even with a selection.
    expect(button(root, '从这份核心包恢复').props.disabled).toBe(true);
});

test('failed metadata leaves old files visible; corrupt selected file cannot restore and can be retried', async () => {
    mocks.inventory.mockResolvedValue({ entries: [listing('old')] }); mocks.hints.mockRejectedValue(new Error('hint IO'));
    mocks.preview.mockRejectedValueOnce(new Error('校验和不匹配')).mockResolvedValueOnce(preview('old'));
    const { root } = mount(); await button(root, '备份列表').props.onClick(); await flush();
    expect(text(root)).toContain('预览元数据暂不可用'); expect(text(root)).toContain('找到 1 份备份文件');
    await select(root, 'old'); await flush();
    expect(text(root)).toContain('所选文件无法验证，未删除，也不能恢复');
    expect(button(root, '从这份核心包恢复').props.disabled).toBe(true);
    await button(root, '校验这份备份').props.onClick(); await flush();
    expect(text(root)).toContain('完整校验通过'); expect(text(root)).not.toContain('校验和不匹配');
});

test('unmounted detail validation cannot publish into a reopened panel', async () => {
    mocks.inventory.mockResolvedValue({ entries: [listing('old')] });
    let finish!: (value: any) => void, current!: () => boolean;
    mocks.preview.mockImplementation((_key, guard) => { current = guard; return new Promise(resolve => { finish = resolve; }); });
    const first = mount(); await button(first.root, '备份列表').props.onClick(); await select(first.root, 'old');
    first.app.unmount(); apps.splice(apps.indexOf(first.app), 1); expect(current()).toBe(false);
    const second = mount(); finish(preview('old')); await flush();
    expect(text(second.root)).toContain('备份数量未知'); expect(text(second.root)).not.toContain('完整校验通过');
});


test('settings, manual saving and file actions stay in named groups with safety notes collapsed', async () => {
    mocks.inventory.mockResolvedValue({ entries: [listing('auto')] }); mocks.preview.mockResolvedValue(preview('auto'));
    const { root } = mount();
    const group = (name: string) => nodes(root).find(node => node.props['aria-label'] === name)!;
    const settings = group('自动备份设置'), files = group('备份文件与恢复');
    expect(button(settings, '关闭自动备份')).toBeDefined(); expect(button(settings, '手动保存')).toBeDefined();
    expect(text(settings)).toContain('固定保留最近 20 份 · 间隔至少 30 分钟');
    expect(text(settings)).toContain('前台稳定'); expect(text(settings)).toContain('无变化不重复保存');
    expect(button(files, '读取备份列表')).toBeDefined(); expect(text(files)).toContain('保存路径：data_root/');
    expect(nodes(files).some(node => node.type === 'select')).toBe(true);
    expect(button(root, '重试自动备份')).toBeUndefined(); expect(button(root, '保护旧包')).toBeUndefined();
    expect(nodes(root).filter(node => node.type === 'select')).toHaveLength(1);
    const notes = nodes(root).find(node => node.type === 'details' && node.props.class === 'mn-backup-notes')!;
    expect(notes.props.open).toBeUndefined(); expect(nodes(notes).some(node => node.type === 'button')).toBe(false);
    expect(text(notes)).toContain('不含知识库、字体、向量、密钥或宿主聊天');
    expect(text(notes)).toContain('旧库不自动清理'); expect(text(root)).toContain('本机明文存储，不上传');
    await button(files, '备份列表').props.onClick(); await select(root, 'auto'); await flush();
    const detail = group('所选备份详情');
    expect(nodes(files)).toContain(detail); expect(text(detail)).toContain('文件路径：');
    expect(button(detail, '固定保留')).toBeDefined(); expect(button(detail, '从这份核心包恢复')).toBeDefined();
    expect(button(files, '刷新备份列表')).toBeDefined();
});

test('unavailable native access keeps the path, read action and actual failure visible', async () => {
    Object.assign(coreBackupState, { available: false, error: '宿主原生接口不可用' });
    const { root } = mount();
    expect(text(root)).toContain('保存路径：'); expect(button(root, '读取备份列表')).toBeDefined();
    expect(button(root, '关闭自动备份')).toBeUndefined(); expect(button(root, '手动保存')).toBeUndefined();
    const alert = nodes(root).find(node => node.props.role === 'alert')!;
    expect(text(alert)).toBe('宿主原生接口不可用');
    expect(alert.parent?.type).not.toBe('details');
});

test('toggle keeps the enable confirmation and fixed retention, while disabling needs no extra confirmation', async () => {
    const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal('confirm', confirm);
    coreBackupState.enabled = false;
    const { root } = mount(); await button(root, '启用自动备份').props.onClick();
    expect(confirm).toHaveBeenCalledOnce(); expect(confirm.mock.calls[0][0]).toContain('保留最近 20 份');
    expect(confirm.mock.calls[0][0]).toContain('永久删除'); expect(mocks.configure).not.toHaveBeenCalled();
    confirm.mockReturnValue(true); await button(root, '启用自动备份').props.onClick();
    expect(mocks.configure).toHaveBeenLastCalledWith(true, 20);
    coreBackupState.enabled = true; await nextTick(); await button(root, '关闭自动备份').props.onClick();
    expect(mocks.configure).toHaveBeenLastCalledWith(false, 20); expect(confirm).toHaveBeenCalledTimes(2);
});

test('manual action still confirms, saves a protected new baseline and refreshes only the file inventory', async () => {
    const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal('confirm', confirm);
    const { root } = mount(); await button(root, '手动保存').props.onClick();
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0][0]).toContain('旧备份保留');
    confirm.mockReturnValue(true); await button(root, '手动保存').props.onClick(); await flush();
    expect(mocks.save).toHaveBeenCalledWith({ id: 'synthetic' }, 'manual', 20, expect.any(Function));
    const valid = mocks.save.mock.calls[0][3]; expect(valid()).toBe(true);
    dailyState.pending = true; expect(valid()).toBe(false); await nextTick();
    expect(button(root, '手动保存').props.disabled).toBe(true);
    expect(text(root)).toContain('手动保护备份已写入并验证'); expect(mocks.inventory).toHaveBeenCalledOnce();
    expect(mocks.preview).not.toHaveBeenCalled();
});

test('pin and restore retain their verified-file arguments and busy or pending gates', async () => {
    mocks.inventory.mockResolvedValue({ entries: [listing('auto')] }); mocks.preview.mockResolvedValue(preview('auto'));
    mocks.pin.mockResolvedValue({ key: 'auto' }); vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const { root } = mount(); await button(root, '备份列表').props.onClick(); await select(root, 'auto'); await flush();
    coreBackupState.busy = true; await nextTick();
    for (const label of ['关闭自动备份', '手动保存', '备份列表', '固定保留', '从这份核心包恢复']) expect(button(root, label).props.disabled).toBe(true);
    coreBackupState.busy = false; dailyState.pending = true; await nextTick();
    expect(button(root, '从这份核心包恢复').props.disabled).toBe(true);
    dailyState.error = '归档失败'; await nextTick();
    expect(button(root, '从这份核心包恢复').props.disabled).toBe(false); expect(button(root, '重试归档')).toBeDefined();
    await button(root, '重试归档').props.onClick(); expect(syncDaily).toHaveBeenCalledOnce();
    dailyState.pending = false; dailyState.error = ''; await nextTick();
    await button(root, '从这份核心包恢复').props.onClick(); await flush();
    expect(mocks.save).toHaveBeenCalledWith({ id: 'synthetic' }, 'before-restore', 20, expect.any(Function));
    expect(mocks.restore).toHaveBeenCalledWith('auto', 'a'.repeat(64), expect.any(Function));
    expect(invalidateDaily).toHaveBeenCalledOnce(); expect(syncDaily).toHaveBeenCalledTimes(2);
    expect(button(root, '从这份核心包恢复').props.disabled).toBe(true); // Refresh revokes the verified details.
    await button(root, '校验这份备份').props.onClick(); await flush();
    await button(root, '固定保留').props.onClick(); await flush();
    expect(mocks.pin).toHaveBeenCalledWith('auto', 'a'.repeat(64), expect.any(Function)); expect(text(root)).toContain('不参与自动轮换');
});
