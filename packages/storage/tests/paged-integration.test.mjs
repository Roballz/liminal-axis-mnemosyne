import test from 'node:test';
import assert from 'node:assert/strict';
import { PagedCoordinator } from '../paged-coordinator.mjs';
import { Pages } from '../pages.mjs';
import { FakeIO } from './fake-io.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import {
  archiveMemory, bindHost, correctMemory, derivedFingerprint, makeCoverage, selectMemory,
} from '../../contracts/index.mjs';
import { history } from '../../contracts/history.mjs';
import { canonicalize, equal } from '../../contracts/primitives.mjs';

class ObservedIO extends FakeIO {
  constructor() {
    super();
    this.counts = { get: 0, put: 0, flush: 0, point: 0 };
  }
  async assertEmpty() {
    assert.equal(this.live.size, 0, 'create must prove the live namespace is empty');
    assert.equal(this.durable.size, 0, 'create must prove the durable namespace is empty');
  }
  async get(id) { this.counts.get++; return super.get(id); }
  async put(id, value) { this.counts.put++; return super.put(id, value); }
  async flush() { this.counts.flush++; return super.flush(); }
  async point(label, edge) {
    this.counts.point++;
    return super.point(label, edge);
  }
  resetCounts() {
    this.counts = { get: 0, put: 0, flush: 0, point: 0 };
    this.trace.length = 0;
  }
}

const failWith = (promise, code) => assert.rejects(promise, error => error.code === code);
const clone = value => structuredClone(value);

async function collect(value) {
  const resolved = await value;
  if (resolved && typeof resolved[Symbol.asyncIterator] === 'function') {
    const result = [];
    for await (const item of resolved) result.push(item);
    return result;
  }
  if (resolved && typeof resolved[Symbol.iterator] === 'function' && typeof resolved !== 'string') {
    return [...resolved];
  }
  return resolved;
}

function stableSnapshot(state, snapshotId) {
  if (snapshotId === null) return null;
  const snapshot = state.snapshots[snapshotId];
  assert.ok(snapshot, `missing snapshot ${snapshotId}`);
  return {
    branch_id: snapshot.branch_id,
    story_id: snapshot.story_id,
    change_kind: snapshot.change_kind,
    created_at: snapshot.created_at,
    message_count: snapshot.message_count,
    entries: history(state, snapshotId),
  };
}

function normalizeState(bundle) {
  const state = clone(bundle.state ?? bundle);
  const normalized = {
    schema_version: state.schema_version,
    stories: state.stories,
    messages: state.messages,
    revisions: state.revisions,
    bindings: state.bindings,
    branches: {},
    memories: {},
    views: {},
  };
  for (const [key, branch] of Object.entries(state.branches)) {
    normalized.branches[key] = {
      ...branch,
      head_snapshot_id: stableSnapshot(state, branch.head_snapshot_id),
      fork: branch.fork && {
        ...branch.fork,
        source_snapshot_id: stableSnapshot(state, branch.fork.source_snapshot_id),
      },
    };
  }
  for (const [key, memory] of Object.entries(state.memories)) {
    const { basis_snapshot_id, input_fingerprint, ...memoryBody } = memory;
    normalized.memories[key] = {
      ...memoryBody,
      basis_snapshot_id: stableSnapshot(state, basis_snapshot_id),
      // The derived-only digest intentionally names its physical basis
      // snapshot. Snapshot IDs are excluded from this oracle comparison.
      input_fingerprint: memory.origin === 'derived_only' ? null : input_fingerprint,
    };
  }
  for (const [key, view] of Object.entries(state.views)) {
    const { version, ...withoutVersion } = view;
    normalized.views[key] = withoutVersion;
  }
  return normalized;
}

function assertLogicalEqual(actual, expected, label = 'logical state') {
  const actualText = canonicalize(normalizeState(actual));
  const expectedText = canonicalize(normalizeState(expected));
  if (actualText !== expectedText) {
    let offset = 0;
    while (offset < actualText.length && offset < expectedText.length && actualText[offset] === expectedText[offset]) offset++;
    throw new assert.AssertionError({ message: `${label}: mismatch at byte ${offset}\nactual=${actualText.slice(offset, offset + 220)}\nexpected=${expectedText.slice(offset, offset + 220)}` });
  }
}

