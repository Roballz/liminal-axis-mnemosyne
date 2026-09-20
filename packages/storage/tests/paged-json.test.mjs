import test from 'node:test';
import assert from 'node:assert/strict';
import { Pages } from '../pages.mjs';
import { PagedJSON } from '../paged-json.mjs';
import { FakeIO } from './fake-io.mjs';
import { canonicalize } from '../../contracts/primitives.mjs';
test('JSON reference pages preserve text, null, empty containers, own special keys and logical fingerprint', async () => {
  const io = new FakeIO(), json = new PagedJSON(new Pages(io));
  const data = JSON.parse('{"__proto__":{"x":1},"empty":[],"emptyMap":{},"null":null}');
  data.text = '中文\r\n😀'.repeat(2000); data.command = { entries: Array.from({ length: 64 }, (_, i) => ({ message_id: `m-${i}`, revision_id: `r-${i}` })) };
  const root = await json.write(data); await io.flush(); io.crash();
  const cold = new PagedJSON(new Pages(io)); assert.equal(canonicalize(await cold.read(root)), canonicalize(data));
  assert.ok([...io.live.values()].every(p => new TextEncoder().encode(canonicalize(p)).length <= 8192));
});
test('nested manifest/view/expected/marker/directory paths share all unchanged subtrees', async () => {
  const io = new FakeIO(), pages = new Pages(io), json = new PagedJSON(pages);
  const state = { branches: {}, operations: {}, views: { v: { selections: {}, corrections: {} } }, expected: {}, markers: {} };
  for (let i = 0; i < 400; i++) {
    state.branches[`b-${i}`] = { head: `h-${i}` }; state.views.v.selections[`m-${i}`] = `mr-${i}`;
    state.views.v.corrections[`old-${i}`] = `new-${i}`; state.expected[`b-${i}`] = `h-${i}`;
    state.markers[`b-${i}`] = { index: 'behind' };
  }
  const root = await json.write(state), oldBranches = await json.at(root, ['branches']);
  let writes = 0; const put = io.put.bind(io); io.put = async (key, value) => { writes++; return put(key, value); };
  const changed = await json.set(root, ['views', 'v', 'corrections', 'old-211'], await json.write('replacement'));
  assert.ok(writes < 30, `${writes}`); assert.deepEqual(await json.at(changed, ['branches']), oldBranches);
  assert.equal(await json.read(await json.at(root, ['views', 'v', 'corrections', 'old-211'])), 'new-211');
  assert.equal(await json.read(await json.at(changed, ['views', 'v', 'corrections', 'old-211'])), 'replacement');
});
test('command.entries and fixed fork use shared ropes while preserving exact original command JSON', async () => {
  const json = new PagedJSON(new Pages(new FakeIO())), original = { command: { entries: Array.from({ length: 100 }, (_, i) => ({ i })) } };
  const root = await json.write(original), appended = await json.splice(root, ['command', 'entries'], 100, 0, await json.write([{ i: 100 }]));
  assert.deepEqual(await json.read(root), original); assert.deepEqual((await json.read(appended)).command.entries.at(-1), { i: 100 });
  const fork = await json.splice(appended, ['command', 'entries'], 40, 61, await json.write([]));
  assert.equal((await json.read(fork)).command.entries.length, 40); assert.equal((await json.read(appended)).command.entries.length, 101);
});
test('full materialization has explicit budgets; local scalar access does not traverse unrelated data', async () => {
  const io = new FakeIO(), json = new PagedJSON(new Pages(io)), root = await json.write({ huge: 'x'.repeat(10000), small: 17 });
  await assert.rejects(json.read(root, { maxBytes: 100 }), e => e.code === 'RESOURCE_LIMIT');
  const cold = new PagedJSON(new Pages(io)); let reads = 0; const get = io.get.bind(io);
  io.get = async key => { reads++; return get(key); };
  assert.equal(await cold.read(await cold.at(root, ['small'])), 17); assert.ok(reads < 8);
});
