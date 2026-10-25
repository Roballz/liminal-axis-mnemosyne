import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import * as Vue from 'vue';
import { parse, compileTemplate } from 'vue/compiler-sfc';
import ts from 'typescript';
import { fixture, batchFixture, output } from './fixtures';
import { capture } from './canonical';
import { eventView, commitEventBatch } from './events';
import { eventMaterial, prepareEventMaterials } from './event-materials';
import { commitManualEvent } from './manual-events';
import { Library, Transaction } from './db';

const page = parse(readFileSync(new URL('../pages/events/index.vue', import.meta.url), 'utf8')).descriptor;
const template = page.template!.content;
const start = template.indexOf('    <details\n      v-for="card in shownCards"');
expect(start).toBeGreaterThan(-1);
const compiled = compileTemplate({ source: template.slice(start, template.indexOf('    <ModalMask', start)), filename: 'events-test.vue', id: 'test' });
expect(compiled.errors).toEqual([]);
const render = new Function('Vue', compiled.code.replace(/import \{([^}]+)\} from "vue"/g,
  (_, names: string) => `const {${names.replace(/ as /g, ': ')}} = Vue`).replace('export function render', 'return function render'))(Vue);
const script = page.scriptSetup!.content;
const stateStart = script.indexOf('const visibleCards ='), stateEnd = script.indexOf('let pressTimer:', stateStart);
expect(stateStart).toBeGreaterThan(-1); expect(stateEnd).toBeGreaterThan(stateStart);
const cardState = new Function('Vue', 'cards', 'archiveMode', 'dailyState', 'eventPending',
  `const {computed,ref,watch}=Vue;\n${ts.transpile(script.slice(stateStart, stateEnd), { target: ts.ScriptTarget.ES2022 })}
  return {visibleCards,shownCards,pendingById,cardLimit};`);

test('closed event cards, histories and member details never mount hidden full summaries', () => {
  const memories = Array.from({ length: 1000 }, (_, i) => ({ id: `memory-${i}`, content: `正文${i}:` + '长'.repeat(10000) }));
  const cards = Array.from({ length: 100 }, (_, i) => ({ chain: { id: `chain-${i}` },
    meta: { title: '合成事件', status: 'open', keywords: [], overview: '概要', latestProgress: null },
    members: memories.slice(i * 10, i * 10 + 10).map(m => ({ id: m.id, memory: m.id })) }));
  const byId = new Map(memories.map(m => [m.id, m.content]));
  const text = vi.fn((id: string) => byId.get(id));
  const scope = Vue.effectScope();
  const state = scope.run(() => cardState(Vue, Vue.shallowRef(cards), Vue.ref(false), Vue.reactive({ scope: 'fixture' }), () => false));
  const context = Vue.proxyRefs({ ...state, archiveMode: false, apiSettings: { ui: { showInternalIds: false } }, pages: {},
    expandedCards: {} as Record<string, boolean>, expandedHistory: {} as Record<string, boolean>, expandedMembers: {} as Record<string, boolean>,
    busy: false, jobState: { busy: false }, manualEventState: { busy: false }, membershipUi: { loading: false },
    statusName: () => '', eventCoverageUpgradeNeeded: () => false,
    eventOverview: (c: any) => c.meta.overview, members: (c: any) => c.members.slice(0, 10), text });
  const nodes = (node: any): any[] => !node || typeof node !== 'object' ? [] :
    [node, ...(Array.isArray(node.children) ? node.children.flatMap(nodes) : [])];
  const bodies = (node: any): number => !node || typeof node !== 'object' ? 0 :
    (typeof node.children === 'string' && node.children.length >= 10000 ? 1 : 0) +
    (Array.isArray(node.children) ? node.children.reduce((n: number, c: any) => n + bodies(c), 0) : 0);
  try {
    const first = render(context, []);
    const mountedCards = (node: any) => nodes(node).filter(n => n.type === 'details' && String(n.props?.class).includes('mn-event-card'));
    expect(mountedCards(first)).toHaveLength(40);
    expect(bodies(first)).toBe(0); expect(text).not.toHaveBeenCalled();
    nodes(first).find(n => n.type === 'button' && String(n.children).includes('显示更多事件')).props.onClick();
    expect(context.cardLimit).toBe(80); expect(mountedCards(render(context, []))).toHaveLength(80);
    expect(text).not.toHaveBeenCalled();
    context.expandedCards['chain-0'] = true;
    expect(bodies(render(context, []))).toBe(0); expect(text).not.toHaveBeenCalled();
    context.expandedHistory['chain-0'] = true;
    expect(bodies(render(context, []))).toBe(0); expect(text).toHaveBeenCalledTimes(10);
    text.mockClear(); context.expandedMembers['memory-0'] = true;
    expect(bodies(render(context, []))).toBe(1); expect(text).toHaveBeenCalledTimes(11);
  } finally { scope.stop(); }
});