function deltaInput(full, expectedHead, start, deleteCount, entries) {
  const payload = { ...clone(full), expected_head: expectedHead,
    splice: { start, delete_count: deleteCount, entries: clone(entries) } };
  delete payload.entries;
  return { operation_id: full.operation_id, kind: 'history-delta', payload };
}

function historyInput(full, expectedHead = full.expected_head) {
  return { operation_id: full.operation_id, kind: 'history', payload: { ...clone(full), expected_head: expectedHead } };
}

async function execute(handle, input) {
  const receipt = await handle.prepare(input);
  assert.equal(receipt.input.operation_id, input.operation_id);
  const result = await handle.execute(input.operation_id);
  assert.deepEqual(await handle.execute(input.operation_id), result, 'published retry must be idempotent');
  const lookup = await handle.lookup(input.operation_id);
  assert.equal(lookup.status, 'published');
  return { receipt, result, lookup };
}

async function createCoordinator() {
  const io = new ObservedIO();
  const coordinator = new PagedCoordinator(io);
  const handle = await coordinator.create();
  return { io, coordinator, handle };
}

async function initialContext() {
  const context = await createCoordinator();
  const f = fixture(2);
  // fixture() already builds its oracle through the initial command. Replay
  // that retained command into the paged store so IDs and source refs match.
  const init = Object.values(f.state.operations)[0].command;
  const actual = await execute(context.handle, historyInput(init));
  assert.equal(actual.result.snapshot_id, await context.handle.read('branches', f.branch).then(v => v.head_snapshot_id));
  assertLogicalEqual(await context.handle.logical(), { format_version: 2, state: f.state });
  return { ...context, f, actualHead: actual.result.snapshot_id };
}

async function appendContext(context, { edit = false } = {}) {
  const before = context.f.entries;
  const index = edit ? 1 : before.length;
  const source = edit
    ? context.f.source('assistant', 'Edited fictional assistant response', before[index].message_id)
    : context.f.source('user', `Fictional appended marker ${before.length}`);
  const after = edit ? before.map((entry, i) => i === index ? source.ref : entry) : [...before, source.ref];
  const full = context.f.command(after, {
    change_kind: edit ? 'edit' : 'append',
    // An edit reuses the message identity; only the new revision is durable.
    messages: edit ? [] : [source.message],
    revisions: [source.revision],
  });
  const input = deltaInput(full, context.actualHead, index, edit ? 1 : 0, [source.ref]);
  const actual = await execute(context.handle, input);
  context.f.commit(full);
  context.actualHead = actual.result.snapshot_id;
  return { ...context, full, input, actual, source, before, after };
}

async function forkContext(context) {
  const prefixLength = 2;
  const entries = context.f.entries;
  const child = context.f.ids('branch');
  const oracleParentHead = context.f.state.branches[context.f.branch].head_snapshot_id;
  const actualParentHead = context.actualHead;
  const full = context.f.command(entries.slice(0, prefixLength), {
    branch_id: child,
    expected_head: null,
    change_kind: 'fork',
    fork: {
      parent_branch_id: context.f.branch,
      source_snapshot_id: oracleParentHead,
      prefix_length: prefixLength,
      anchor: entries[prefixLength - 1],
    },
  });
  const actualPayload = { ...clone(full), fork: { ...full.fork, source_snapshot_id: actualParentHead } };
  const actual = await execute(context.handle, historyInput({ ...actualPayload, operation_id: full.operation_id }, null));
  context.f.commit(full);
  const childHead = actual.result.snapshot_id;
  return { ...context, full, actual, child, childHead, oracleParentHead, actualParentHead };
}

