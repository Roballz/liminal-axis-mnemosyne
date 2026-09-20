import test from 'node:test';
import assert from 'node:assert/strict';
import { openPagedTestStore, requireExternalMaintenanceFence } from '../paged-tt-adapter.mjs';

function nativeHost() {
  const nodes = new Map(), control = { gate: null, failClose: null, opens: 0, closes: 0 };
  let opened = false;
  const check = () => { if (!opened) throw Error('native namespace closed'); };
  const api = { open: async () => {
    opened = true; control.opens++;
    return {
      get: async id => { check(); return nodes.has(id) ? structuredClone(nodes.get(id)) : null; },
      upsert: async (id, vector, payload) => { check(); nodes.set(id, { id, payload: structuredClone(payload) }); },
      flush: async () => { check(); },
      stats: async () => ({ nodeCount: nodes.size }),
      close: async () => {
        control.closes++; await control.gate?.();
        if (control.failClose !== 'before') opened = false;
        if (control.failClose) throw Object.assign(Error('close failure'), { code: 'EIO' });
      },
    };
  } };
  return { api, control };
}

test('paged adapter isolates namespaces and preserves the external maintenance gate', async () => {
  const host = nativeHost();
  await assert.rejects(openPagedTestStore(host.api, 'mnemo-t03-intent'), e => e.code === 'INVALID_NAMESPACE');
  assert.throws(() => requireExternalMaintenanceFence(), e => e.code === 'HOST_MAINTENANCE_UNSUPPORTED');
});

test('paged adapter shares one owner and retires it after a successful close', async () => {
  const host = nativeHost(), namespace = 'mnemo-t03-paged-registry-test';
  const [a, b] = await Promise.all([
    openPagedTestStore(host.api, namespace, { create: true }), openPagedTestStore(host.api, namespace),
  ]);
  assert.equal(a, b);
  const oldHandle = a.handle();
  await a.close();
  await assert.rejects(a.recover(), e => e.code === 'OWNER_CLOSED');
  const replacement = await openPagedTestStore(host.api, namespace);
  assert.notEqual(replacement, a);
  await assert.rejects(oldHandle.logical(), e => e.code === 'STALE_HANDLE');
  assert.equal(host.control.closes, 1);
  await replacement.close();
});

test('paged adapter waits for a closing owner before opening its replacement', async () => {
  const host = nativeHost(), namespace = 'mnemo-t03-paged-registry-race';
  const owner = await openPagedTestStore(host.api, namespace, { create: true });
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  host.control.gate = async () => { entered(); await held; };
  const closing = owner.close(); await started;
  let opened = false;
  const opening = openPagedTestStore(host.api, namespace).then(value => { opened = true; return value; });
  await Promise.resolve(); assert.equal(opened, false);
  release(); await closing;
  const replacement = await opening;
  assert.notEqual(replacement, owner);
  await replacement.close();
});
