import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveMemory, selectMemory, correctMemory, memoryStatus, rebuildPlan, validateState,
  exportLogical, importLogical, bindHost, fingerprint, prepareAvailability, canApply, prepareFingerprint,
} from '../index.mjs';
import { fixture, memoryRef, response } from './fixture.mjs';

const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
const roundtrip = state => {
  validateState(state);
  assert.deepEqual(importLogical(exportLogical(state)), state);
};
const checkpoint = memory => ({ ...memoryRef(memory), dependency_mode: 'checkpoint' });
function select(f, memory, mode = 'replace') {
  f.state = archiveMemory(f.state, memory);
  roundtrip(f.state);
  f.state = selectMemory(f.state, f.branch, memory.memory_revision_id, f.state.views[f.branch].version, f.ids, mode);
  roundtrip(f.state);
  return memory;
}
function cumulative(f) {
  const first = select(f, f.memory(f.entries.slice(0, 2), 'Record'));
  const second = select(f, f.memory(f.entries.slice(0, 4), 'Record', {
    memory_id: first.memory_id, input_refs: [checkpoint(first), ...f.entries.slice(2, 4).map(ref => ({ type: 'source', ...ref }))],
  }), 'advance');
  const third = select(f, f.memory(f.entries, 'Record', {
    memory_id: first.memory_id, input_refs: [checkpoint(second), ...f.entries.slice(4).map(ref => ({ type: 'source', ...ref }))],
  }), 'advance');
  return { first, second, third };
}
function edit(f, index = 1) {
  const entries = f.entries, old = entries[index];
  const revision = f.source(f.state.revisions[old.revision_id].role, 'Review edit', old.message_id);
  entries[index] = revision.ref;
  f.commit(f.command(entries, { change_kind: 'edit', revisions: [revision.revision] }));
  roundtrip(f.state);
}
const status = (f, memory, branch = f.branch, cutoff) =>
  memoryStatus(f.state, memory.memory_revision_id, branch, cutoff);

test('R1 same Record advances twice through fixed checkpoints; early edit invalidates suffix only on parent', () => {
  const f = fixture(), chain = cumulative(f), child = f.fork(6);
  roundtrip(f.state);
  for (const memory of Object.values(chain)) assert.equal(status(f, memory), 'valid');
  assert.deepEqual(rebuildPlan(f.state, f.branch).rebuild, []);
  edit(f);
  const plan = rebuildPlan(f.state, f.branch);
  for (const memory of Object.values(chain)) {
    assert.equal(status(f, memory), 'needs-rebuild');
    assert.equal(status(f, memory, child), 'valid');
  }
  assert.deepEqual(plan.rebuild, Object.values(chain).map(m => m.memory_revision_id));
});
test('R1 explicit correction of historical checkpoint propagates without selecting it over latest cumulative state', () => {
  const f = fixture(), { first, second, third } = cumulative(f), child = f.fork(6);
  const corrected = { ...first, memory_revision_id: f.ids('memoryRevision'), content: 'Corrected early extraction' };
  f.state = archiveMemory(f.state, corrected);
  roundtrip(f.state);
  f.state = correctMemory(f.state, f.branch, first.memory_revision_id, corrected.memory_revision_id,
    f.state.views[f.branch].version, f.ids);
  roundtrip(f.state);
  assert.equal(f.state.views[f.branch].selections[first.memory_id], third.memory_revision_id);
  assert.equal(status(f, second), 'needs-rebuild');
  assert.equal(status(f, third), 'needs-rebuild');
  assert.equal(status(f, third, child), 'valid');
  const plan = rebuildPlan(f.state, f.branch);
  assert.equal(plan.statuses[corrected.memory_revision_id], 'valid');
  assert.deepEqual(plan.rebuild, [second.memory_revision_id, third.memory_revision_id]);
  const secondFixed = f.memory(f.entries.slice(0, 4), 'Record', {
    memory_id: first.memory_id, input_refs: [checkpoint(corrected), ...f.entries.slice(2, 4).map(ref => ({ type: 'source', ...ref }))],
  });
  f.state = archiveMemory(f.state, secondFixed);
  f.state = correctMemory(f.state, f.branch, second.memory_revision_id, secondFixed.memory_revision_id,
    f.state.views[f.branch].version, f.ids);
  roundtrip(f.state);
  const thirdFixed = f.memory(f.entries, 'Record', {
    memory_id: first.memory_id, input_refs: [checkpoint(secondFixed), ...f.entries.slice(4).map(ref => ({ type: 'source', ...ref }))],
  });
  f.state = archiveMemory(f.state, thirdFixed);
  f.state = correctMemory(f.state, f.branch, third.memory_revision_id, thirdFixed.memory_revision_id,
    f.state.views[f.branch].version, f.ids);
  roundtrip(f.state);
  assert.equal(status(f, thirdFixed), 'valid');
  assert.equal(status(f, third, child), 'valid');
  assert.deepEqual(rebuildPlan(f.state, f.branch).rebuild, []);
});