async function memoryOperation(context, memory, action, options = {}) {
  const operation_id = context.f.ids('operation');
  const actualHead = context.actualHead;
  const actualMemory = { ...clone(memory), basis_snapshot_id: actualHead };
  // Derived-only fingerprints include their explicit snapshot scope; the
  // oracle and paged store use different generated snapshot IDs.
  actualMemory.input_fingerprint = derivedFingerprint(actualMemory);
  const actualView = (await context.handle.read('views', context.f.branch)).version;
  const payload = {
    archives: action === 'archive' ? [actualMemory] : [actualMemory],
    action,
    branch_id: action === 'archive' ? null : context.f.branch,
    revision_id: action === 'archive' ? null : memory.memory_revision_id,
    old_revision_id: action === 'correct' ? options.old_revision_id : null,
    expected_view: action === 'archive' ? null : actualView,
    mode: action === 'select' ? options.mode : null,
  };
  const input = { operation_id, kind: 'memory', payload };
  const actual = await execute(context.handle, input);
  if (action === 'archive') {
    context.f.state = archiveMemory(context.f.state, memory);
  } else if (action === 'select') {
    context.f.state = archiveMemory(context.f.state, memory);
    context.f.state = selectMemory(context.f.state, context.f.branch, memory.memory_revision_id,
      context.f.state.views[context.f.branch].version, context.f.ids, options.mode);
  } else {
    context.f.state = archiveMemory(context.f.state, memory);
    context.f.state = correctMemory(context.f.state, context.f.branch, options.old_revision_id,
      memory.memory_revision_id, context.f.state.views[context.f.branch].version, context.f.ids);
  }
  return { ...context, input, actual, memory, actualMemory };
}

test('paged domain integrates delta history, edit, fixed fork, memory graph, correction, and binding', async () => {
  let context = await initialContext();
  context = await appendContext(context);
  context = await appendContext(context, { edit: true });
  context = await forkContext(context);

  const mainEntries = context.f.entries;
  const base = context.f.memory(mainEntries.slice(0, 2), 'Record');
  context = await memoryOperation(context, base, 'select', { mode: 'replace' });

  const replacement = { ...clone(base), memory_revision_id: context.f.ids('memoryRevision'), content: 'Corrected record' };
  replacement.input_fingerprint = derivedFingerprint(replacement);
  context = await memoryOperation(context, replacement, 'correct', { old_revision_id: base.memory_revision_id });

  const checkpoint = replacement;
  const fullRecord = {
    ...clone(checkpoint),
    memory_revision_id: context.f.ids('memoryRevision'),
    input_refs: [
      { type: 'memory', memory_id: checkpoint.memory_id,
        memory_revision_id: checkpoint.memory_revision_id, dependency_mode: 'checkpoint' },
      { type: 'source', ...mainEntries[2] },
    ],
    coverage: makeCoverage(mainEntries, 'interval', mainEntries),
    content: 'Full checkpoint record',
  };
  fullRecord.input_fingerprint = derivedFingerprint(fullRecord);
  context = await memoryOperation(context, fullRecord, 'select', { mode: 'advance' });

  const derivedOnly = context.f.memory([], 'Summary', {
    origin: 'derived_only',
    source_declaration: 'Fictional unavailable source',
    scope_branch_id: context.f.branch,
  });
  context = await memoryOperation(context, derivedOnly, 'archive');

  const binding_id = context.f.ids('binding');
  const binding = {
    schema_version: 1, binding_id, story_id: context.f.story, branch_id: context.f.branch,
    host_kind: 'fixture', host_scope: 'fictional', stable_id: 'fixture-host', mutable_ref: 'fixture.jsonl',
    binding_generation: 0, intent: 'confirmed_mapping',
    message_map: [{ host_key: 'first', message_id: mainEntries[0].message_id }],
  };
  const bindingInput = { operation_id: context.f.ids('operation'), kind: 'binding', payload: binding };
  const bindingResult = await execute(context.handle, bindingInput);
  context.f.state = bindHost(context.f.state, binding);
  assert.deepEqual(bindingResult.result, { binding_id, binding_generation: 0 });

  const actualBundle = await context.handle.logical();
  assertLogicalEqual(actualBundle, { format_version: 2, state: context.f.state });
  const actualChild = await context.handle.read('branches', context.child);
  assert.equal(actualChild.head_snapshot_id, context.childHead);
  assert.equal(actualChild.fork.source_snapshot_id, context.actualParentHead);
  assert.deepEqual({ ...actualChild, head_snapshot_id: null,
    fork: { ...actualChild.fork, source_snapshot_id: null } },
  { ...context.f.state.branches[context.child], head_snapshot_id: null,
    fork: { ...context.f.state.branches[context.child].fork, source_snapshot_id: null } });
  assert.deepEqual(await collect(context.handle.range(context.actualHead, 0, mainEntries.length)), mainEntries);
  assert.deepEqual(await collect(context.handle.range(context.childHead, 0, 2)), mainEntries.slice(0, 2));
  assert.equal((await context.handle.read('memories', fullRecord.memory_revision_id)).memory_revision_id,
    fullRecord.memory_revision_id);
  assert.equal(await context.handle.memoryStatus(fullRecord.memory_revision_id, context.f.branch), 'valid');
  assert.equal(await context.handle.memoryStatus(base.memory_revision_id, context.f.branch), 'needs-rebuild');
  assert.equal(await context.handle.memoryStatus(derivedOnly.memory_revision_id, context.f.branch), 'valid');
  assert.equal((await context.handle.read('bindings', binding_id)).binding_id, binding_id);
  assert.equal((await context.handle.pending()).length, 0);
});

