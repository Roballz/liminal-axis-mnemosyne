import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  archiveMemory, bindHost, canApply, canonicalize, checkPrepare, checkResponse, commitHistory,
  derivedFingerprint, expand, exportLogical, fingerprint, groupTurns, history, id, importLogical,
  interpretRegenerate, makeCoverage, memoryStatus, newId, prepareAvailability, prepareFingerprint,
  rebuildPlan, resolveIdentity, selectMemory, validate, validateState,
} from '../index.mjs';
import { fixture, memoryRef, response } from './fixture.mjs';

const rejects = (fn, code) => assert.throws(fn, error => error.code === code);
const clone = value => structuredClone(value);
const status = (f, m, branch = f.branch, cutoff) => memoryStatus(f.state, m.memory_revision_id, branch, cutoff);
function edit(f, index = 1, content = 'Edited fictional marker') {
  const old = f.entries[index], role = f.state.revisions[old.revision_id].role;
  const changed = f.source(role, content, old.message_id);
  const entries = f.entries;
  entries[index] = changed.ref;
  return f.command(entries, { change_kind: 'edit', revisions: [changed.revision] });
}
function hierarchy(f) {
  const a = f.addMemory(f.memory(f.entries.slice(0, 2)));
  const b = f.addMemory(f.memory(f.entries.slice(2, 4)));
  const unrelated = f.addMemory(f.memory(f.entries.slice(4, 6)));
  const small = f.addMemory(f.memory(f.entries.slice(0, 4), 'Summary', { input_refs: [memoryRef(a), memoryRef(b)] }));
  const large = f.addMemory(f.memory(f.entries, 'Summary', { input_refs: [memoryRef(small), memoryRef(unrelated)] }));
  const event = f.addMemory(f.memory(f.entries.slice(0, 4), 'Event', { input_refs: [memoryRef(a), memoryRef(b)] }));
  const checkpoint = f.addMemory(f.memory(f.entries.slice(0, 2), 'Record', { input_refs: [memoryRef(a)] }));
  const cumulative = f.addMemory(f.memory(f.entries.slice(0, 4), 'Record',
    { input_refs: [memoryRef(checkpoint), memoryRef(b)] }));
  return { a, b, unrelated, small, large, event, checkpoint, cumulative };
}