test('R1 checkpoint tagging cannot bypass current-selection checks for arbitrary summaries or equal-scope records', () => {
  const f = fixture(), first = select(f, f.memory(f.entries.slice(0, 2), 'Record'));
  const invalid = f.memory(f.entries.slice(0, 2), 'Record', {
    memory_id: first.memory_id, input_refs: [checkpoint(first)],
  });
  rejects(() => archiveMemory(f.state, invalid), 'INVALID_TRANSITION');
  const summary = f.memory(f.entries.slice(0, 2), 'Summary', { input_refs: [checkpoint(first)] });
  rejects(() => archiveMemory(f.state, summary), 'INVALID_TRANSITION');
  roundtrip(f.state);
});
test('R1 replacement without explicit advancement cannot silently publish a self-invalid checkpoint', () => {
  const f = fixture(), first = select(f, f.memory(f.entries.slice(0, 2), 'Record'));
  const second = f.memory(f.entries.slice(0, 4), 'Record', {
    memory_id: first.memory_id, input_refs: [checkpoint(first), ...f.entries.slice(2, 4).map(ref => ({ type: 'source', ...ref }))],
  });
  f.state = archiveMemory(f.state, second);
  const before = f.state;
  rejects(() => selectMemory(before, f.branch, second.memory_revision_id, before.views[f.branch].version, f.ids),
    'NEEDS_RESOLUTION');
  assert.equal(f.state, before);
  roundtrip(before);
});
test('R2 A2 -> B1 -> current A2 cycle rejects selection; planner never fabricates an order for corrupted view', () => {
  const f = fixture(), a = select(f, f.memory(f.entries.slice(0, 2), 'Summary'));
  const b = select(f, f.memory(f.entries.slice(0, 2), 'Summary', { input_refs: [memoryRef(a)] }));
  const a2 = f.memory(f.entries.slice(0, 2), 'Summary', { memory_id: a.memory_id, input_refs: [memoryRef(b)] });
  f.state = archiveMemory(f.state, a2);
  const before = f.state;
  roundtrip(before);
  rejects(() => selectMemory(before, f.branch, a2.memory_revision_id, before.views[f.branch].version, f.ids),
    'NEEDS_RESOLUTION');
  assert.equal(f.state, before);
  const corrupted = structuredClone(before);
  corrupted.views[f.branch].selections[a.memory_id] = a2.memory_revision_id;
  const plan = rebuildPlan(corrupted, f.branch);
  assert.deepEqual(plan.rebuild, []);
  assert.ok(plan.blocked.includes(a2.memory_revision_id));
  rejects(() => validateState(corrupted), 'NEEDS_RESOLUTION');
});
test('R2 legitimate diamond shares dependency without false cycle; replacement still invalidates both parents', () => {
  const f = fixture(), a = select(f, f.memory(f.entries.slice(0, 2), 'Summary'));
  const b = select(f, f.memory(f.entries.slice(0, 2), 'Summary', { input_refs: [memoryRef(a)] }));
  const c = select(f, f.memory(f.entries.slice(0, 2), 'Event', { input_refs: [memoryRef(a)] }));
  const d = select(f, f.memory(f.entries.slice(0, 2), 'Summary', { input_refs: [memoryRef(b), memoryRef(c)] }));
  assert.equal(status(f, d), 'valid');
  select(f, { ...a, memory_revision_id: f.ids('memoryRevision'), content: 'Fixed extraction' });
  assert.equal(status(f, d), 'needs-rebuild');
  assert.deepEqual(rebuildPlan(f.state, f.branch).rebuild, [b, c, d].map(m => m.memory_revision_id));
});
test('R3 provenance-bound host cannot change story; rename and same-story carryover remain exportable', () => {
  const f = fixture(), request = f.prepare(), binding = f.state.bindings[request.binding_id];
  const source = f.source('user', 'Bound source');
  source.revision.provenance.binding_id = binding.binding_id;
  f.commit(f.command([...f.entries, source.ref], { change_kind: 'append',
    messages: [source.message], revisions: [source.revision] }));
  const otherStory = f.ids('story'), otherBranch = f.ids('branch');
  f.commit(f.command([], { change_kind: 'init', story_id: otherStory, branch_id: otherBranch, expected_head: null }));
  const before = f.state;
  roundtrip(before);
  rejects(() => bindHost(before, { ...binding, story_id: otherStory, branch_id: otherBranch, binding_generation: 1 }),
    'NEEDS_RESOLUTION');
  assert.equal(f.state, before);
  roundtrip(before);
  f.state = bindHost(before, { ...binding, mutable_ref: 'renamed.jsonl', binding_generation: 1 });
  roundtrip(f.state);
  f.state = bindHost(f.state, { ...binding, mutable_ref: 'continued.jsonl', binding_generation: 2, intent: 'carryover' });
  roundtrip(f.state);
});
function derived(f) {
  return select(f, f.memory([], 'Summary', { origin: 'derived_only',
    source_declaration: 'Known imported summary; no original text', scope_branch_id: f.branch }));
}
test('R4 derived-only survives append with original scope and declaration intact through logical transfer', () => {
  const f = fixture(), memory = derived(f), basis = memory.basis_snapshot_id;
  const next = f.source('user', 'Normal next turn');
  f.commit(f.command([...f.entries, next.ref], { change_kind: 'append', messages: [next.message], revisions: [next.revision] }));
  roundtrip(f.state);
  assert.equal(status(f, memory), 'valid');
  assert.equal(prepareAvailability(f.state, f.branch, [memory.memory_revision_id]), 'ready');
  assert.equal(f.state.memories[memory.memory_revision_id].basis_snapshot_id, basis);
  assert.equal(status(f, memory, f.fork(7)), 'out-of-scope');
  roundtrip(f.state);
});
test('R4 changed prefix or earlier cutoff needs review; required unavailable/private/foreign memories cannot mean empty', () => {
  for (const action of ['edit', 'delete', 'reorder', 'cutoff']) {
    const f = fixture(), memory = derived(f);
    if (action === 'edit') edit(f);
    if (action === 'delete') f.commit(f.command(f.entries.slice(1), { change_kind: 'delete' }));
    if (action === 'reorder') {
      const entries = f.entries; [entries[0], entries[1]] = [entries[1], entries[0]];
      f.commit(f.command(entries, { change_kind: 'reorder' }));
    }
    const cutoff = action === 'cutoff' ? 2 : f.entries.length;
    assert.equal(status(f, memory, f.branch, cutoff), 'needs-review');
    const request = f.prepare();
    request.cutoff_length = cutoff;
    request.recent_source_refs = [];
    request.required_memory_revision_ids = [memory.memory_revision_id];
    request.input_fingerprint = prepareFingerprint(request);
    rejects(() => canApply(f.state, response(request), request), 'NOT_READY');
    roundtrip(f.state);
  }
  const f = fixture(), memory = derived(f), child = f.fork(6);
  assert.equal(prepareAvailability(f.state, child, [memory.memory_revision_id]), 'not_ready');
  const otherStory = f.ids('story'), otherBranch = f.ids('branch');
  f.commit(f.command([], { change_kind: 'init', story_id: otherStory, branch_id: otherBranch, expected_head: null }));
  assert.equal(status(f, memory, otherBranch), 'out-of-scope');
  assert.equal(prepareAvailability(f.state, otherBranch, [memory.memory_revision_id]), 'not_ready');
  const hidden = select(f, f.memory(f.entries.slice(0, 2), 'TurnMemory', { visibility: 'private' }));
  assert.equal(prepareAvailability(f.state, f.branch, [hidden.memory_revision_id]), 'not_ready');
  assert.equal(prepareAvailability(f.state, f.branch, []), 'empty');
});
test('R1/R2 format 1 import preserves old fingerprints and adds an empty correction view; format 2 preserves new semantics', () => {
  const f = fixture(), memory = select(f, f.memory(f.entries.slice(0, 2)));
  const oldState = structuredClone(f.state);
  for (const view of Object.values(oldState.views)) delete view.corrections;
  const payload = { format_version: 1, state: oldState };
  const migrated = importLogical({ ...payload, checksum: fingerprint('logical-export', payload) });
  assert.deepEqual(migrated, f.state);
  assert.equal(migrated.memories[memory.memory_revision_id].input_fingerprint, memory.input_fingerprint);
  assert.equal(exportLogical(migrated).format_version, 2);
  roundtrip(migrated);
});