test('paged checkpoint selection rejects a non-checkpoint advance and preserves the oracle state', async () => {
  const context = await initialContext();
  const entries = context.f.entries;
  const memory = context.f.memory(entries.slice(0, 2), 'Record');
  const selected = await memoryOperation(context, memory, 'select', { mode: 'replace' });
  const invalid = { ...clone(memory), memory_revision_id: context.f.ids('memoryRevision'), content: 'No checkpoint input' };
  invalid.input_fingerprint = derivedFingerprint(invalid);
  const operation_id = context.f.ids('operation');
  const actualView = (await selected.handle.read('views', selected.f.branch)).version;
  const input = {
    operation_id, kind: 'memory', payload: {
      archives: [{ ...clone(invalid), basis_snapshot_id: selected.actualHead }], action: 'select',
      branch_id: selected.f.branch, revision_id: invalid.memory_revision_id, old_revision_id: null,
      expected_view: actualView, mode: 'advance',
    },
  };
  await assert.rejects(selected.handle.prepare(input), error => error.code === 'INVALID_TRANSITION');
  assertLogicalEqual(await selected.handle.logical(), { format_version: 2, state: selected.f.state });
});

for (const label of ['paged-prepare', 'paged-materials', 'paged-publish', 'paged-ack']) {
  for (const edge of ['before', 'after']) {
    test(`paged recovery retains operation and IDs at ${label}/${edge}`, async () => {
      let context = await initialContext();
      const before = await context.handle.logical();
      const oldEntries = context.f.entries;
      const source = context.f.source('user', 'fault-injected append');
      const full = context.f.command([...oldEntries, source.ref], {
        change_kind: 'append', messages: [source.message], revisions: [source.revision],
      });
      const input = deltaInput(full, context.actualHead, oldEntries.length, 0, [source.ref]);
      const preparePhase = label === 'paged-prepare' || label === 'paged-materials';
      if (preparePhase) context.io.fail = { label, edge, n: 1, durable: false };
      let receipt;
      if (preparePhase) {
        await failWith(context.handle.prepare(input), 'RECOVERY_REQUIRED');
      } else {
        receipt = await context.handle.prepare(input);
        context.io.fail = { label, edge, n: 1, durable: false };
        await failWith(context.handle.execute(input.operation_id), 'RECOVERY_REQUIRED');
      }
      context.io.fail = null;
      context.io.crash();
      const reopened = new PagedCoordinator(context.io);
      const recovered = await reopened.recover();
      const found = await recovered.lookup(input.operation_id);
      if (preparePhase) {
        assert.equal(found, null, 'a preparation root not made durable must not be claimed');
        assert.deepEqual(await recovered.pending(), []);
        receipt = await recovered.prepare(input);
      } else {
        assert.ok(found, 'prepared request must be indexed or published after execute failure');
        assert.deepEqual(found.generated, receipt.generated);
        assert.deepEqual(found.input, receipt.input);
        if (found.status === 'prepared') await recovered.execute(input.operation_id);
        else assert.deepEqual(await recovered.execute(input.operation_id), found.result);
      }
      if (preparePhase) await recovered.execute(input.operation_id);
      context.f.commit(full);
      assertLogicalEqual(await recovered.logical(), { format_version: 2, state: context.f.state });
      assert.equal((await recovered.lookup(input.operation_id)).status, 'published');
      assert.deepEqual(await recovered.execute(input.operation_id), (await recovered.lookup(input.operation_id)).result);
      assert.notEqual(canonicalize(before), canonicalize(await recovered.logical()), 'fault recovery must commit exactly once');
    });
  }
}