test('A01 empty history, secure UUID format and malformed IDs', () => {
  const f = fixture(0);
  assert.deepEqual(f.entries, []);
  validateState(f.state);
  assert.match(newId('snapshot'), /^hs_/);
  for (const bad of ['hs_1', 'hs_00000000-0000-1000-8000-000000000001', 'hs_00000000-0000-4000-7000-000000000001']) {
    rejects(() => id('snapshot', bad), 'INVALID_SCHEMA');
  }
});
test('A01 duplicate identity, wrong-owner revisions, missing refs and manifest cycles are rejected', () => {
  const f = fixture();
  const original = f.state;
  rejects(() => f.commit(f.command([f.entries[0], f.entries[0]])), 'NEEDS_RESOLUTION');
  const wrong = f.entries; wrong[0].revision_id = wrong[1].revision_id;
  rejects(() => f.commit(f.command(wrong)), 'NEEDS_RESOLUTION');
  const missing = f.entries; missing[0].revision_id = f.ids('revision');
  rejects(() => f.commit(f.command(missing)), 'NEEDS_RESOLUTION');
  assert.equal(f.state, original);
  const broken = clone(f.state), root = broken.snapshots[broken.branches[f.branch].head_snapshot_id].manifest_root_id;
  broken.blocks[root] = { schema_version: 1, block_id: root, kind: 'directory', children: [{ block_id: root, message_count: 6 }] };
  rejects(() => validateState(broken), 'NEEDS_RESOLUTION');
  const count = clone(f.state);
  count.blocks[root].children[0].message_count = 999;
  rejects(() => validateState(count), 'NEEDS_RESOLUTION');
});
test('A02 deep edit changes head without changing count/tail; old snapshots and blocks remain immutable', () => {
  const f = fixture(), before = f.state, oldHead = before.branches[f.branch].head_snapshot_id, entries = f.entries;
  const newHead = f.commit(edit(f));
  assert.notEqual(oldHead, newHead);
  assert.deepEqual(history(f.state, oldHead), entries);
  assert.equal(f.entries.length, entries.length);
  assert.deepEqual(f.entries.at(-1), entries.at(-1));
  const oldRoot = f.state.blocks[before.snapshots[oldHead].manifest_root_id];
  const newRoot = f.state.blocks[f.state.snapshots[newHead].manifest_root_id];
  assert.equal(oldRoot.children[1].block_id, newRoot.children[1].block_id);
  assert.throws(() => { f.state.snapshots[oldHead].message_count = 0; }, TypeError);
  validateState(f.state);
});
test('A03 fork from empty, User and Assistant prefixes; cutoff and anchor are checked', () => {
  const f = fixture(), parent = f.entries;
  for (const length of [0, 1, 2]) {
    const child = f.fork(length), head = f.state.branches[child].head_snapshot_id;
    assert.deepEqual(history(f.state, head), parent.slice(0, length));
    assert.equal(f.state.snapshots[head].previous_snapshot_id, null);
  }
  const base = { parent_branch_id: f.branch, source_snapshot_id: f.state.branches[f.branch].head_snapshot_id,
    prefix_length: 1, anchor: parent[1] };
  for (const fork of [base, { ...base, prefix_length: 99 }, { ...base, prefix_length: 0 }]) {
    rejects(() => f.commit(f.command([], { branch_id: f.ids('branch'), expected_head: null, change_kind: 'fork', fork })),
      'NEEDS_RESOLUTION');
  }
  validateState(f.state);
});
test('A04 parent edit/delete never invalidates child old memory or exposes future parent content', () => {
  const f = fixture(), m = f.addMemory(f.memory(f.entries.slice(0, 2)));
  const future = f.addMemory(f.memory(f.entries.slice(2, 4)));
  const child = f.fork(2), childHead = f.state.branches[child].head_snapshot_id;
  f.commit(edit(f));
  assert.equal(status(f, m), 'needs-rebuild');
  assert.equal(status(f, m, child), 'valid');
  assert.equal(status(f, future, child), 'needs-rebuild');
  f.commit(f.command(f.entries.slice(2), { change_kind: 'delete' }));
  assert.equal(status(f, m, child), 'valid');
  assert.equal(f.state.branches[child].head_snapshot_id, childHead);
  validateState(f.state);
});
test('A05 switching back to an old candidate reuses memory; restore makes a new head and rejects old prepare', () => {
  const f = fixture(), entries = f.entries, oldHead = f.state.branches[f.branch].head_snapshot_id;
  const m = f.addMemory(f.memory(entries.slice(0, 2))), request = f.prepare();
  f.commit(edit(f));
  assert.equal(status(f, m), 'needs-rebuild');
  f.commit(f.command(entries, { change_kind: 'swipe' }));
  assert.equal(status(f, m), 'valid');
  const restored = f.commit(f.command(entries, { change_kind: 'restore' }));
  assert.notEqual(restored, oldHead);
  assert.equal(f.state.snapshots[restored].manifest_root_id, f.state.snapshots[oldHead].manifest_root_id);
  rejects(() => canApply(f.state, response(request), request), 'STALE_PREPARE');
  validateState(f.state);
});
test('A06 same text is not identity; reorder preserves IDs; absent host mapping requires resolution', () => {
  const f = fixture(0), a = f.source('user', 'Same'), b = f.source('user', 'Same');
  f.commit(f.command([a.ref, b.ref], { change_kind: 'append',
    messages: [a.message, b.message], revisions: [a.revision, b.revision] }));
  assert.notEqual(a.ref.message_id, b.ref.message_id);
  f.commit(f.command([b.ref, a.ref], { change_kind: 'reorder' }));
  assert.deepEqual(f.entries, [b.ref, a.ref]);
  assert.equal(resolveIdentity(null, '0').status, 'needs-resolution');
  assert.equal(resolveIdentity({ message_map: [{ host_key: 'a', message_id: a.ref.message_id }] }, 'a').message_id, a.ref.message_id);
});
test('A07 lost acknowledgement retry returns original result before checking expected head; changed payload conflicts', () => {
  const f = fixture(), command = edit(f), result = f.commit(command);
  f.commit(edit(f, 3));
  const before = f.state;
  assert.equal(f.commit(command), result);
  assert.equal(f.state, before);
  rejects(() => f.commit({ ...command, created_at: '2026-09-19T00:00:01.000Z' }), 'OPERATION_CONFLICT');
  const identical = f.command(f.entries), oldHead = f.state.branches[f.branch].head_snapshot_id;
  assert.equal(f.commit(identical), oldHead);
  assert.equal(f.commit(identical), oldHead);
  validateState(f.state);
});
test('A08 only one stale-head competitor wins; failed validation/collision cannot change input state', () => {
  const f = fixture(), a = edit(f, 1), b = edit(f, 3);
  f.commit(a);
  const before = f.state;
  rejects(() => f.commit(b), 'HEAD_CONFLICT');
  assert.equal(f.state, before);
  const bad = f.command(f.entries, { change_kind: 'append' });
  rejects(() => f.commit(bad), 'INVALID_TRANSITION');
  const command = edit(f);
  rejects(() => commitHistory(f.state, command, kind =>
    kind === 'snapshot' ? f.state.branches[f.branch].head_snapshot_id : f.ids(kind)), 'ID_COLLISION');
  assert.equal(f.state, before);
});
test('A09 changed turn invalidates summaries/events/cumulative suffix in dependency order; unrelated turns survive', () => {
  const f = fixture(), h = hierarchy(f);
  f.commit(edit(f, 3));
  const plan = rebuildPlan(f.state, f.branch), order = plan.rebuild;
  for (const key of ['b', 'small', 'large', 'event', 'cumulative']) assert.equal(status(f, h[key]), 'needs-rebuild', key);
  for (const key of ['a', 'unrelated', 'checkpoint']) assert.equal(status(f, h[key]), 'valid', key);
  assert.ok(order.indexOf(h.b.memory_revision_id) < order.indexOf(h.small.memory_revision_id));
  assert.ok(order.indexOf(h.small.memory_revision_id) < order.indexOf(h.large.memory_revision_id));
  assert.ok(order.indexOf(h.b.memory_revision_id) < order.indexOf(h.cumulative.memory_revision_id));
  assert.equal(prepareAvailability(f.state, f.branch, [h.large.memory_revision_id]), 'not_ready');
});
test('A09 actual preceding context input propagates invalidity, even outside owned turn coverage', () => {
  const f = fixture();
  const m = f.addMemory(f.memory(f.entries.slice(4), 'TurnMemory', {
    input_refs: [f.entries[1], ...f.entries.slice(4)].map(ref => ({ type: 'source', ...ref })),
  }));
  f.commit(edit(f, 1));
  assert.equal(status(f, m), 'needs-rebuild');
});
test('A10 interval insertion/deletion/reorder changes coverage; outside prepend/append does not expire local work', () => {
  for (const action of ['insert', 'delete', 'reorder', 'append', 'prepend']) {
    const f = fixture(), m = f.addMemory(f.memory(f.entries.slice(0, 4), 'Summary'));
    const local = f.addMemory(f.memory(f.entries.slice(4)));
    const entries = f.entries, extra = f.source('user', 'Inserted');
    let messages = [], revisions = [];
    if (action === 'insert') { entries.splice(2, 0, extra.ref); messages = [extra.message]; revisions = [extra.revision]; }
    if (action === 'delete') entries.splice(2, 1);
    if (action === 'reorder') [entries[1], entries[2]] = [entries[2], entries[1]];
    if (action === 'append' || action === 'prepend') {
      entries[action === 'append' ? 'push' : 'unshift'](extra.ref);
      messages = [extra.message]; revisions = [extra.revision];
    }
    f.commit(f.command(entries, { messages, revisions }));
    assert.equal(status(f, m), ['append', 'prepend'].includes(action) ? 'valid' : 'needs-rebuild', action);
    assert.equal(status(f, local), 'valid', action);
  }
});
test('A11 cutoff never inherits half a turn or final event; noncontinuous events require span review after insertion', () => {
  const f = fixture(), turn = f.addMemory(f.memory(f.entries.slice(0, 2)));
  const members = [f.entries[0], f.entries[3]];
  const event = f.addMemory(f.memory(members, 'Event', { coverage: makeCoverage(f.entries, 'members', members) }));
  const child = f.fork(1);
  assert.equal(status(f, turn, child), 'needs-rebuild');
  assert.equal(status(f, event, child), 'needs-rebuild');
  assert.equal(status(f, turn, f.branch, 1), 'needs-rebuild');
  const extra = f.source('user', 'New member candidate'), entries = f.entries;
  entries.splice(2, 0, extra.ref);
  f.commit(f.command(entries, { messages: [extra.message], revisions: [extra.revision] }));
  assert.equal(status(f, event), 'needs-review');
  assert.deepEqual(f.state.memories[event.memory_revision_id].coverage.members, members);
  assert.deepEqual(rebuildPlan(f.state, f.branch).review, [event.memory_revision_id]);
});
test('A12 correcting a summary advances only the branch memory view; parent summaries/prepare expire, child survives', () => {
  const f = fixture(), h = hierarchy(f), child = f.fork(6);
  const request = f.prepare(), head = f.state.branches[f.branch].head_snapshot_id;
  const corrected = { ...h.a, memory_revision_id: f.ids('memoryRevision'), content: 'Corrected extraction' };
  f.addMemory(corrected);
  assert.equal(f.state.branches[f.branch].head_snapshot_id, head);
  assert.equal(status(f, h.small), 'needs-rebuild');
  assert.equal(status(f, h.small, child), 'valid');
  const current = { ...request, memory_view_version: f.state.views[f.branch].version };
  current.input_fingerprint = prepareFingerprint(current);
  rejects(() => canApply(f.state, response(request), current), 'STALE_PREPARE');
  validateState(f.state);
});
test('A13 explicit derived-only is usable in declared scope, unlike dangling references and private memories', () => {
  const f = fixture();
  const m = f.addMemory(f.memory([], 'Summary', { origin: 'derived_only', input_refs: [],
    coverage: makeCoverage([], 'members', []), source_declaration: 'Imported summary; source unavailable',
    scope_branch_id: f.branch }));
  assert.equal(status(f, m), 'valid');
  assert.equal(status(f, m, f.fork(6)), 'out-of-scope');
  const broken = f.memory(f.entries.slice(0, 2));
  broken.input_refs[0].revision_id = f.ids('revision');
  broken.input_fingerprint = derivedFingerprint(broken);
  rejects(() => archiveMemory(f.state, broken), 'NEEDS_RESOLUTION');
  assert.equal(prepareAvailability(f.state, f.branch, [f.ids('memoryRevision')]), 'needs_resolution');
  assert.equal(prepareAvailability(f.state, f.branch, []), 'empty');
  assert.equal(prepareAvailability(f.state, f.branch, [], undefined, true), 'index_behind');
  const privateMemory = f.addMemory(f.memory(f.entries.slice(0, 2), 'TurnMemory', { visibility: 'private' }));
  assert.equal(status(f, privateMemory), 'excluded');
  const excluded = f.addMemory(f.memory(f.entries.slice(0, 2), 'TurnMemory', { recall_enabled: false }));
  assert.equal(status(f, excluded), 'excluded');
});
test('A14 every prepare identity/input component and pending host observation invalidates old response', () => {
  const f = fixture(), request = f.prepare(), reply = response(request);
  assert.equal(canApply(f.state, reply, request), true);
  const changes = {
    run_id: f.ids('run'), observation_generation: 1, policy_version: 'v2', user_input: 'Changed',
    placement_profile: 'v2', cutoff_length: 5, memory_tokens_max: 500,
    story_id: f.ids('story'), branch_id: f.ids('branch'), head_snapshot_id: f.ids('snapshot'),
    binding_id: f.ids('binding'), binding_generation: 1, memory_view_version: f.ids('memoryView'),
  };
  for (const [key, value] of Object.entries(changes)) {
    const current = { ...request, [key]: value };
    current.input_fingerprint = prepareFingerprint(current);
    assert.throws(() => canApply(f.state, reply, current), undefined, key);
  }
  rejects(() => canApply(f.state, reply, request, true), 'STALE_PREPARE');
  rejects(() => canApply(f.state, { ...reply, status: 'not_ready' }, request), 'NOT_READY');
});
test('A14 background history work survives outside append but rejects its own changed sources', () => {
  const f = fixture(), pending = f.memory(f.entries.slice(0, 2));
  const extra = f.source('user', 'Later');
  f.commit(f.command([...f.entries, extra.ref], { change_kind: 'append', messages: [extra.message], revisions: [extra.revision] }));
  f.state = archiveMemory(f.state, pending);
  assert.equal(status(f, pending), 'valid');
  f.commit(edit(f));
  assert.equal(status(f, pending), 'needs-rebuild');
});
test('A15 JCS key order, ECMAScript number encoding and unmodified Unicode/text semantics', () => {
  assert.equal(canonicalize({ z: 1, a: 2 }), '{"a":2,"z":1}');
  assert.equal(canonicalize({ n: -0, small: 1e-7, huge: 1e30 }), '{"huge":1e+30,"n":0,"small":1e-7}');
  assert.equal(fingerprint('content', { a: 1, b: 2 }), fingerprint('content', { b: 2, a: 1 }));
  for (const [left, right] of [[[1, 2], [2, 1]], ['a', 'a '], ['\u00e9', 'e\u0301']]) {
    assert.notEqual(fingerprint('content', left), fingerprint('content', right));
  }
  for (const value of [NaN, Infinity, '\ud800', '\udfff', undefined, 1n, new Date(), [, 1],
    { value: undefined }, Object.defineProperty({}, 'x', { get() { throw Error('must not run'); }, enumerable: true })]) {
    rejects(() => canonicalize(value), 'INVALID_SCHEMA');
  }
  const cyclic = {}; cyclic.self = cyclic;
  rejects(() => canonicalize(cyclic), 'INVALID_SCHEMA');
  assert.equal(canonicalize('\ud83d\ude00'), '"\ud83d\ude00"');
  const f = fixture(), m = f.memory(f.entries.slice(0, 2));
  const noisy = { ...m, run_id: 'ignored-by-input-projection', provider: 'B-to-A', basis_snapshot_id: f.ids('snapshot') };
  assert.equal(derivedFingerprint(m), derivedFingerprint(noisy));
  const changed = clone(m); changed.input_refs[0].revision_id = f.ids('revision');
  assert.notEqual(derivedFingerprint(m), derivedFingerprint(changed));
});
test('A16 regenerate fixture from T-02A: deleted/ended/received and same index do not prove success or identity', () => {
  const f = fixture(), message_id = f.entries[1].message_id;
  const before = { message_id, content: 'Old marker' };
  const base = { confirmed_message_id: message_id, before, stable: true, success_confirmed: false };
  assert.equal(interpretRegenerate({ ...base, after: before }).status, 'unchanged');
  assert.equal(interpretRegenerate({ ...base, after: null, stable: false }).status, 'pending');
  assert.equal(interpretRegenerate({ ...base, after: { message_id, content: '' } }).status, 'needs-resolution');
  assert.equal(interpretRegenerate({ ...base, after: null }).status, 'needs-resolution');
  const after = { message_id, content: 'New marker' };
  assert.equal(interpretRegenerate({ ...base, after }).status, 'needs-resolution');
  assert.equal(interpretRegenerate({ ...base, after, success_confirmed: true }).status, 'revision');
  assert.equal(interpretRegenerate({ ...base, after, success_confirmed: true, confirmed_message_id: null }).status, 'needs-resolution');
  const changed = f.source('assistant', 'New marker', message_id), entries = f.entries;
  entries[1] = changed.ref;
  f.commit(f.command(entries, { change_kind: 'regenerate', revisions: [changed.revision] }));
  assert.equal(f.entries[1].message_id, message_id);
});
test('A17 pending User is normal; greeting/consecutive/unknown roles never invent a pair or lose sources', () => {
  const f = fixture(3);
  assert.equal(groupTurns(f.state, f.entries).status, 'pending');
  assert.equal(groupTurns(f.state, f.entries.slice(0, 2)).status, 'ready');
  for (const refs of [[f.entries[1]], [f.entries[0], f.entries[2]], [f.entries[1], ...f.entries]]) {
    const grouped = groupTurns(f.state, refs);
    assert.equal(grouped.status, 'unsupported');
    assert.deepEqual(grouped.turns, []);
    assert.deepEqual(grouped.sources, refs);
  }
  const orphan = f.memory([f.entries[1]]);
  rejects(() => archiveMemory(f.state, orphan), 'UNSUPPORTED');
});
test('A18 logical export/import preserves IDs, fork, order, memory selections and idempotency results', () => {
  const f = fixture(), h = hierarchy(f);
  f.fork(4); f.prepare();
  const command = edit(f); f.commit(command);
  const bundle = exportLogical(f.state), restored = importLogical(JSON.parse(JSON.stringify(bundle)));
  assert.deepEqual(restored, f.state);
  assert.equal(memoryStatus(restored, h.small.memory_revision_id, f.branch), 'needs-rebuild');
  assert.equal(commitHistory(restored, command, f.ids).snapshot_id, f.state.operations[command.operation_id].snapshot_id);
  const bad = clone(bundle); bad.state.snapshots[bad.state.branches[f.branch].head_snapshot_id].message_count++;
  rejects(() => importLogical(bad), 'NEEDS_RESOLUTION');
  bad.checksum = fingerprint('logical-export', { format_version: 1, state: bad.state });
  rejects(() => importLogical(bad), 'NEEDS_RESOLUTION');
});
test('C1 cross-story references and snapshot chain corruption cannot pass shape-only validation', () => {
  const f = fixture(), other = fixture();
  const corrupt = clone(f.state), key = Object.keys(corrupt.messages)[0];
  corrupt.messages[key].story_id = f.ids('story');
  rejects(() => validateState(corrupt), 'NEEDS_RESOLUTION');
  const cycle = clone(f.state), head = cycle.branches[f.branch].head_snapshot_id;
  cycle.snapshots[head].previous_snapshot_id = head;
  rejects(() => validateState(cycle), 'NEEDS_RESOLUTION');
  assert.deepEqual(other.entries, f.entries);
});
test('C1 binding carryover/rename is explicit and does not advance head; ambiguous mapping is rejected', () => {
  const f = fixture(), request = f.prepare(), head = f.state.branches[f.branch].head_snapshot_id;
  const binding = f.state.bindings[request.binding_id];
  f.state = bindHost(f.state, { ...binding, binding_generation: 1, intent: 'carryover', mutable_ref: 'next-fictional.jsonl' });
  assert.equal(f.state.branches[f.branch].head_snapshot_id, head);
  rejects(() => checkPrepare(f.state, request), 'STALE_PREPARE');
  rejects(() => bindHost(f.state, { ...binding, binding_generation: 2,
    message_map: [{ host_key: '0', message_id: f.entries[0].message_id }, { host_key: '0', message_id: f.entries[1].message_id }] }),
  'NEEDS_RESOLUTION');
});
test('C1 context blocks respect cutoff, privacy, uncompressed detail, origin and rerank null', () => {
  const f = fixture(), request = f.prepare();
  const block = { block_id: f.ids('contextBlock'), kind: 'TurnMemory', content: 'Fictional evidence',
    content_revision: 'fixture-v1', origin: 'source_derived',
    input_refs: [{ type: 'source', ...f.entries[0] }], source_declaration: null,
    activation_reasons: ['exact_match'], placement: { role: 'user', position: 'at_depth', depth: 0 },
    priority: 1, compressible: false, residency: 'detail',
    token_count_estimate: { value: 10, exact: false, method: 'fixture' }, visibility: 'normal', send_allowed: true };
  const reply = { ...response(request), status: 'ready', blocks: [block] };
  assert.equal(canApply(f.state, reply, request), true);
  for (const mutation of [{ visibility: 'private' }, { send_allowed: false }]) {
    rejects(() => checkResponse({ ...reply, blocks: [{ ...block, ...mutation }] }), 'FORBIDDEN');
  }
  rejects(() => checkResponse({ ...reply, blocks: [{ ...block, compressible: true }] }), 'INVALID_SCHEMA');
  rejects(() => checkResponse({ ...reply, rerank_score: 0.9 }), 'INVALID_SCHEMA');
  rejects(() => checkResponse({ ...reply, blocks: [{ ...block, input_refs: [] }] }), 'INVALID_SCHEMA');
  const unknown = { ...block, input_refs: [{ type: 'source', message_id: f.ids('message'), revision_id: f.ids('revision') }] };
  rejects(() => canApply(f.state, { ...reply, blocks: [unknown] }, request), 'NOT_READY');
});
test('C1 immutable ID collision and memory cycle rejection preserve all original inputs', () => {
  const f = fixture(), m = f.addMemory(f.memory(f.entries.slice(0, 2)));
  rejects(() => archiveMemory(f.state, { ...m, content: 'Overwrite' }), 'ID_COLLISION');
  const cycle = f.memory(f.entries.slice(0, 2), 'Summary');
  cycle.input_refs = [memoryRef(cycle)]; cycle.input_fingerprint = derivedFingerprint(cycle);
  rejects(() => archiveMemory(f.state, cycle), 'NEEDS_RESOLUTION');
  const malformed = clone(f.state); malformed.snapshots[malformed.branches[f.branch].head_snapshot_id].schema_version = 2;
  rejects(() => validateState(malformed), 'INVALID_SCHEMA');
  rejects(() => validate('message', { ...f.sources[0].message, physical_node_id: 10 }), 'INVALID_SCHEMA');
});
test('C2 seeded edit/fork/restore sequence preserves every retained snapshot and validates export', () => {
  const f = fixture();
  let seed = 20260919;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const retained = new Map(Object.keys(f.state.snapshots).map(key => [key, history(f.state, key)]));
  for (let step = 0; step < 30; step++) {
    if (step % 7 === 0) f.fork(random(7));
    else f.commit(edit(f, random(6), `Seeded marker ${step}`));
    for (const [key, entries] of retained) assert.deepEqual(history(f.state, key), entries);
    Object.keys(f.state.snapshots).forEach(key => retained.set(key, history(f.state, key)));
    validateState(f.state);
  }
  assert.deepEqual(importLogical(exportLogical(f.state)), f.state);
});

