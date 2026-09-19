import test from 'node:test';
import assert from 'node:assert/strict';
import { openIntentTestStore, requireExternalMaintenanceFence } from '../intent-tt-adapter.mjs';
import { openTestStore } from '../tt-adapter.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
function nativeHost() {
  let opened = false, nodes = new Map();
  const control = { failClose: null, gate: null, closes: 0, opens: 0 };
  const check = () => { if (!opened) throw Error('closed'); };
  const api = { open: async () => {
    opened = true; control.opens++;
    return {
      get: async id => { check(); return nodes.has(id) ? structuredClone(nodes.get(id)) : null; },
      upsert: async (id, vector, payload) => { check(); nodes.set(id, { id, payload: structuredClone(payload) }); },
      flush: async () => { check(); }, stats: async () => ({ nodeCount: nodes.size }),
      close: async () => {
        control.closes++; await control.gate?.();
        if (control.failClose !== 'before') opened = false;
        if (control.failClose) throw Error('close failure');
      },
    };
  } };
  return { api, control, replace: () => { nodes = new Map(); } };
}
const ns = 'mnemo-t03-p3-registry-test';
const input = () => { const f = fixture(2), command = Object.values(f.state.operations)[0].command;
  return { operation_id: command.operation_id, kind: 'history', payload: command }; };

test('P2 adapter cannot open P3 namespaces, and production maintenance gate stays closed', async () => {
  await assert.rejects(openTestStore({}, ns));
  await assert.rejects(openIntentTestStore({}, 'mnemo-t03-old'));
  assert.throws(() => requireExternalMaintenanceFence(), e => e.code === 'HOST_MAINTENANCE_UNSUPPORTED');
});

test('all diagnostic openers share one coordinator; close/open waits for drain', async () => {
  const host = nativeHost();
  const [a, b] = await Promise.all([openIntentTestStore(host.api, ns, { create: true }), openIntentTestStore(host.api, ns)]);
  assert.equal(a, b); const request = input(); await a.handle().prepare(request); await a.handle().execute(request.operation_id);
  let release, entered; const held = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  host.control.gate = async () => { entered(); await held; };
  const closing = a.close(); await ready;
  let opened = false; const opening = openIntentTestStore(host.api, ns).then(v => { opened = true; return v; });
  await Promise.resolve(); assert.equal(opened, false); release(); await closing;
  const replacement = await opening; assert.notEqual(replacement, a);
  const closes = host.control.closes; await a.close(); assert.equal(host.control.closes, closes);
  await assert.rejects(a.recover(), e => e.code === 'OWNER_CLOSED');
  assert.equal((await replacement.handle().lookup(request.operation_id)).status, 'published');
});

for (const failure of ['before', 'after']) test(`failed native close ${failure} retains registration and recovers in place`, async () => {
  const host = nativeHost(), owner = await openIntentTestStore(host.api, ns, { create: true }), request = input();
  await owner.handle().prepare(request); host.control.failClose = failure;
  await assert.rejects(owner.close()); assert.equal(await openIntentTestStore(host.api, ns), owner);
  host.control.failClose = null;
  const h = await owner.recover(); assert.equal((await h.pending()).length, 1); await h.execute(request.operation_id);
});

test('namespace-only host counterexample: identity read cannot fence later old-handle write', async () => {
  const host = nativeHost(), old = await host.api.open(ns);
  await old.upsert(1, [1, 0], { library: 'A' }); assert.equal((await old.get(1)).payload.library, 'A');
  await old.close(); host.replace(); const current = await host.api.open(ns);
  await current.upsert(1, [1, 0], { library: 'B' });
  await old.upsert(2, [1, 0], { from: 'A' });
  assert.equal((await current.get(1)).payload.library, 'B'); assert.equal((await current.get(2)).payload.from, 'A');
  // This passing counterexample is evidence of a missing fence, not acceptance.
});