test('paged recovery reads the checkpoint instead of replaying every durable operation', async () => {
  let context = await initialContext();
  const perOperation = [];
  const operationCount = 14;
  for (let i = 0; i < operationCount; i++) {
    const oldEntries = context.f.entries;
    const source = context.f.source('user', `growth-${i}`);
    const full = context.f.command([...oldEntries, source.ref], {
      change_kind: 'append', messages: [source.message], revisions: [source.revision],
    });
    const input = deltaInput(full, context.actualHead, oldEntries.length, 0, [source.ref]);
    context.io.resetCounts();
    const result = await execute(context.handle, input);
    perOperation.push(context.io.counts.get + context.io.counts.put);
    context.f.commit(full);
    context.actualHead = result.result.snapshot_id;
  }
  assert.ok(perOperation.at(-1) <= perOperation[0] * 8 + 64,
    `local update IO unexpectedly grew with history: ${perOperation.join(',')}`);

  await context.coordinator.close();
  context.io.crash();
  context.io.resetCounts();
  const recoveredCoordinator = new PagedCoordinator(context.io);
  const recovered = await recoveredCoordinator.recover();
  assert.ok(context.io.counts.get < 64,
    `recovery read ${context.io.counts.get} physical records for ${operationCount} operations`);
  assert.equal(context.io.trace.filter(point => point.label.startsWith('paged-')).length, 0,
    'recovery must not re-run prepare/materials/publish/ack boundaries');
  assertLogicalEqual(await recovered.logical(), { format_version: 2, state: context.f.state });
  assert.deepEqual(await collect(recovered.range(context.actualHead, 0, operationCount + 2)), context.f.entries);
});

test('paged export remains a checked directory artifact and exact reopen preserves logical state', async () => {
  const context = await initialContext();
  const exported = await collect(await context.handle.export());
  const bytes = Buffer.concat(exported.map(chunk => Buffer.from(chunk)));
  const records = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].type, 'header');
  assert.equal(records[0].metadata.format, 'mnemosyne-paged-storage-v1');
  assert.equal(records.at(-1).type, 'footer');
  assert.ok(records.some(record => record.type === 'page'));
  await context.coordinator.close();
  context.io.crash();
  const reopened = await new PagedCoordinator(context.io).recover();
  assertLogicalEqual(await reopened.logical(), { format_version: 2, state: context.f.state });
  const reopenedBytes = Buffer.concat((await collect(await reopened.export())).map(chunk => Buffer.from(chunk)));
  assert.deepEqual(reopenedBytes, bytes);
});

test('mapPrefix returns a balanced immutable prefix for fixed fork pruning', async () => {
  const io = new ObservedIO();
  const pages = new Pages(io);
  let root = null;
  const refs = [];
  for (let index = 0; index < 2048; index++) {
    const key = `k${String(index).padStart(5, '0')}`;
    const value = await pages.put({ kind: 'json-scalar', value: index });
    refs.push(value);
    root = await pages.mapSet(root, key, value);
  }
  const prefix = await pages.mapPrefix(root, 'k01023');
  const prefixEntries = [];
  for await (const [key, value] of pages.mapEntries(prefix)) prefixEntries.push([key, value]);
  assert.equal(prefixEntries.length, 1024);
  assert.equal(prefixEntries[0][0], 'k00000');
  assert.equal(prefixEntries.at(-1)[0], 'k01023');
  assert.ok(prefixEntries.every(([, value], index) => equal(value, refs[index])));
  assert.equal((await pages.audit(prefix, 'map')).count, 1024);
  const originalEntries = [];
  for await (const [key] of pages.mapEntries(root)) originalEntries.push(key);
  assert.equal(originalEntries.length, 2048, 'prefix pruning must preserve the original root');
  assert.equal((await pages.mapPrefix(root, 'k00000') && await pages.audit(await pages.mapPrefix(root, 'k00000'), 'map')).count, 1);
  assert.equal((await pages.mapPrefix(root, 'k99999') && await pages.audit(await pages.mapPrefix(root, 'k99999'), 'map')).count, 2048);
});