test('C3 current JSON examples match deterministic state and real input fingerprints', () => {
  const f = fixture(2), m = f.addMemory(f.memory(f.entries)), request = f.prepare();
  request.required_memory_revision_ids = [m.memory_revision_id];
  request.input_fingerprint = prepareFingerprint(request);
  const load = file => JSON.parse(readFileSync(new URL('../../../examples/' + file, import.meta.url), 'utf8'));
  const input = load('context-prepare.request.json'), output = load('context-prepare.response.json');
  assert.deepEqual(input, request);
  assert.equal(canApply(f.state, output, input), true);
});

test('C2 required pending memory cannot be disguised as empty success; unrelated scopes remain writable', () => {
  const f = fixture(), m = f.addMemory(f.memory(f.entries.slice(0, 2)));
  f.commit(edit(f));
  const request = f.prepare();
  request.required_memory_revision_ids = [m.memory_revision_id];
  request.input_fingerprint = prepareFingerprint(request);
  rejects(() => canApply(f.state, response(request), request), 'NOT_READY');
  const changed = f.source('user', 'Archive remains writable');
  f.commit(f.command([...f.entries, changed.ref], {
    change_kind: 'append', messages: [changed.message], revisions: [changed.revision],
  }));
  assert.equal(f.entries.at(-1).message_id, changed.ref.message_id);
});

