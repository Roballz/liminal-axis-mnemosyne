import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestStore } from '../tt-adapter.mjs';
import { StoreOwner, FORMAT, prepareTransaction } from '../protocol.mjs';
import { commitHistory, history } from '../../contracts/index.mjs';
import { scenario } from './scenario.mjs';
import { FakeIO } from './fake-io.mjs';

// Like TT, old native handles dispatch to the current namespace instance.
function host() {
  const nodes = new Map(), calls = { open: 0, close: 0, write: 0 };
  let opened = false;
  const control = { failure: null, gate: null };
  const checkOpen = () => { if (!opened) throw Error('native namespace closed'); };
  const api = { open: async () => {
    opened = true; calls.open++;
    return {
      get: async id => { checkOpen(); return nodes.has(id) ? structuredClone(nodes.get(id)) : null; },
      upsert: async (id, vector, payload) => { checkOpen(); calls.write++; nodes.set(id, { id, payload: structuredClone(payload) }); },
      flush: async () => { checkOpen(); },
      close: async () => {
        calls.close++; await control.gate?.();
        if (control.failure !== 'before') opened = false;
        if (control.failure) throw Object.assign(Error('injected close error'), { code: 'EIO' });
      },
    };
  } };
  return { api, nodes, calls, control };
}
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);
for (const [label, root] of [
  ['missing-tip', { format: FORMAT, kind: 'root', staging: false }],
  ['string-tip', { format: FORMAT, kind: 'root', staging: false, tip: '1' }],
  ['zero-tip', { format: FORMAT, kind: 'root', staging: false, tip: 0 }],
  ['negative-tip', { format: FORMAT, kind: 'root', staging: false, tip: -1 }],
  ['fraction-tip', { format: FORMAT, kind: 'root', staging: false, tip: 1.5 }],
  ['missing-staging', { format: FORMAT, kind: 'root', tip: null }],
  ['wrong-format', { format: 'unknown', kind: 'root', staging: false, tip: null }],
]) test(`G1-R2 invalid root ${label} rejects without accepting an empty library`, async () => {
  const io = new FakeIO(), owner = new StoreOwner(io), handle = await owner.recover();
  await handle.commit(scenario().requests[0]); await io.put(0, root); await io.flush(); io.crash();
  const before = structuredClone(io.live), reopened = new StoreOwner(io);
  await rejects(reopened.recover(), 'NEEDS_RESOLUTION'); assert.equal(reopened.status, 'recovery-required');
  await rejects(reopened.handle().read(), 'RECOVERY_REQUIRED'); assert.deepEqual(io.live, before);
});
for (const [label, node] of [['null-payload', { id: 1, payload: null }], ['missing-payload', { id: 1 }],
  ['array-payload', { id: 1, payload: [] }], ['undefined-node', undefined]]) {
  test(`G1-R2 malformed native node ${label} is never mapped to absence`, async () => {
    const h = host(), ns = 'mnemo-t03-g1-corrupt', a = await openTestStore(h.api, ns);
    await a.handle().commit(scenario().requests[0]); await a.close(); h.nodes.set(1, node);
    const before = structuredClone(h.nodes), writes = h.calls.write;
    await rejects(openTestStore(h.api, ns), 'NEEDS_RESOLUTION');
    assert.deepEqual(h.nodes, before); assert.equal(h.calls.write, writes);
  });
}
test('G1-R2 null payload in a non-root slot also rejects', async () => {
  const h = host(), ns = 'mnemo-t03-g1-object', a = await openTestStore(h.api, ns);
  await a.handle().commit(scenario().requests[0]); await a.close(); h.nodes.set(2, { id: 2, payload: null });
  await rejects(openTestStore(h.api, ns), 'NEEDS_RESOLUTION');
});
test('G1-R2 true empty, explicit null tip and staging remain legal', async () => {
  for (const root of [null, { format: FORMAT, kind: 'root', tip: null, staging: false },
    { format: FORMAT, kind: 'root', tip: null, staging: true }]) {
    const io = new FakeIO(); if (root) await io.put(0, root);
    const owner = new StoreOwner(io); const h = await owner.recover();
    assert.equal(owner.status, root?.staging ? 'staging' : 'ready');
    if (!root?.staging) assert.equal(Object.keys((await h.read()).stories).length, 0);
  }
});
test('G1-R2 first publication failure preserves orphans and allows exact retry', async () => {
  const io = new FakeIO(), a = new StoreOwner(io), request = scenario().requests[0];
  const h = await a.recover(); io.fail = { label: 'publish', edge: 'before', n: 1 };
  await rejects(h.commit(request), 'RECOVERY_REQUIRED'); io.fail = null; io.crash();
  assert.equal(await io.get(0), null); const count = io.live.size; assert.ok(count > 0);
  const b = new StoreOwner(io), recovered = await b.recover(); assert.equal(b.ledger.size, 0);
  assert.equal(io.live.size, count); assert.deepEqual(await recovered.commit(request), request.result);
});
function competing(s) {
  const before = s.states[0], f = s.f, entries = history(before, before.branches[f.branch].head_snapshot_id);
  const changed = f.source('assistant', 'G1 competing edit', entries[1].message_id); entries[1] = changed.ref;
  const command = f.command(entries, { change_kind: 'edit', revisions: [changed.revision],
    expected_head: before.branches[f.branch].head_snapshot_id });
  const result = commitHistory(before, command, f.ids);
  return prepareTransaction(before, result.state, f.ids('operation'), { snapshot: result.snapshot_id });
}
async function retained(api, ns, owner, s) {
  await owner.close(); const reopened = await openTestStore(api, ns);
  assert.deepEqual(await reopened.handle().read(), s.states[1]);
  for (const r of s.requests.slice(0, 2)) assert.deepEqual(await reopened.handle().commit(r), r.result);
  assert.equal(reopened.ledger.size, 2);
}
test('G1-R1 successful close permanently retires owner; repeated close cannot affect replacement', async () => {
  const h = host(), ns = 'mnemo-t03-g1-retire', s = scenario();
  const a = await openTestStore(h.api, ns); await a.handle().commit(s.requests[0]); await a.close();
  const b = await openTestStore(h.api, ns); assert.notEqual(a, b);
  const calls = { ...h.calls };
  await rejects(a.recover(), 'OWNER_CLOSED'); await a.close(); await a.close();
  await rejects(a.io.close(), 'OWNER_CLOSED');
  assert.deepEqual(h.calls, calls); assert.equal(await openTestStore(h.api, ns), b);
  const results = await Promise.allSettled([b.handle().commit(s.requests[1]), b.handle().commit(competing(s))]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'STALE_WRITE');
  await retained(h.api, ns, b, s);
});
for (const failure of ['before', 'after']) test(`G1-R1 failed ${failure} close retains one quarantined owner`, async () => {
  const h = host(), ns = 'mnemo-t03-g1-failed', s = scenario();
  const a = await openTestStore(h.api, ns), old = a.handle(); await old.commit(s.requests[0]);
  h.control.failure = failure; await rejects(a.close(), 'EIO');
  const b = await openTestStore(h.api, ns); assert.equal(a, b);
  await rejects(old.read(), 'STALE_HANDLE'); await rejects(b.handle().read(), 'RECOVERY_REQUIRED');
  h.control.failure = null; const recovered = await a.recover();
  const results = await Promise.allSettled([recovered.commit(s.requests[1]), b.handle().commit(competing(s))]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'STALE_WRITE');
  await retained(h.api, ns, b, s);
});
test('G1-R1 open waits for close; queued recover cannot resurrect or evict replacement', async () => {
  const h = host(), ns = 'mnemo-t03-g1-race'; const a = await openTestStore(h.api, ns);
  let release, entered;
  const held = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  h.control.gate = async () => { entered(); await held; };
  const closing = a.close(); await started;
  let done = false; const opening = openTestStore(h.api, ns).then(b => { done = true; return b; });
  const recovery = rejects(a.recover(), 'OWNER_CLOSED');
  await Promise.resolve(); assert.equal(done, false); release(); await closing; await recovery;
  const b = await opening; assert.notEqual(a, b); const closes = h.calls.close;
  await a.close(); assert.equal(h.calls.close, closes); assert.equal(await openTestStore(h.api, ns), b);
});
test('G1-R1 failed close can retry close without creating a second owner', async () => {
  const h = host(), ns = 'mnemo-t03-g1-retry-close', a = await openTestStore(h.api, ns);
  h.control.failure = 'before'; await rejects(a.close(), 'EIO');
  assert.equal(await openTestStore(h.api, ns), a);
  h.control.failure = null; await a.close(); const b = await openTestStore(h.api, ns);
  assert.notEqual(a, b); await rejects(a.recover(), 'OWNER_CLOSED');
  assert.equal(await openTestStore(h.api, ns), b);
});
