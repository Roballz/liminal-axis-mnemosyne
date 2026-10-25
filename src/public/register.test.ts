import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { reactive, watch, effectScope, nextTick } from 'vue';
import ts from 'typescript';

// Run the production notification queue and registration watchers without loading
// the unrelated host macro/slash-command modules.
const source = readFileSync(new URL('./register.ts', import.meta.url), 'utf8');
function between(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error(`Public watcher probe marker missing: ${start}`);
  return source.slice(a, b);
}
const code = between('function queueChangedNotice(): void {', 'function bindPublicChangeEvents(): void {') +
  between('  watch(() => derivedMeta.rev, queueChangedNotice);', '  bindPublicChangeEvents();');
const bind = new Function('watch', 'derivedMeta', 'memory', 'bumpPublicRevision', 'emitNotice',
  `let changeQueued=false, ready=true;\n${ts.transpile(code, { target: ts.ScriptTarget.ES2022 })}`);
function fixture(count: number) {
  let reads = 0;
  const make = (id: number) => {
    let value = `Synthetic summary ${id}`;
    return { id: String(id), childIds: [`leaf-${id}`], timeStart: '',
      get text() { reads++; return value; }, set text(next: string) { value = next; } };
  };
  const memory = reactive({ summaries: Array.from({ length: count }, (_, i) => make(i)) });
  const derivedMeta = reactive({ rev: 0 }), bump = vi.fn(), emit = vi.fn(), scope = effectScope();
  scope.run(() => bind(watch, derivedMeta, memory, bump, emit)); reads = 0;
  return { memory, derivedMeta, bump, emit, scope, make, reads: () => reads, reset: () => { reads = 0; bump.mockClear(); emit.mockClear(); } };
}

test('twenty rev-only refreshes notify without rereading a 1000-node summary forest', async () => {
  const f = fixture(1000);
  try {
    for (let i = 0; i < 20; i++) { f.derivedMeta.rev++; await nextTick(); }
    expect(f.reads()).toBe(0); expect(f.bump).toHaveBeenCalledTimes(20); expect(f.emit).toHaveBeenCalledTimes(20);
    expect(f.emit).toHaveBeenLastCalledWith('changed');
  } finally { f.scope.stop(); }
});

test('in-place content/time/children changes, array replacement and deletion all notify without rev changes', async () => {
  const f = fixture(3);
  try {
    const mutations = [
      () => { f.memory.summaries[0].text = 'Edited'; },
      () => { f.memory.summaries[0].timeStart = '2026-10-25'; },
      () => { f.memory.summaries[0].childIds.push('another-leaf'); },
      () => { f.memory.summaries[0].childIds.splice(0, 1, 'replacement-leaf'); },
      () => { f.memory.summaries.push(f.make(3)); },
      () => { f.memory.summaries = [...f.memory.summaries]; },
      () => { f.memory.summaries.splice(1, 1); },
    ];
    for (const mutate of mutations) {
      f.reset(); mutate(); await nextTick();
      expect(f.bump).toHaveBeenCalledTimes(1); expect(f.emit).toHaveBeenCalledTimes(1);
    }
    expect(f.derivedMeta.rev).toBe(0);
  } finally { f.scope.stop(); }
});

test('same-tick forest and rev changes traverse once and retain one combined notice', async () => {
  const f = fixture(1000);
  try {
    f.memory.summaries[0].text = 'Edited'; f.memory.summaries[1].timeStart = 'later';
    f.memory.summaries[2].childIds.push('new-leaf'); f.derivedMeta.rev += 2;
    f.reset(); await nextTick();
    expect(f.reads()).toBe(1000); expect(f.bump).toHaveBeenCalledTimes(1); expect(f.emit).toHaveBeenCalledTimes(1);
  } finally { f.scope.stop(); }
});
