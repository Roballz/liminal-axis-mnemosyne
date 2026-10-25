import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'vue/compiler-sfc';
import * as Vue from 'vue';
import ts from 'typescript';

// Execute the real refresh queue and scope/unmount handlers against controlled
// async sources. This is a Vue/Node lifecycle probe, not browser performance QA.
const descriptor = parse(readFileSync(new URL('../pages/events/index.vue', import.meta.url), 'utf8')).descriptor;
const source = descriptor.scriptSetup!.content;
const queueStart = source.indexOf('let scope = ""');
const queueEnd = source.indexOf('\nfunction edit(', queueStart);
const watchStart = source.indexOf('watch(\n  () => dailyState.scope');
const watchEnd = source.indexOf('onMounted(queueRefresh);', watchStart);
const teardownStart = source.indexOf('onBeforeUnmount(() => {', watchEnd);
const teardownEnd = source.indexOf('\n});', teardownStart) + 4;
if ([queueStart, queueEnd, watchStart, watchEnd, teardownStart].some(index => index < 0)) throw new Error('Refresh source extraction no longer matches the page');
const script = ts.transpile(source.slice(queueStart, queueEnd) + '\nwatch(() => dailyState.revision, queueRefresh);\n' + source.slice(watchStart, watchEnd) + '\n' + source.slice(teardownStart, teardownEnd), { target: ts.ScriptTarget.ES2022 });
type Scenario = 'self-revision' | 'burst' | 'invalid-once' | 'scope-change' | 'unmount' | 'cached' |
  'published-cache' | 'cached-burst' | 'cached-scope-change' | 'cached-library-change' | 'cached-unmount';
async function probe(kind: Scenario) {
  // An external sync has already published this revision before the page starts.
  const state = Vue.reactive({ revision: kind === 'published-cache' ? 7 : 0, generation: 0, scope: 'same-chat' });
  const refs = { busy: Vue.ref(false), loading: Vue.ref(false), error: Vue.ref(''), view: Vue.shallowRef<any>(null), cards: Vue.shallowRef<any[]>([]), storedCount: Vue.ref(0) };
  let reads = 0, projections = 0, syncs = 0, active = 0, maxConcurrent = 0, currentCalls = 0, resolve!: () => void;
  let lib = { name: 'first-library' };
  const cached = kind === 'cached' || kind === 'published-cache' || kind.startsWith('cached-');
  const delayed = ['burst', 'scope-change', 'unmount', 'cached-burst', 'cached-scope-change', 'cached-library-change', 'cached-unmount'].includes(kind);
  const rows = (view: any) => ({ cards: [{ title: kind === 'cached-library-change' ? `${view.id}:${view.library}` :
    kind === 'cached-burst' ? `${view.id}:${view.revision}` : view.id }], storedCount: 1 });
  const project = async (data: ReturnType<typeof rows>) => {
    projections++; active++; maxConcurrent = Math.max(maxConcurrent, active);
    if (delayed && projections === 1) await new Promise<void>(done => { resolve = done; });
    active--;
    return data;
  };
  const deps = {
    ...refs, dailyState: state, hostScope: () => state.scope, hostVersion: () => 'host:' + state.scope,
    activeLibrary: async () => lib,
    syncDaily: async () => {
      if (++syncs > 8) throw new Error('Unexpected refresh loop');
      if (['self-revision', 'cached'].includes(kind) && syncs === 1) state.revision++;
      return { id: state.scope, library: lib.name, revision: state.revision };
    },
    syncedEventProjection: (_lib: object, view: any) => cached ? rows(view) : null,
    eventViewIssues: async (_lib: object, _view: any, projection: any) => project(projection),
    eventView: async (_lib: object, view: any) => {
      reads++;
      return project(rows(view));
    },
    dailyCurrent: async (view: any) => kind === 'cached-burst' ? view.revision === state.revision :
      kind !== 'invalid-once' || currentCalls++ > 0,
  };
  const factory = new Function('Vue', 'deps', `
    const { watch, ref } = Vue;
    const { busy, loading, error, view, cards, storedCount, dailyState, hostScope, hostVersion, activeLibrary, syncDaily, syncedEventProjection, eventViewIssues, eventView, dailyCurrent } = deps;
    let viewHost = '', viewGeneration = 0, teardown;
    const pages = ref({}), expandedCards = ref({}), expandedHistory = ref({}), expandedMembers = ref({});
    const notice = ref(''), editing = ref(false), removing = ref(null), resyncPlan = ref(null), archiveMenu = ref(null), archiveMode = ref(false);
    const resetRewrite = () => {}, cancelPress = () => {}, onBeforeUnmount = (fn) => { teardown = fn; };
    ${script}
    return { queueRefresh, teardown: () => teardown() };
  `);
  const effect = Vue.effectScope();
  const queue = effect.run(() => factory(Vue, deps))!;
  const flush = async () => { for (let i = 0; i < 16; i++) await Vue.nextTick(); };
  try {
    queue.queueRefresh(); await flush();
    if (kind === 'burst' || kind === 'cached-burst') {
      for (let i = 0; i < 100; i++) { state.revision++; await Vue.nextTick(); }
      expect(projections).toBe(1); resolve();
    }
    if (kind === 'scope-change' || kind === 'cached-scope-change') { state.scope = 'new-chat'; state.generation++; resolve(); }
    if (kind === 'cached-library-change') { lib = { name: 'next-library' }; resolve(); }
    if (kind === 'unmount' || kind === 'cached-unmount') { queue.teardown(); resolve(); }
    await flush();
    const settled = { reads, projections, syncs };
    await new Promise(done => setTimeout(done, 0)); await flush();
    expect({ reads, projections, syncs }).toEqual(settled);
    expect(refs.error.value).toBe('');
    expect(maxConcurrent).toBe(1);
    return { syncs, reads, view: refs.view.value?.id ?? null, cards: refs.cards.value.map(card => card.title) };
  } finally { queue.teardown(); effect.stop(); }
}

