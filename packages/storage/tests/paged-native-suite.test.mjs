import test from 'node:test';
import assert from 'node:assert/strict';
import { runPagedNative } from '../native/paged-suite.mjs';

function nativeHost() {
  const stores = new Map();
  let active = null;
  const check = () => { if (!active) throw Error('native namespace closed'); };
  return { open: async namespace => {
    const nodes = stores.get(namespace) ?? new Map(); stores.set(namespace, nodes); active = namespace;
    return {
      get: async id => { check(); return nodes.has(id) ? structuredClone(nodes.get(id)) : null; },
      upsert: async (id, vector, payload) => { check(); nodes.set(id, { id, payload: structuredClone(payload) }); },
      flush: async () => { check(); },
      stats: async () => ({ nodeCount: nodes.size }),
      close: async () => { active = null; },
    };
  } };
}

test('paged native suite roundtrip exercises the TT-shaped adapter path', async () => {
  const events = [];
  await runPagedNative(nativeHost(), { phase: 'paged-roundtrip', run: 'smoke' }, async event => events.push(event));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).phase, 'paged-roundtrip');
  assert.equal(events.at(-1).pendingIdRestore, true);
  assert.equal(events.at(-1).historyDelta, true);
});