test('paged current dependencies reject a selection cycle and preserve the last confirmed graph',async()=>{
  let c=await initialContext();
  const a=c.f.memory(c.f.entries,'Summary'); c=await memoryOperation(c,a,'select',{mode:'replace'});
  const b=c.f.memory(c.f.entries,'Summary',{input_refs:[{type:'memory',memory_id:a.memory_id,memory_revision_id:a.memory_revision_id}]});
  c=await memoryOperation(c,b,'select',{mode:'replace'});
  const a2=c.f.memory(c.f.entries,'Summary',{memory_id:a.memory_id,input_refs:[{type:'memory',memory_id:b.memory_id,memory_revision_id:b.memory_revision_id}]});
  assert.throws(()=>selectMemory(archiveMemory(c.f.state,a2),c.f.branch,a2.memory_revision_id,c.f.state.views[c.f.branch].version,c.f.ids,'replace'),e=>e.code==='NEEDS_RESOLUTION');
  const actual={...a2,basis_snapshot_id:c.actualHead};actual.input_fingerprint=derivedFingerprint(actual);
  const before=await c.handle.logical();
  await failWith(c.handle.prepare({operation_id:c.f.ids('operation'),kind:'memory',payload:{archives:[actual],action:'select',branch_id:c.f.branch,revision_id:a2.memory_revision_id,old_revision_id:null,expected_view:(await c.handle.read('views',c.f.branch)).version,mode:'replace'}}),'NEEDS_RESOLUTION');
  const recovered=await c.coordinator.recover();assert.deepEqual(await recovered.logical(),before);
});

test('paged derived-only retains same-branch prefix semantics after append, cutoff, fork and edit',async()=>{
  let c=await initialContext();
  const memory=c.f.memory([],'Summary',{origin:'derived_only',source_declaration:'Fictional prior source unavailable',scope_branch_id:c.f.branch});
  c=await memoryOperation(c,memory,'archive'); c=await appendContext(c);
  assert.equal(await c.handle.memoryStatus(memory.memory_revision_id,c.f.branch),'valid');
  assert.equal(await c.handle.memoryStatus(memory.memory_revision_id,c.f.branch,1),'needs-review');
  c=await forkContext(c);assert.equal(await c.handle.memoryStatus(memory.memory_revision_id,c.child),'out-of-scope');
  c=await appendContext(c,{edit:true});assert.equal(await c.handle.memoryStatus(memory.memory_revision_id,c.f.branch),'needs-review');
  assertLogicalEqual(await c.handle.logical(),{state:c.f.state});
});

test('paged local insert/delete/reorder/restore and no-op import preserve oracle transitions',async()=>{
  let c=await initialContext();const initialHead=c.actualHead,initialEntries=c.f.entries;
  const inserted=c.f.source('system','Synthetic inserted source');
  async function change(kind,start,count,entries,extra={}){
    const after=c.f.entries;after.splice(start,count,...entries);
    const full=c.f.command(after,{change_kind:kind,...extra});
    const actual=await execute(c.handle,deltaInput(full,c.actualHead,start,count,entries));
    c.f.commit(full);c.actualHead=actual.result.snapshot_id;
    assertLogicalEqual(await c.handle.logical(),{state:c.f.state});return actual;
  }
  await change('import',1,0,[inserted.ref],{messages:[inserted.message],revisions:[inserted.revision]});
  await change('delete',1,1,[]);
  const head=c.actualHead;await change('import',0,2,c.f.entries);assert.equal(c.actualHead,head);
  await change('reorder',0,2,[...c.f.entries].reverse());
  await change('restore',0,2,initialEntries);
  assert.deepEqual(await c.handle.range(initialHead,0,2),initialEntries);
  assert.equal((await c.handle.read('revisions',inserted.revision.revision_id)).content,inserted.revision.content);
});