test('C2 a changed nonmember span requires event review; delete/reorder never silently change event membership', () => {
  for (const action of ['delete', 'reorder']) {
    const f = fixture(), members = [f.entries[0], f.entries[3]];
    const event = f.addMemory(f.memory(members, 'Event', { coverage: makeCoverage(f.entries, 'members', members) }));
    const entries = f.entries;
    if (action === 'delete') entries.splice(1, 1);
    else [entries[1], entries[2]] = [entries[2], entries[1]];
    f.commit(f.command(entries));
    assert.equal(status(f, event), 'needs-review');
    assert.deepEqual(f.state.memories[event.memory_revision_id].coverage.members, members);
  }
});

test('C1 upper memory cannot claim a basis that excludes actual transitive context', () => {
  const f = fixture(), turn = f.addMemory(f.memory(f.entries.slice(0, 2), 'TurnMemory', {
    input_refs: [...f.entries.slice(0, 2), f.entries[5]].map(ref => ({ type: 'source', ...ref })),
  }));
  const child = f.fork(2), basis_snapshot_id = f.state.branches[child].head_snapshot_id;
  const upper = f.memory(f.entries.slice(0, 2), 'Summary', { basis_snapshot_id, input_refs: [memoryRef(turn)] });
  rejects(() => archiveMemory(f.state, upper), 'NEEDS_RESOLUTION');
});

