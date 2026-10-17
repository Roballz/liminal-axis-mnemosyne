import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, defineComponent, h, nextTick, ssrContextKey } from 'vue';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc';
import type { KnowledgeFile } from '@/memory/vector/knowledge';
const mocks = vi.hoisted(() => ({ database: 'synthetic-db', files: [] as KnowledgeFile[], list: vi.fn(), edit: vi.fn(),
  import: vi.fn(), read: vi.fn(), clear: vi.fn(), remove: vi.fn(), enable: vi.fn() }));
vi.mock('@/memory/vector/scope', () => ({ currentVectorDb: () => mocks.database }));
vi.mock('@/memory/vector/recall', () => ({ clearRecallInjection: mocks.clear }));
vi.mock('@/memory/vector/knowledge', () => ({
  knowledgeDebug: { status: '', hits: [] }, embeddingIdentity: () => 'profile',
  listKnowledge: mocks.list, editKnowledge: mocks.edit, importKnowledge: mocks.import, readKnowledgeSource: mocks.read,
  deleteKnowledge: mocks.remove, setKnowledgeEnabled: mocks.enable,
  knowledgeText: (file: KnowledgeFile) => file.sourceText ?? file.chunks.join(`\n${file.delimiter}\n`),
}));
vi.mock('./ModalMask.vue', () => ({ default: defineComponent({ props: ['open'], setup: (props, { slots }) => () => props.open ? h('div', slots.default?.()) : null }) }));
import Panel from './KnowledgePanel.vue';
import { apiSettings } from '@/api/settings';
const descriptor = parse(readFileSync(new URL('./KnowledgePanel.vue', import.meta.url), 'utf8')).descriptor;
const bindings = compileScript(descriptor, { id: 'knowledge-test' }).bindings;
const template = compileTemplate({ source: descriptor.template!.content, filename: 'KnowledgePanel.vue', id: 'knowledge-test', compilerOptions: { bindingMetadata: bindings } }).code;
const renderCode = template.replace(/import \{([^}]+)\} from "vue"/g, (_, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render');
// A tiny renderer covers the actual SFC; the value directive records textarea/input model values.
const model = { mounted: (el: Node, binding: any) => { el.props.value = binding.value; }, updated: (el: Node, binding: any) => { el.props.value = binding.value; } };
(Panel as any).render = new Function('Vue', renderCode)({ ...Vue, vModelText: model, vModelCheckbox: {}, vModelSelect: {} });
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
const button = (root: Node, label: string) => nodes(root).find(n => n.type === 'button' && text(n).trim() === label)!;
const field = (root: Node) => nodes(root).find(n => n.type === 'textarea')!;
const form = (root: Node) => nodes(root).find(n => n.type === 'form')!;
const flush = async () => { await nextTick(); await Promise.resolve(); await nextTick(); };
const apps: ReturnType<typeof renderer.createApp>[] = [];
async function mount() { const root = make('root'), app = renderer.createApp(Panel); app.provide(ssrContextKey, {}); app.mount(root); apps.push(app); await flush(); return { root, app }; }
async function open(root: Node) { await button(root, '编辑').props.onClick({ currentTarget: { focus: vi.fn() } }); await flush(); }
const submit = (root: Node) => form(root).props.onSubmit({ preventDefault: vi.fn() });
const raw = '  # 合成原文\r\n\r\n===\r\n BB \r\n';
beforeEach(() => {
  mocks.database = 'synthetic-db';
  mocks.files = [{ id: 'doc', database: mocks.database, name: 'synthetic.md', delimiter: '===', chunks: ['# 合成原文', 'BB'],
    sourceVersion: 1, sourceText: raw, enabled: true, embedding: 'profile', revision: 'r1' }];
  mocks.list.mockReset().mockImplementation(async () => mocks.files);
  mocks.edit.mockReset().mockImplementation(async (file: KnowledgeFile, sourceText: string) => {
    mocks.files = [{ ...file, sourceText, revision: 'r2', embedding: 'profile', indexError: '' }]; return mocks.files[0];
  });
  mocks.import.mockReset().mockResolvedValue(mocks.files[0]); mocks.read.mockReset().mockResolvedValue({ text: raw, chunks: ['# 合成原文', 'BB'] });
  mocks.clear.mockClear(); mocks.remove.mockReset(); mocks.enable.mockReset();
  apiSettings.vector.knowledge.delimiter = '===';
});
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('编辑按钮位于停用和导出之间，原文完整显示，取消不保存不向量化', async () => {
  const { root } = await mount();
  const labels = nodes(root).filter(n => n.type === 'button').map(text);
  expect(labels.slice(labels.indexOf('停用'), labels.indexOf('删除') + 1)).toEqual(['停用', '编辑', '导出文本', '删除']);
  await open(root); expect(field(root).props.value).toBe(raw);
  expect(form(root).props['aria-modal']).toBe('true');
  expect(text(root)).not.toContain('旧版文件未保存');
  field(root).props['onUpdate:modelValue']('尚未保存'); await flush();
  button(root, '取消').props.onClick(); await flush();
  expect(field(root)).toBeUndefined(); expect(mocks.edit).not.toHaveBeenCalled();
  expect(mocks.files[0].sourceText).toBe(raw);
  await open(root); expect(field(root).props.value).toBe(raw);
});

test('旧版文档使用分隔符还原全文并明确提示不是原始空白格式', async () => {
  delete mocks.files[0].sourceText; delete mocks.files[0].sourceVersion;
  const { root } = await mount(); await open(root);
  expect(field(root).props.value).toBe('# 合成原文\n===\nBB');
  expect(text(root)).toContain('旧版文件未保存导入原文');
  expect(text(root)).toContain('原始空白和换行格式无法恢复');
});

test('保存全文而非预览块，完成后关闭弹窗且清除召回注入', async () => {
  const { root } = await mount(); await open(root);
  const edited = 'BB\n===\n第三块'; field(root).props['onUpdate:modelValue'](edited); await flush();
  await submit(root); await flush();
  expect(mocks.edit).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc', database: 'synthetic-db', delimiter: '===' }), edited, expect.any(AbortSignal), expect.any(Function));
  expect(form(root)).toBeUndefined(); expect(text(root)).toContain('正文已保存并完成重新向量化'); expect(mocks.clear).toHaveBeenCalled();
});

test('保存期间禁止重复提交或取消，失败保留草稿和准确版本供重试，不假报成功', async () => {
  let fail!: (e: Error) => void;
  mocks.edit.mockImplementationOnce(async (file: KnowledgeFile, sourceText: string) => {
    mocks.files = [{ ...file, sourceText, embedding: '', revision: 'failed', indexError: 'service failed' }];
    return new Promise((_, reject) => { fail = reject; });
  });
  const { root } = await mount(); await open(root);
  field(root).props['onUpdate:modelValue']('BB 修改'); await flush();
  const saving = submit(root); await flush();
  expect(button(root, '取消').props.disabled).toBe(true); expect(field(root).props.disabled).toBe(true);
  button(root, '取消').props.onClick(); await submit(root); expect(mocks.edit).toHaveBeenCalledOnce();
  fail(new Error('service failed')); await saving; await flush();
  expect(field(root).props.value).toBe('BB 修改'); expect(text(root)).toContain('保存或向量化未完成');
  expect(text(root)).not.toContain('正文已保存并完成重新向量化'); expect(button(root, '取消').props.disabled).toBe(false);
  await submit(root); await flush();
  expect(mocks.edit.mock.calls[1][0]).toMatchObject({ revision: 'failed', embedding: '' });
  expect(form(root)).toBeUndefined(); expect(text(root)).not.toContain('service failed');
});

test('无变更保存说明不重新向量化，切换角色后拒绝保存到错误角色', async () => {
  const { root } = await mount(); await open(root); await submit(root); await flush();
  expect(text(root)).toContain('正文未变化，无需重新向量化');
  await open(root); mocks.database = 'another-role'; await submit(root); await flush();
  expect(text(root)).toContain('角色已切换，请取消后刷新文件'); expect(mocks.edit).toHaveBeenCalledOnce();
});

test('分隔符输入直接写入现有设置，重新挂载保留；导入传入未裁剪全文', async () => {
  const first = await mount();
  const input = nodes(first.root).find(n => n.type === 'label' && text(n).includes('独占一行'))!.children.find(n => n.type === 'input')!;
  input.props['onUpdate:modelValue'](' ✦ '); await flush(); expect(apiSettings.vector.knowledge.delimiter).toBe(' ✦ ');
  first.app.unmount(); apps.splice(apps.indexOf(first.app), 1);
  const { root } = await mount();
  const reloaded = nodes(root).find(n => n.type === 'label' && text(n).includes('独占一行'))!.children.find(n => n.type === 'input')!;
  expect(reloaded.props.value).toBe(' ✦ ');
  const picker = nodes(root).find(n => n.type === 'input' && n.props.type === 'file')!;
  await picker.props.onChange({ target: { files: [new File([raw], 'new.md')], value: '' } }); await flush();
  await button(root, '确认导入并向量化').props.onClick(); await flush();
  expect(mocks.import).toHaveBeenCalledWith('synthetic-db', 'new.md', ' ✦ ', raw, expect.any(AbortSignal), expect.any(Function));
});

test('导出使用完整原文；空列表无文档操作；编辑框允许纵向拖动，保存色块独立于无色取消', async () => {
  let downloaded: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { downloaded = blob as Blob; return 'blob:synthetic'; });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  const { root } = await mount(); button(root, '导出文本').props.onClick(); expect(await downloaded!.text()).toBe(raw);
  mocks.files = []; await button(root, '刷新当前角色文件').props.onClick(); await flush();
  expect(button(root, '编辑')).toBeUndefined();
  const css = compileStyle({ source: descriptor.styles[0].content, filename: 'KnowledgePanel.vue', id: 'knowledge-test', scoped: true });
  expect(css.errors).toEqual([]);
  expect(css.code).toContain('resize: vertical'); expect(css.code).toContain('overflow: auto');
  expect(css.code).toContain('min(760px, calc(100vw - 28px))');
  expect(css.code).toContain('background: #8ca8b3'); expect(css.code).toContain('border: 2px solid #a9cbd3');
  expect(css.code).toContain('color: #17272d'); expect(css.code).toContain('background: transparent');
});
