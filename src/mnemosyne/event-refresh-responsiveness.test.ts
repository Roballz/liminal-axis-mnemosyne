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
type Scenario = 'self-revision' | 'burst' | 'invalid-once' | 'scope-change' | 'unmount';
async function probe(kind: Scenario) {
  const state = Vue.reactive({ revision: 0, generation: 0, scope: 'same-chat' });
  const refs = { busy: Vue.ref(false), loading: Vue.ref(false), error: Vue.ref(''), view: Vue.shallowRef<any>(null), cards: Vue.shallowRef<any[]>([]), storedCount: Vue.ref(0) };
  let reads = 0, syncs = 0, active = 0, maxConcurrent = 0, currentCalls = 0, resolve!: () => void;
  const lib = {}, delayed = ['burst', 'scope-change', 'unmount'].includes(kind);
  const deps = {
    ...refs, dailyState: state, hostScope: () => state.scope, hostVersion: () => 'host:' + state.scope,
    activeLibrary: async () => lib,
    syncDaily: async () => {
      if (++syncs > 8) throw new Error('Unexpected refresh loop');
      if (kind === 'self-revision' && syncs === 1) state.revision++;
      return { id: state.scope };
    },
    eventView: async (_lib: object, view: any) => {
      reads++; active++; maxConcurrent = Math.max(maxConcurrent, active);
      if (delayed && reads === 1) await new Promise<void>(done => { resolve = done; });
      active--;
      return { cards: [{ title: view.id }], storedCount: 1 };
    },
    dailyCurrent: async () => kind !== 'invalid-once' || currentCalls++ > 0,
  };
  const factory = new Function('Vue', 'deps', `
    const { watch, ref } = Vue;
    const { busy, loading, error, view, cards, storedCount, dailyState, hostScope, hostVersion, activeLibrary, syncDaily, eventView, dailyCurrent } = deps;
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
    if (kind === 'burst') {
      for (let i = 0; i < 100; i++) { state.revision++; await Vue.nextTick(); }
      expect(reads).toBe(1); resolve();
    }
    if (kind === 'scope-change') { state.scope = 'new-chat'; state.generation++; resolve(); }
    if (kind === 'unmount') { queue.teardown(); resolve(); }
    await flush();
    const settledReads = reads;
    await new Promise(done => setTimeout(done, 0)); await flush();
    expect(reads).toBe(settledReads);
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