test('refresh absorbs its own successful archive notification instead of projecting twice', async () => {
  expect(await probe('self-revision')).toEqual({ syncs: 1, reads: 1, view: 'same-chat', cards: ['same-chat'] });
});
test('100 notifications while a refresh is pending coalesce to one latest-state retry', async () => {
  expect(await probe('burst')).toEqual({ syncs: 2, reads: 2, view: 'same-chat', cards: ['same-chat'] });
});
test('invalidated capture retries rather than clearing a required refresh', async () => {
  expect(await probe('invalid-once')).toEqual({ syncs: 2, reads: 2, view: 'same-chat', cards: ['same-chat'] });
});
test('scope change during a projection discards old rows and publishes only the new chat', async () => {
  expect(await probe('scope-change')).toEqual({ syncs: 2, reads: 2, view: 'new-chat', cards: ['new-chat'] });
});
test('unmount during a projection neither publishes stale rows nor launches a retry', async () => {
  expect(await probe('unmount')).toEqual({ syncs: 1, reads: 1, view: null, cards: [] });
});

test('fresh sync projection publishes without a second event read or notification loop', async () => {
  expect(await probe('cached')).toEqual({ syncs: 1, reads: 0, view: 'same-chat', cards: ['same-chat'] });
});

test('an externally published projection is reused when the page sync does not publish another revision', async () => {
  expect(await probe('published-cache')).toEqual({ syncs: 1, reads: 0, view: 'same-chat', cards: ['same-chat'] });
});
test('a cached projection invalidated during diagnostics retries once and publishes the latest revision', async () => {
  expect(await probe('cached-burst')).toEqual({ syncs: 2, reads: 0, view: 'same-chat', cards: ['same-chat:100'] });
});
test('a cached projection cannot publish after switching the chat during diagnostics', async () => {
  expect(await probe('cached-scope-change')).toEqual({ syncs: 2, reads: 0, view: 'new-chat', cards: ['new-chat'] });
});
test('a cached projection cannot publish after switching the active library during diagnostics', async () => {
  expect(await probe('cached-library-change')).toEqual({ syncs: 2, reads: 0, view: 'same-chat', cards: ['same-chat:next-library'] });
});
test('unmount during cached diagnostics neither publishes old rows nor launches a retry', async () => {
  expect(await probe('cached-unmount')).toEqual({ syncs: 1, reads: 0, view: null, cards: [] });
});
