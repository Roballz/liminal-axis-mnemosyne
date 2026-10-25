import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { parse } from 'vue/compiler-sfc';
import * as Vue from 'vue';
import ts from 'typescript';
import { createNodeFloorIndex, selectViewNodes } from '@/memory/select';
import { compactTimeLabel, formatRange } from '@/memory/timeTag';
import { eventPending } from '@/mnemosyne/manual-events';

const source = (name: string) => parse(readFileSync(new URL(name, import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
function slice(code: string, start: string, end: string) {
  const a = code.indexOf(start), b = code.indexOf(end, a);
  if (a < 0 || b < 0) throw Error(`UI probe markers missing: ${start}`);
  return code.slice(a, b);
}
function execute(code: string, deps: Record<string, unknown>, result: string) {
  return new Function('deps', `const {${Object.keys(deps).join(',')}}=deps;\n${ts.transpile(code, { target: ts.ScriptTarget.ES2022 })}\nreturn {${result}};`)(deps);
}
afterEach(() => vi.restoreAllMocks());

test('table search skips serialization when empty and reuses normalized data across keystrokes', () => {
  const rows = Vue.shallowRef(Array.from({ length: 200 }, (_, i) => ({ id: String(i), values: { value: `row ${i}` }, hidden: i === 0 })));
  const search = Vue.ref(''), showHidden = Vue.ref(false);
  const code = slice(source('./tables/index.vue'), 'const searchRows =', 'const shown =');
  const page = execute(code, { computed: Vue.computed, rows, search, showHidden }, 'filtered');
  const serialized = vi.spyOn(JSON, 'stringify');
  expect(page.filtered.value).toHaveLength(199); expect(serialized).not.toHaveBeenCalled();
  search.value = 'row 1'; expect(page.filtered.value).toHaveLength(111); expect(serialized).toHaveBeenCalledTimes(200);
  serialized.mockClear(); search.value = 'row 19'; expect(page.filtered.value).toHaveLength(11);
  showHidden.value = true; void page.filtered.value; expect(serialized).not.toHaveBeenCalled();
  rows.value = rows.value.map(row => row.id === '19' ? { ...row, values: { value: 'updated' } } : row);
  expect(page.filtered.value).toHaveLength(10); expect(serialized).toHaveBeenCalledTimes(200);
  search.value = ''; expect(page.filtered.value).toHaveLength(200);
});

test('summary search caches whole-forest range/text work and observes in-place child-list edits', () => {
  const code = source('./summary/index.vue');
  const program = slice(code, 'const byId =', '/* ---- 视图态:') + '\n' + slice(code, 'const searchableRows =', '/** 平铺视图行:');
  const derivedMeta = Vue.reactive({ leaves: Array.from({ length: 300 }, (_, i) => ({ id: `leaf-${i}`, stale: false,
    text: `Synthetic leaf ${i}`, createdAt: i, msgIndex: i, active: true })) });
  const memory = Vue.reactive({ summaries: Array.from({ length: 299 }, (_, i) => ({ id: `comp-${i}`, level: 1,
    text: `Synthetic compression ${i}`, createdAt: i, childIds: i ? [`comp-${i - 1}`, `leaf-${i + 1}`] : ['leaf-0', 'leaf-1'] })) });
  const searchQuery = Vue.ref('synthetic');
  const page = execute(program, { computed: Vue.computed, derivedMeta, memory, searchQuery,
    createNodeFloorIndex, selectViewNodes, compactTimeLabel, formatRange }, 'byId,buildSearchRows');
  const map = page.byId.value, get = vi.spyOn(map, 'get');
  expect(page.buildSearchRows()).toHaveLength(599);
  expect(get.mock.calls.length).toBeLessThan(3_000);
  get.mockClear();
  const normalize = vi.spyOn(String.prototype, 'toLowerCase');
  const sort = vi.spyOn(Array.prototype, 'sort');
  searchQuery.value = 'leaf 299'; const matched = page.buildSearchRows();
  const normalized = [...normalize.mock.contexts].map(String);
  const sortCalls = sort.mock.calls.length;
  expect(matched).toHaveLength(1); expect(get).not.toHaveBeenCalled();
  expect(normalized.filter(text => text === 'leaf 299')).toHaveLength(1);
  expect(normalized.some(text => text.startsWith('Synthetic'))).toBe(false);
  expect(sortCalls).toBe(0);
  memory.summaries[0].childIds.push('leaf-299');
  searchQuery.value = '#299';
  expect(page.buildSearchRows().some((row: any) => row.id === 'comp-0')).toBe(true);
  expect(page.byId.value).not.toBe(map);
});

test('pending summary pagination retains the full action list and clamps after rows disappear', async () => {
  const code = slice(source('./summary/index.vue'), 'const pendingFloors =', 'const summarizingFloor =');
  const derivedMeta = Vue.reactive({ pendingFloors: Array.from({ length: 1000 }, (_, i) => i) });
  const scope = Vue.effectScope();
  try {
    const page = scope.run(() => execute(code, { computed: Vue.computed, ref: Vue.ref, watch: Vue.watch, derivedMeta },
      'pendingFloors,pendingPage,pendingPages,shownPendingFloors'))!;
    expect(page.pendingFloors.value).toHaveLength(1000); expect(page.shownPendingFloors.value).toHaveLength(40);
    expect(page.shownPendingFloors.value[0]).toBe(999);
    page.pendingPage.value = 24; expect(page.shownPendingFloors.value).toEqual(Array.from({ length: 40 }, (_, i) => 39 - i));
    derivedMeta.pendingFloors = [7]; await Vue.nextTick();
    expect(page.pendingPage.value).toBe(0); expect(page.shownPendingFloors.value).toEqual([7]);
  } finally { scope.stop(); }
});

test('event card interaction reuses pending states and mounts an initially bounded chain list', async () => {
  const code = slice(source('./events/index.vue'), 'const visibleCards =', 'let pressTimer:');
  const cards = Vue.shallowRef(Array.from({ length: 200 }, (_, i) => ({ chain: { id: `event-${i}`, archived: false },
    meta: { summarized: [] }, progress: [], members: Array.from({ length: 100 }, (_, j) => ({ memory: `memory-${j}` })) })));
  const archiveMode = Vue.ref(false), dailyState = Vue.reactive({ scope: 'first' }), pending = vi.fn(eventPending);
  const scope = Vue.effectScope();
  try {
    const page = scope.run(() => execute(code, { computed: Vue.computed, ref: Vue.ref, watch: Vue.watch, cards, archiveMode,
      dailyState, eventPending: pending }, 'shownCards,pendingById,cardLimit'))!;
    expect(page.shownCards.value).toHaveLength(40);
    for (let pass = 0; pass < 20; pass++) for (const card of page.shownCards.value) expect(page.pendingById.value.get(card.chain.id)).toBe(true);
    expect(pending).toHaveBeenCalledTimes(200);
    page.cardLimit.value += 40; expect(page.shownCards.value).toHaveLength(80);
    expect(page.pendingById.value.size).toBe(200); expect(pending).toHaveBeenCalledTimes(200);
    dailyState.scope = 'next'; await Vue.nextTick(); expect(page.shownCards.value).toHaveLength(40);
    archiveMode.value = true; expect(page.shownCards.value).toHaveLength(0);
  } finally { scope.stop(); }
});

test('event progress options use one memory/floor index and refresh when the same form reopens', () => {
  const code = slice(source('./events/index.vue'), 'const progressSources =', 'const overviewChars =');
  const memories = Array.from({ length: 1000 }, (_, i) => ({ id: `m-${i}`, anchor: `s-${i}`, storyTime: '', content: `Body ${i}` }));
  const refs = memories.map(memory => ({ message: memory.anchor }));
  const cards = Vue.shallowRef([{ chain: { id: 'chain' }, members: memories.map(memory => ({ memory: memory.id })) }]);
  const editing = Vue.ref(true), editId = Vue.ref('chain');
  const page = execute('let formView = initial;\n' + code, { computed: Vue.computed, cards, editing, editId, initial: { memories, refs } },
    'progressSources,changeForm: (value) => {formView=value}');
  const find = vi.spyOn(memories, 'find'), findIndex = vi.spyOn(refs, 'findIndex');
  expect(page.progressSources.value).toHaveLength(1000); expect(page.progressSources.value[999].label).toContain('#999');
  expect(find).not.toHaveBeenCalled(); expect(findIndex).not.toHaveBeenCalled();
  editing.value = false; void page.progressSources.value;
  page.changeForm({ memories: [{ ...memories[0], content: 'new draft source' }], refs: [refs[0]] });
  editing.value = true;
  expect(page.progressSources.value).toHaveLength(1); expect(page.progressSources.value[0].label).toContain('new draft source');
});

test('variable tree edits do not serialize hidden source, while mode switches and invalid JSON remain correct', async () => {
  const code = slice(source('./vars/index.vue'), "const editorMode =", '/* ============ 导入');
  const memory = { varTemplates: { chat: { json: { nested: { value: 0 } }, meaning: 'meaning', rule: 'rule' } } };
  const parseObj = (text: string) => { try { const value = JSON.parse(text || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
  const save = vi.fn();
  const scope = Vue.effectScope();
  try {
    const page = scope.run(() => execute(code, { ref: Vue.ref, watch: Vue.watch, memory, editorTier: Vue.ref('chat'), charAvailable: Vue.ref(false), parseObj,
      replaceVarsTemplate: save, refreshInjection: vi.fn(), toast: vi.fn(), TIER_META: { chat: { label: '聊天' } } },
      'editorTree,editorJson,editorMode,jsonError,switchMode,currentEditorJson,saveTemplate'))!;
    const stringify = vi.spyOn(JSON, 'stringify');
    for (let i = 1; i <= 20; i++) { page.editorTree.value.nested.value = i; await Vue.nextTick(); }
    expect(stringify).not.toHaveBeenCalled(); expect(page.currentEditorJson().nested.value).toBe(20);
    page.saveTemplate(); expect(save).toHaveBeenLastCalledWith('chat', { json: { nested: { value: 20 } }, meaning: 'meaning', rule: 'rule' });
    page.switchMode('source'); expect(stringify).toHaveBeenCalledTimes(1); expect(JSON.parse(page.editorJson.value).nested.value).toBe(20);
    page.editorJson.value = '{'; page.switchMode('tree'); expect(page.editorMode.value).toBe('source'); expect(page.jsonError.value).toContain('无效');
    page.saveTemplate(); expect(save).toHaveBeenCalledTimes(1); expect(page.jsonError.value).toContain('无效');
    page.editorJson.value = '{"nested":{"value":21}}'; page.switchMode('tree'); expect(page.editorTree.value.nested.value).toBe(21);
    expect(page.jsonError.value).toBe('');
    page.saveTemplate(); expect(save).toHaveBeenLastCalledWith('chat', { json: { nested: { value: 21 } }, meaning: 'meaning', rule: 'rule' });
  } finally { scope.stop(); }
});