test('event bodies resolve through the message index without scanning the chat source array', async () => {
  const { lib, view } = await fixture(80);
  const find = vi.spyOn(view.refs, 'find').mockImplementation(() => { throw new Error('linear scan'); });
  try {
    const refs = new Map(view.refs.map(r => [r.message, r])), represented = new Set<string>();
    const materials = view.memories.map(memory => eventMaterial(memory, view, refs, represented, 'both'));
    expect(materials).toHaveLength(80);
    expect(materials.every(m => m.sources[0]?.body?.includes('合成剧情'))).toBe(true);
    expect(find).not.toHaveBeenCalled();
    const stale = { ...view.memories[0], anchor: null, inputRefs: [{ message: 'missing', revision: view.refs[0].revision }] };
    expect(() => eventMaterial(stale, view, refs, new Set(), 'body')).toThrow('正文缺失');
  } finally { find.mockRestore(); lib.close(); }
});

test('material preparation yields to timers and accepts stop before processing the entire long chain', async () => {
  const { lib, view } = await fixture(80);
  try {
    for (const memory of view.memories) memory.content = '长'.repeat(10000);
    let active = true;
    const guard = vi.fn(() => active);
    const timer = setTimeout(() => { active = false; }, 0);
    const sourceReads = vi.spyOn(view.sources, 'get');
    try {
      await expect(prepareEventMaterials(view.memories, view, new Map(view.refs.map(r => [r.message, r])), new Set(), 'both', guard)).rejects.toThrow('准备已停止');
      expect(sourceReads.mock.calls.length).toBeGreaterThan(0);
      expect(sourceReads.mock.calls.length).toBeLessThan(80);
      expect(guard).toHaveBeenCalledTimes(2); // Before preparation and after the first real task yield, not per member.
    } finally { clearTimeout(timer); sourceReads.mockRestore(); }
  } finally { lib.close(); }
});

test('final overview commit validates memories without reprojecting every event history', async () => {
  const { lib, view } = await fixture(2);
  const reads = vi.spyOn(Transaction.prototype, 'all');
  try {
    await commitManualEvent(lib, view, null, view.memories.map(m => m.id), JSON.stringify({
      title: '合成事件', status: 'open', keywords: [], overview: '完整概要', progress: '', latestProgress: null,
    }), () => true);
    expect(reads.mock.calls.filter(([store]) => store.startsWith('event_'))).toEqual([]);
  } finally { reads.mockRestore(); lib.close(); }
});


test('single-chain projection reads only its own history and rejects a chain from another branch', async () => {
  const { lib, batch, branch } = await batchFixture(5);
  try {
    const out = output(batch);
    out.events = Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(out.events[0]), title: `事件${i}` }));
    await commitEventBatch(lib, batch, out);
    const view = await capture(lib, branch.id), all = await eventView(lib, view), target = all.cards[9];
    const reads = vi.spyOn(Transaction.prototype, 'all');
    try {
      const single = await eventView(lib, view, false, target.chain.id);
      expect(single.cards).toEqual([target]);
      const histories = reads.mock.calls.filter(([store]) => store.startsWith('event_'));
      expect(histories).toHaveLength(0); // The verified current projection is already warm.
      const cold = await Library.open(lib.db.name);
      try {
        reads.mockClear();
        expect((await eventView(cold, view, false, target.chain.id)).cards).toEqual([target]);
        const coldHistories = reads.mock.calls.filter(([store]) => store.startsWith('event_'));
        expect(coldHistories).toHaveLength(3);
        expect(coldHistories.every(([, index, key]) => index === 'owner' && key === target.chain.id)).toBe(true);
      } finally { cold.close(); }
    } finally { reads.mockRestore(); }
    await lib.transaction(['event_chains'], 'readwrite', tx => tx.add('event_chains', { ...target.chain, id: 'foreign-event', branch: 'other-branch' }));
    expect((await eventView(lib, view, false, 'foreign-event')).cards).toEqual([]);
  } finally { lib.close(); }
});
