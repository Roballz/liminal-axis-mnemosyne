import test from 'node:test';
import assert from 'node:assert/strict';
import { Pages, PAGE_LIMITS, pageSlot } from '../pages.mjs';
import { FakeIO } from './fake-io.mjs';
const collect = async iterator => { const a = []; for await (const x of iterator) a.push(x); return a; };
const setup = () => {
  const io = new FakeIO(); let reads = 0, writes = 0;
  const get = io.get.bind(io), put = io.put.bind(io);
  io.get = async id => { reads++; return get(id); };
  io.put = async (id, value) => { writes++; return put(id, value); };
  return { io, pages: new Pages(io), counts: () => ({ reads, writes }), reset: () => { reads = writes = 0; } };
};
test('persistent exact directory: 2048 UUID-like keys, reboot cursor, immutable old root and bounded local update', async () => {
  const c = setup(), value = await c.pages.put({ kind: 'scalar', value: '正文 😀' }); let root = null;
  const key = n => `revision-${String(n).padStart(6, '0')}`;
  // Coprime permutation exercises both rotations, independent of insertion order.
  for (let i = 0; i < 2048; i++) root = await c.pages.mapSet(root, key(i * 1013 % 2048), value);
  assert.equal((await c.pages.audit(root, 'map')).count, 2048);
  await c.io.flush(); c.io.crash(); const cold = new Pages(c.io); c.reset();
  assert.deepEqual(await cold.mapGet(root, key(1837)), value); assert.ok(c.counts().reads <= 14);
  const changed = await cold.put({ kind: 'scalar', value: 'new' }); c.reset(); cold.clearCache();
  const next = await cold.mapSet(root, key(1837), changed);
  assert.ok(c.counts().writes <= 15, JSON.stringify(c.counts())); assert.ok(c.counts().reads <= 60);
  assert.deepEqual(await cold.mapGet(root, key(1837)), value); assert.deepEqual(await cold.mapGet(next, key(1837)), changed);
  const page = [];
  for await (const row of cold.mapEntries(next, key(2043))) page.push(row[0]);
  assert.deepEqual(page, [2044, 2045, 2046, 2047].map(key)); assert.ok(cold.cacheSize <= PAGE_LIMITS.cache);
  const deleted = await cold.mapDelete(next, key(1837));
  assert.equal(await cold.mapGet(deleted, key(1837)), null); assert.equal((await cold.audit(deleted, 'map')).count, 2047);
});
test('counted immutable manifest: append/edit/insert/delete/fork retain old revisions with logarithmic IO', async () => {
  const c = setup(), refs = [];
  for (let i = 0; i < 1024; i++) refs.push(await c.pages.put({ kind: 'source', message_id: `message-${i}`, revision_id: `revision-${i}` }));
  let root = await c.pages.sequence(refs), expected = [...refs]; const original = root;
  const inserted = await c.pages.put({ kind: 'source', message_id: 'new', revision_id: 'v1' });
  await c.io.flush(); c.io.crash(); const p = new Pages(c.io); c.reset();
  assert.deepEqual(await collect(p.range(root, 510, 3)), refs.slice(510, 513)); assert.ok(c.counts().reads < 30);
  for (const [start, count, incoming] of [[1024, 0, [inserted]], [100, 1, [inserted]], [3, 0, [inserted]], [800, 7, []]]) {
    const fragment = await p.sequence(incoming); p.clearCache(); c.reset();
    root = await p.splice(root, start, count, fragment); expected.splice(start, count, ...incoming);
    assert.ok(c.counts().writes <= 45, JSON.stringify(c.counts()));
    assert.ok(c.counts().reads <= 150, JSON.stringify(c.counts()));
    assert.deepEqual(await collect(p.range(root)), expected); await p.audit(root, 'sequence');
  }
  const [fork] = await p.split(root, 700); assert.deepEqual(await collect(p.range(fork)), expected.slice(0, 700));
  assert.deepEqual(await collect(p.range(original)), refs);
});
test('seeded variable sequence splices match an independent flat oracle and AVL/count invariants', async () => {
  const c = setup(), refs = [];
  for (let i = 0; i < 43; i++) refs.push(await c.pages.put({ kind: 'value', i }));
  let seed = 73013, root = null, expected = [];
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 400; i++) {
    const offset = random(expected.length + 1), remove = random(Math.min(15, expected.length - offset) + 1);
    const items = Array.from({ length: random(20) }, () => refs[random(refs.length)]);
    root = await c.pages.splice(root, offset, remove, await c.pages.sequence(items)); expected.splice(offset, remove, ...items);
    assert.deepEqual(await collect(c.pages.range(root)), expected, `seed=73013 step=${i}`);
    await c.pages.audit(root, 'sequence');
  }
});
test('long append growth keeps depth and per-append writes bounded', async () => {
  const c = setup(), one = await c.pages.put({ kind: 'v', value: 1 }), leaf = await c.pages.sequence([one]); let root = null;
  let maximumWrites = 0;
  for (let i = 0; i < 4096; i++) {
    c.reset(); root = await c.pages.concat(root, leaf); maximumWrites = Math.max(maximumWrites, c.counts().writes);
  }
  const audit = await c.pages.audit(root, 'sequence'); assert.equal(audit.count, 4096);
  assert.ok(audit.height <= 14); assert.ok(maximumWrites <= 25, `${maximumWrites}`);
});
test('physical hash-address collision is rejected before overwriting data', async () => {
  const io = new FakeIO(), p = new Pages(io, { address: () => 65536 });
  const first = await p.put({ value: 'one' }), before = structuredClone(io.live);
  await assert.rejects(p.put({ value: 'two' }), e => e.code === 'ID_COLLISION');
  assert.deepEqual(io.live, before); assert.deepEqual(await p.get(first), { value: 'one' });
});
for (const kind of ['missing', 'checksum', 'address', 'oversize']) test(`page audit refuses ${kind}`, async () => {
  const c = setup(), ref = await c.pages.put({ value: 'safe' }); c.pages.clearCache();
  if (kind === 'missing') c.io.live.delete(ref.slot);
  if (kind === 'checksum') c.io.live.get(ref.slot).body.value = 'changed';
  if (kind === 'address') ref.slot++;
  if (kind === 'oversize') c.io.live.get(ref.slot).body.value = 'x'.repeat(9000);
  await assert.rejects(c.pages.get(ref), e => e.code === 'NEEDS_RESOLUTION');
});
test('checksum-valid invalid directory count and map ordering are rejected by explicit structural audit', async () => {
  const c = setup(), v = await c.pages.put({ value: 0 }), leaf = await c.pages.sequence([v]);
  const bad = await c.pages.put({ kind: 'rope', left: leaf, right: leaf, height: 2, count: 20 });
  await assert.rejects(c.pages.audit(bad, 'sequence'), e => e.code === 'NEEDS_RESOLUTION');
  const left = await c.pages.mapSet(null, 'z', v);
  const map = await c.pages.put({ kind: 'map', key: 'a', value: v, left, right: null, height: 2 });
  await assert.rejects(c.pages.audit(map, 'map'), e => e.code === 'NEEDS_RESOLUTION');
});
test('page write failure cannot change any published old root', async () => {
  const c = setup(), v = await c.pages.put({ value: 0 }), root = await c.pages.mapSet(null, 'a', v); await c.io.flush();
  c.io.fail = { label: 'page-write', edge: 'after', n: 1, durable: true };
  await assert.rejects(c.pages.mapSet(root, 'b', v)); c.io.crash();
  const p = new Pages(c.io); assert.deepEqual(await collect(p.mapEntries(root)), [['a', v]]);
});