test('C1 UTF-16 key sorting, integer-looking keys and unknown schema fields are deterministic', () => {
  assert.equal(canonicalize({ '2': 2, '10': 10 }), '{"10":10,"2":2}');
  assert.equal(canonicalize({ '\ue000': 1, '\ud83d\ude00': 2 }), '{"\ud83d\ude00":2,"\ue000":1}');
  const f = fixture(), request = f.prepare();
  rejects(() => validate('prepare', { ...request, generation_id: 'host-id' }), 'INVALID_SCHEMA');
  const missing = clone(request); delete missing.observation_generation;
  rejects(() => validate('prepare', missing), 'INVALID_SCHEMA');
});

test('C1 source object key order does not change evidence matching; malformed package envelopes are typed errors', () => {
  const f = fixture(), m = f.memory(f.entries.slice(0, 2));
  m.coverage.members = m.coverage.members.map(ref => ({ revision_id: ref.revision_id, message_id: ref.message_id }));
  m.input_fingerprint = derivedFingerprint(m);
  f.addMemory(m);
  assert.equal(status(f, m), 'valid');
  for (const invalid of [null, [], 1, 'state']) {
    rejects(() => validateState(invalid), 'INVALID_SCHEMA');
    rejects(() => importLogical(invalid), 'INVALID_SCHEMA');
  }
});
