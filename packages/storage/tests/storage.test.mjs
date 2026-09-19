import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { sha256 } from '../../contracts/runtime.mjs';
import { canonicalize, fingerprint, emptyState, validateState, memoryStatus, exportLogical } from '../../contracts/index.mjs';
import { StoreOwner, prepareTransaction, inspectBundle, importIntoEmpty, expected, recoveryMarkers } from '../protocol.mjs';
import { FakeIO } from './fake-io.mjs';
import { scenario } from './scenario.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { openTestStore } from '../tt-adapter.mjs';

const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);
const setup = async () => { const io = new FakeIO(), owner = new StoreOwner(io); return { io, owner, handle: await owner.recover() }; };
test('portable SHA-256 equals Node and WebCrypto at padding/UTF8 boundaries; JCS fingerprints unchanged', async () => {
  for (const size of [0,1,7,55,56,63,64,65,127,128,1024,65536]) {
    const text = 'a'.repeat(size) + (size % 2 ? '中文😀\r\n' : '');
    const node = createHash('sha256').update(text).digest('hex');
    const browser = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
    assert.equal(sha256(text), node); assert.equal(sha256(text), browser);
  }
  const payload = { z: '中文😀\n', a: [-0, 1e30, true, null] };
  const native = createHash('sha256').update(canonicalize({ purpose: 'content', version: 1, payload })).digest('hex');
  assert.equal(fingerprint('content', payload), `sha256:content:v1:${native}`);
});

test('two stories/fixed fork/correction/edit/binding replay through exact physical IDs and domain validation', async () => {
  const { io, handle } = await setup(), s = scenario();
  for (const request of s.requests) assert.deepEqual(await handle.commit(request), request.result);
  io.crash(); const recovered = await new StoreOwner(io).recover(), state = await recovered.read();
  assert.deepEqual(state, s.f.state); validateState(state);
  assert.equal(memoryStatus(state, s.old.memory_revision_id, s.child), 'valid');
  assert.equal(memoryStatus(state, s.fixed.memory_revision_id, s.f.branch), 'needs-rebuild');
  const bundle = await recovered.export(); inspectBundle(bundle);
  assert.deepEqual(bundle.logical, exportLogical(s.f.state));
  for (const request of s.requests) assert.deepEqual(await recovered.commit(request), request.result);
});

const faults = [
  ['object', 'before', 1], ['object', 'after', 2], ['commit-record', 'before', 1],
  ['commit-record', 'after', 1], ['prepare-flush', 'before', 1], ['prepare-flush', 'after', 1],
  ['publish', 'before', 1], ['publish', 'after', 1], ['publish-flush', 'before', 1],
  ['publish-flush', 'after', 1], ['ack', 'before', 1], ['ack', 'after', 1],
];
for (const step of [1, 2, 3, 4]) for (const [label, edge, n] of faults) {
  test(`fault seed=20260919 step=${step} ${label}/${edge}/${n}: retain acknowledged state, recover and retry`, async t => {
    const { io, owner, handle } = await setup(), s = scenario();
    for (const r of s.requests.slice(0, step)) await handle.commit(r);
    const before = await handle.read(), request = s.requests[step];
    io.fail = { label, edge, n, durable: label === 'publish' && edge === 'after' };
    await rejects(handle.commit(request), 'RECOVERY_REQUIRED');
    await rejects(handle.read(), 'RECOVERY_REQUIRED');
    io.fail = null; io.crash();
    const replacement = new StoreOwner(io), recovered = await replacement.recover();
    const after = await recovered.read(); validateState(after);
    const committed = ['publish-flush', 'ack'].includes(label) && !(label === 'publish-flush' && edge === 'before') ||
      label === 'publish' && edge === 'after';
    if (!committed) assert.deepEqual(after, before);
    else assert.deepEqual(after, s.states[step]);
    if (after.branches[s.child]) assert.equal(memoryStatus(after, s.old.memory_revision_id, s.child), 'valid');
    assert.deepEqual(await recovered.commit(request), request.result);
    assert.deepEqual(await recovered.commit(request), request.result);
    assert.deepEqual(await recovered.read(), s.states[step]);
    assert.equal(replacement.ledger.size, step + 1);
    assert.equal(owner.status, 'recovery-required');
    t.diagnostic(JSON.stringify({ seed: 20260919, step, label, edge, ordinal: n, operation: request.operation_id,
      acknowledged: false, before: expected(before), recovered: expected(after),
      retried: expected(await recovered.read()), ledgerCount: replacement.ledger.size, validation: 'passed',
      provider: 'deterministic-fake' }));
  });
}

