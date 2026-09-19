import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveMemory, correctMemory, selectMemory, bindHost, validateState, exportLogical, importLogical,
  memoryStatus, prepareAvailability, prepareFingerprint, canApply, fingerprint, rebuildPlan,
} from '../index.mjs';
import { fixture, memoryRef, response } from './fixture.mjs';

const rejects = (fn, code) => assert.throws(fn, error => error.code === code);
const roundtrip = state => assert.deepEqual(importLogical(exportLogical(state)), state);
function scenario(hops) {
  const f = fixture(4);
  const old = f.addMemory(f.memory(f.entries.slice(0, 2), 'Summary'));
  const versions = [old];
  for (let i = 0; i < hops; i++) {
    const next = { ...old, memory_revision_id: f.ids('memoryRevision'), content: 'Corrected marker ' + i };
    f.state = archiveMemory(f.state, next);
    versions.push(next);
  }
  const request = f.prepare();
  const contradictory = structuredClone(f.state);
  for (let i = 0; i < hops; i++) {
    contradictory.views[f.branch].corrections[versions[i].memory_revision_id] = versions[i + 1].memory_revision_id;
  }
  return { f, old, versions, request, contradictory };
}
function reply(f, request, memory) {
  return { ...response(request), status: 'ready', blocks: [{
    block_id: f.ids('contextBlock'), kind: 'Summary', content: memory.content,
    content_revision: memory.memory_revision_id, origin: 'source_derived',
    input_refs: [memoryRef(memory)], source_declaration: null, activation_reasons: ['required'],
    placement: { role: 'user', position: 'at_depth', depth: 0 }, priority: 1,
    compressible: false, residency: 'detail',
    token_count_estimate: { value: 8, exact: false, method: 'fixture' },
    visibility: 'normal', send_allowed: true,
  }] };
}
for (const hops of [1, 2]) {
  test('R5 contradictory selection/correction rejected before state/export/import acceptance: hops=' + hops, () => {
    const { f, contradictory, versions } = scenario(hops);
    const snapshot = structuredClone(contradictory);
    rejects(() => validateState(contradictory), 'NEEDS_RESOLUTION');
    rejects(() => exportLogical(contradictory), 'NEEDS_RESOLUTION');
    // Build a correct checksum independently of exportLogical's validation.
    const payload = { format_version: 2, state: contradictory };
    const bundle = { ...payload, checksum: fingerprint('logical-export', payload) };
    rejects(() => importLogical(bundle), 'NEEDS_RESOLUTION');
    assert.deepEqual(contradictory, snapshot);
    roundtrip(f.state);
    if (hops === 2) {
      const middleSelected = structuredClone(contradictory);
      middleSelected.views[f.branch].selections[versions[0].memory_id] = versions[1].memory_revision_id;
      rejects(() => validateState(middleSelected), 'NEEDS_RESOLUTION');
    }
  });
  test('R5 final injection rejects corrected old root even when caller bypasses import: hops=' + hops, () => {
    const { f, contradictory, request, old } = scenario(hops);
    assert.equal(memoryStatus(contradictory, old.memory_revision_id, f.branch), 'needs-rebuild');
    request.required_memory_revision_ids = [old.memory_revision_id];
    request.input_fingerprint = prepareFingerprint(request);
    assert.equal(prepareAvailability(contradictory, f.branch, request.required_memory_revision_ids), 'not_ready');
    rejects(() => canApply(contradictory, reply(f, request, old), request), 'NOT_READY');
    request.required_memory_revision_ids = [];
    request.input_fingerprint = prepareFingerprint(request);
    rejects(() => canApply(contradictory, reply(f, request, old), request), 'NOT_READY');
    assert.deepEqual(rebuildPlan(contradictory, f.branch).rebuild, []);
    assert.ok(rebuildPlan(contradictory, f.branch).blocked.includes(old.memory_revision_id));
  });
}
test('R5 normal correction chain roundtrips and injects only replacement on parent; child keeps old version', () => {
  const { f, old, versions } = scenario(2);
  const child = f.fork(4);
  for (let i = 0; i < 2; i++) {
    f.state = correctMemory(f.state, f.branch, versions[i].memory_revision_id, versions[i + 1].memory_revision_id,
      f.state.views[f.branch].version, f.ids);
    roundtrip(f.state);
  }
  const current = versions.at(-1), request = f.prepare();
  request.required_memory_revision_ids = [current.memory_revision_id];
  request.input_fingerprint = prepareFingerprint(request);
  assert.equal(canApply(f.state, reply(f, request, current), request), true);
  assert.equal(memoryStatus(f.state, old.memory_revision_id, f.branch), 'needs-rebuild');
  assert.equal(memoryStatus(f.state, old.memory_revision_id, child), 'valid');
  const childRequest = f.prepare();
  // Rebind through the public API before preparing the child request.
  const childBinding = { ...f.state.bindings[childRequest.binding_id], branch_id: child, binding_generation: 1 };
  f.state = bindHost(f.state, childBinding);
  Object.assign(childRequest, { branch_id: child, head_snapshot_id: f.state.branches[child].head_snapshot_id,
    binding_generation: 1, memory_view_version: f.state.views[child].version,
    required_memory_revision_ids: [old.memory_revision_id] });
  childRequest.input_fingerprint = prepareFingerprint(childRequest);
  roundtrip(f.state);
  assert.equal(canApply(f.state, reply(f, childRequest, old), childRequest), true);
});
test('R5 unselected uncorrected checkpoint remains valid; historical correction terminal need not be selected', () => {
  const f = fixture(4), first = f.addMemory(f.memory(f.entries.slice(0, 2), 'Record'));
  const next = f.memory(f.entries, 'Record', { memory_id: first.memory_id,
    input_refs: [{ ...memoryRef(first), dependency_mode: 'checkpoint' },
      ...f.entries.slice(2).map(ref => ({ type: 'source', ...ref }))] });
  f.state = archiveMemory(f.state, next);
  f.state = selectMemory(f.state, f.branch, next.memory_revision_id, f.state.views[f.branch].version, f.ids, 'advance');
  assert.equal(memoryStatus(f.state, first.memory_revision_id, f.branch), 'valid');
  assert.equal(memoryStatus(f.state, next.memory_revision_id, f.branch), 'valid');
  const fixed = { ...first, memory_revision_id: f.ids('memoryRevision'), content: 'Corrected checkpoint' };
  f.state = archiveMemory(f.state, fixed);
  f.state = correctMemory(f.state, f.branch, first.memory_revision_id, fixed.memory_revision_id,
    f.state.views[f.branch].version, f.ids);
  roundtrip(f.state);
  assert.equal(f.state.views[f.branch].selections[first.memory_id], next.memory_revision_id);
  assert.equal(memoryStatus(f.state, first.memory_revision_id, f.branch), 'needs-rebuild');
  assert.equal(memoryStatus(f.state, fixed.memory_revision_id, f.branch), 'valid');
  assert.equal(memoryStatus(f.state, next.memory_revision_id, f.branch), 'needs-rebuild');
});