test('same operation different request conflicts before stale checks, including after restart', async () => {
  const { io, handle } = await setup(), { requests } = scenario();
  await handle.commit(requests[0]);
  const next = await new StoreOwner(io).recover();
  await rejects(next.commit({ ...requests[0], result: { changed: true } }), 'OPERATION_CONFLICT');
  assert.deepEqual(await next.commit(requests[0]), requests[0].result);
});
test('two handles share queue; old Head/view/binding writes reject', async () => {
  const { owner, handle } = await setup(), { requests, f } = scenario();
  await handle.commit(requests[0]);
  const competitor = { ...requests[1], operation_id: f.ids('operation') };
  const result = await Promise.allSettled([handle.commit(requests[1]), owner.handle().commit(competitor)]);
  assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].reason.code, 'STALE_WRITE');
  await handle.commit(requests[2]);
  for (const field of ['heads', 'views', 'bindings']) {
    const altered = structuredClone(requests[3]); altered.operation_id = f.ids('operation');
    altered.expected[field] = {};
    await rejects(handle.commit(altered), 'STALE_WRITE');
  }
});
test('stopping a waiter does not release native ownership; close queues then revokes handles', async () => {
  const { io, owner, handle } = await setup(), { requests } = scenario();
  let release, entered; const held = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  io.point = async (label, edge) => { if (label === 'publish' && edge === 'after') { entered(); await held; } };
  const pending = handle.commit(requests[0]); await started;
  assert.equal(await Promise.race([pending, Promise.resolve('waiter-cancelled')]), 'waiter-cancelled');
  let secondDone = false;
  const second = owner.handle().commit(requests[1]).then(() => { secondDone = true; });
  const closing = owner.close();
  await Promise.resolve(); assert.equal(secondDone, false);
  io.point = null; release(); await pending; await second; await closing;
  await rejects(handle.read(), 'STALE_HANDLE');
  await rejects(owner.recover(), 'OWNER_CLOSED');
  const reopened = await new StoreOwner(io).recover();
  assert.deepEqual(await reopened.commit(requests[1]), requests[1].result);
});
test('IO/ENOSPC before and after write never report success or erase previous data', async () => {
  for (const edge of ['before', 'after']) {
    const { io, handle } = await setup(), { requests } = scenario(); await handle.commit(requests[0]);
    io.fail = { label: 'object', edge, n: 1, code: 'ENOSPC' };
    await assert.rejects(handle.commit(requests[1]), e => e.code === 'RECOVERY_REQUIRED' && e.cause.code === 'ENOSPC');
    io.fail = null; io.crash(); const recovered = await new StoreOwner(io).recover();
    assert.deepEqual(await recovered.commit(requests[0]), requests[0].result);
  }
});
test('R5 contradiction with valid checksum rejected before publishing; damaged references fail closed', async () => {
  const { io, handle } = await setup(), { requests, old, fixed, f } = scenario();
  for (const r of requests.slice(0, 3)) await handle.commit(r);
  const state = await handle.read(), bad = structuredClone(state);
  bad.views[f.branch].selections[old.memory_id] = old.memory_revision_id;
  const payload = { format_version: 2, state: bad };
  const bundle = await handle.export();
  const wrong = { ...bundle, logical: { ...payload, checksum: fingerprint('logical-export', payload) } };
  const { checksum, ...rest } = wrong;
  wrong.checksum = fingerprint('write-payload', rest);
  assert.throws(() => inspectBundle(wrong), e => e.code === 'NEEDS_RESOLUTION');
  assert.equal(state.views[f.branch].selections[old.memory_id], fixed.memory_revision_id);
  const root = await io.get(0), record = await io.get(root.tip);
  io.live.delete(record.markers); await io.flush();
  await rejects(new StoreOwner(io).recover(), 'NEEDS_RESOLUTION');
});

test('small import restores the independent ledger and rejects a nonempty target', async () => {
  const source = await setup(), target = await setup(), s = scenario();
  for (const request of s.requests) await source.handle.commit(request);
  const bundle = await source.handle.export();
  const handle = await importIntoEmpty(target.owner, bundle);
  assert.deepEqual(await handle.read(), s.f.state);
  await target.owner.close(); await rejects(target.owner.recover(), 'OWNER_CLOSED');
  target.owner = new StoreOwner(target.io); const reopened = await target.owner.recover();
  for (const request of s.requests) assert.deepEqual(await reopened.commit(request), request.result);
  await rejects(importIntoEmpty(target.owner, bundle), 'IMPORT_TARGET_NOT_EMPTY');
  assert.deepEqual(await source.handle.export(), bundle);
});
for (const [label, edge, n] of [['object', 'after', 2], ['publish', 'after', 2], ['import-activate', 'before', 1], ['import-activate', 'after', 1]]) {
  test(`interrupted staging import ${label}/${edge}: never expose a partial active library`, async () => {
    const source = await setup(), target = await setup(), s = scenario();
    for (const request of s.requests) await source.handle.commit(request);
    const bundle = await source.handle.export(); target.io.fail = { label, edge, n };
    await assert.rejects(importIntoEmpty(target.owner, bundle));
    target.io.fail = null; target.io.crash();
    const newOwner = new StoreOwner(target.io), recovered = await newOwner.recover();
    if (label === 'import-activate' && edge === 'after') assert.deepEqual(await recovered.read(), s.f.state);
    else { assert.equal(newOwner.status, 'staging'); await rejects(recovered.read(), 'RECOVERY_REQUIRED'); }
    assert.deepEqual(await source.handle.export(), bundle);
  });
}
test('valid outer checksum cannot conceal forged retry ledger or missing replay materials', async () => {
  const source = await setup(), s = scenario(); await source.handle.commit(s.requests[0]);
  for (const tamper of [b => { b.ledger[0][1].result = null; }, b => { b.journal = []; }]) {
    const bundle = structuredClone(await source.handle.export()); tamper(bundle);
    const { checksum, ...payload } = bundle; bundle.checksum = fingerprint('write-payload', payload);
    assert.throws(() => inspectBundle(bundle), e => e.code === 'NEEDS_RESOLUTION');
  }
});
test('export snapshot stays fixed while the source continues committing', async () => {
  const { handle } = await setup(), { requests } = scenario(); await handle.commit(requests[0]);
  const bundle = await handle.export(); await handle.commit(requests[1]);
  inspectBundle(bundle); assert.equal(bundle.journal.length, 1);
  assert.equal((await handle.export()).journal.length, 2);
});
test('P2 rejects a valid oversized history and oversized compiled request without writes', async () => {
  const large = fixture(34); validateState(large.state);
  assert.throws(() => prepareTransaction(emptyState(), large.state, large.ids('operation'), null), e => e.code === 'P2_LIMIT');
  const { io, handle } = await setup(), { requests } = scenario();
  await rejects(handle.commit({ ...requests[0], result: 'x'.repeat(262145) }), 'P2_LIMIT');
  assert.equal(io.live.size, 0);
});
test('TT adapter maps publication to physical ID 1 and shares one owner across opens', async () => {
  const nodes = new Map(), writes = [];
  const api = { open: async () => ({
    get: async id => { assert.ok(id > 0); return nodes.has(id) ? { payload: structuredClone(nodes.get(id)) } : null; },
    upsert: async (id, vector, payload) => { assert.ok(id > 0); assert.deepEqual(vector, [1,0]); writes.push(id); nodes.set(id, structuredClone(payload)); },
    flush: async () => {}, close: async () => {},
  }) };
  const [a, b] = await Promise.all([openTestStore(api, 'mnemo-t03-test'), openTestStore(api, 'mnemo-t03-test')]);
  assert.equal(a, b); await a.handle().commit(scenario().requests[0]);
  assert.ok(writes.includes(1)); assert.equal(nodes.get(1).kind, 'root');
  const old = a.handle(); await a.close();
  await rejects(old.read(), 'STALE_HANDLE');
  const c = await openTestStore(api, 'mnemo-t03-test'); assert.notEqual(c, a);
  assert.equal(c.ledger.size, 1);
});
test('immutable collision and cross-story rebinding rejected; P2 bounds are explicit', async () => {
  const { handle } = await setup(), { requests, f } = scenario();
  for (const r of requests) await handle.commit(r);
  const state = await handle.read(), revision = Object.values(state.revisions)[0];
  await rejects(handle.commit({ format: requests[0].format, operation_id: f.ids('operation'),
    expected: expected(state), changes: [{ table: 'revisions', key: revision.revision_id,
      value: { ...revision, content: 'overwrite' } }], result: null }), 'ID_COLLISION');
  const binding = Object.values(state.bindings)[0];
  await rejects(handle.commit({ format: requests[0].format, operation_id: f.ids('operation'),
    expected: expected(state), changes: [{ table: 'bindings', key: binding.binding_id,
      value: { ...binding, story_id: f.ids('story'), binding_generation: 2 } }], result: null }), 'STALE_WRITE');
  assert.throws(() => prepareTransaction(emptyState(), { ...state,
    memories: { ...state.memories, extra: {} } }, f.ids('operation'), null));
  assert.equal(recoveryMarkers(state)[f.branch].index, 'behind');
});
