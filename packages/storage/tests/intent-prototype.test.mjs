import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentCoordinator, IDENTITY_SLOT } from '../intent-prototype.mjs';
import { FakeIO } from './fake-io.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { fingerprint } from '../../contracts/primitives.mjs';

const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
async function setup() {
  const io = new FakeIO(), coordinator = new IntentCoordinator(io), handle = await coordinator.create();
  const f = fixture(2), command = Object.values(f.state.operations)[0].command;
  const input = { operation_id: command.operation_id, kind: 'history', payload: command };
  return { io, coordinator, handle, f, input };
}
async function initialized() {
  const c = await setup(); await c.handle.prepare(c.input); await c.handle.execute(c.input.operation_id);
  c.f.state = await c.handle.read(); return c;
}
function nextRequest(c, kind) {
  const { f } = c;
  if (kind === 'history') {
    const source = f.source('user', '虚构追加 😀');
    const command = f.command([...f.entries, source.ref], { change_kind: 'append', messages: [source.message], revisions: [source.revision] });
    return { operation_id: command.operation_id, kind, payload: command };
  }
  if (kind === 'binding') {
    f.prepare();
    return { operation_id: f.ids('operation'), kind, payload: Object.values(f.state.bindings)[0] };
  }
  const memory = f.memory(f.entries);
  return { operation_id: f.ids('operation'), kind: 'memory', payload: {
    archives: [memory], action: 'select', branch_id: f.branch, revision_id: memory.memory_revision_id,
    old_revision_id: null, expected_view: f.state.views[f.branch].version, mode: 'replace',
  } };
}

for (const kind of ['history', 'memory', 'binding']) {
  test(`durable ${kind}: discard caller state, discover prepared IDs and exact result after reopen`, async () => {
    const c = await initialized(), request = nextRequest(c, kind);
    const receipt = await c.handle.prepare(request);
    assert.equal(receipt.status, 'prepared');
    const before = await c.handle.read();
    await c.coordinator.close(); c.io.crash();
    const restarted = new IntentCoordinator(c.io), handle = await restarted.recover();
    const [pending] = await handle.pending();
    assert.deepEqual(pending, receipt); assert.deepEqual(await handle.read(), before);
    const result = await handle.execute(pending.input.operation_id);
    const after = await handle.read();
    assert.deepEqual(await handle.execute(pending.input.operation_id), result);
    assert.deepEqual(await handle.read(), after);
    await restarted.close(); c.io.crash();
    const third = new IntentCoordinator(c.io), again = await third.recover();
    assert.equal((await again.lookup(request.operation_id)).status, 'published');
    assert.deepEqual(await again.execute(request.operation_id), result);
    assert.deepEqual(await again.pending(), []); assert.deepEqual(await again.read(), after);
  });
  for (const [label, edge, durable] of [
    ['intent-write', 'before', false], ['intent-write', 'after', true],
    ['intent-flush', 'before', true], ['intent-flush', 'after', true], ['intent-ack', 'after', true],
  ]) test(`durable ${kind}: preparation failure ${label}/${edge}`, async () => {
    const c = await initialized(), input = nextRequest(c, kind), before = await c.handle.read();
    c.io.fail = { label, edge, n: 1, durable };
    await rejects(c.handle.prepare(input), 'RECOVERY_REQUIRED');
    await rejects(c.handle.read(), 'RECOVERY_REQUIRED');
    c.io.fail = null; c.io.crash();
    const reopened = new IntentCoordinator(c.io), h = await reopened.recover();
    const pending = await h.pending();
    assert.equal(pending.length, label === 'intent-write' && edge === 'before' ? 0 : 1);
    assert.deepEqual(await h.read(), before);
    const found = pending[0] ?? await h.prepare(input);
    const result = await h.execute(found.input.operation_id);
    assert.deepEqual(await h.execute(found.input.operation_id), result);
  });
  for (const [label, edge] of [['object', 'after'], ['prepare-flush', 'after'], ['publish', 'before'],
    ['publish', 'after'], ['publish-flush', 'after'], ['ack', 'after']]) {
    test(`durable ${kind}: publication failure ${label}/${edge}`, async () => {
      const c = await initialized(), input = nextRequest(c, kind), receipt = await c.handle.prepare(input);
      c.io.fail = { label, edge, n: 1, durable: true };
      await rejects(c.handle.execute(input.operation_id), 'RECOVERY_REQUIRED');
      c.io.fail = null; c.io.crash();
      const restarted = new IntentCoordinator(c.io), h = await restarted.recover();
      const found = await h.lookup(input.operation_id);
      assert.deepEqual(found.generated, receipt.generated); assert.deepEqual(found.request, receipt.request);
      const published = ['publish-flush', 'ack'].includes(label) || label === 'publish' && edge === 'after';
      assert.equal(found.status, published ? 'published' : 'prepared');
      const result = await h.execute(found.input.operation_id);
      assert.deepEqual(result, receipt.request.result); assert.deepEqual(await h.execute(input.operation_id), result);
    });
  }
}

test('pending request blocks competing preparation; same key changed input rejects before compilation', async () => {
  const c = await initialized(), input = nextRequest(c, 'history');
  const first = await c.handle.prepare(input);
  assert.deepEqual(await c.handle.prepare(input), first);
  await rejects(c.handle.prepare({ ...input, payload: { ...input.payload, created_at: '2026-09-20T00:00:00Z' } }), 'OPERATION_CONFLICT');
  await rejects(c.handle.prepare({ ...input, operation_id: c.f.ids('operation') }), 'PENDING_OPERATION');
  await c.handle.execute(input.operation_id);
  assert.equal((await c.handle.prepare(input)).status, 'published');
});

test('memory correction persists original generated view; no history command pollution', async () => {
  const c = await initialized(), select = nextRequest(c, 'memory');
  await c.handle.prepare(select); await c.handle.execute(select.operation_id); c.f.state = await c.handle.read();
  const original = select.payload.archives[0], replacement = { ...original,
    memory_revision_id: c.f.ids('memoryRevision'), content: '虚构纠错' };
  const input = { operation_id: c.f.ids('operation'), kind: 'memory', payload: {
    archives: [replacement], action: 'correct', branch_id: c.f.branch, old_revision_id: original.memory_revision_id,
    revision_id: replacement.memory_revision_id, expected_view: c.f.state.views[c.f.branch].version, mode: null,
  } };
  const receipt = await c.handle.prepare(input); c.io.crash();
  const reopened = new IntentCoordinator(c.io), h = await reopened.recover(); await h.execute(input.operation_id);
  const state = await h.read();
  assert.equal(state.views[c.f.branch].version, receipt.request.result.version);
  assert.equal(state.views[c.f.branch].corrections[original.memory_revision_id], replacement.memory_revision_id);
  assert.equal(state.operations[input.operation_id], undefined); assert.equal(state.operations[select.operation_id], undefined);
});

test('canceling a waiter cannot release the queue or erase prepared work', async () => {
  const c = await initialized(), input = nextRequest(c, 'history');
  let release, entered;
  const held = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const point = c.io.point.bind(c.io);
  c.io.point = async (label, edge) => { await point(label, edge); if (label === 'intent-flush' && edge === 'before') { entered(); await held; } };
  const work = c.handle.prepare(input); await ready;
  // The caller stops waiting, while native execution remains held.
  assert.equal(await Promise.race([work, Promise.resolve('waiter-cancelled')]), 'waiter-cancelled');
  let closed = false; const closing = c.coordinator.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); const receipt = await work; await closing;
  const h = await new IntentCoordinator(c.io).recover(); assert.deepEqual((await h.pending())[0], receipt);
});

test('cooperative maintenance fences queued handles and preserves prepared work', async () => {
  const c = await initialized(), input = nextRequest(c, 'history'); await c.handle.prepare(input);
  const queued = c.handle.read(); const suspended = c.coordinator.suspend();
  await rejects(queued, 'STALE_HANDLE'); const ticket = await suspended;
  await rejects(c.handle.execute(input.operation_id), 'STALE_HANDLE');
  await rejects(c.coordinator.recover(), 'MAINTENANCE_REQUIRED');
  await rejects(c.coordinator.resume({ ...ticket, intent_count: 0 }), 'MAINTENANCE_REQUIRED');
  const h = await c.coordinator.resume(ticket); assert.equal((await h.pending()).length, 1);
  await h.execute(input.operation_id); assert.equal((await h.pending()).length, 0);
});

for (const changed of ['identity', 'root', 'intent']) test(`maintenance ${changed} replacement quarantines instead of adopting same namespace`, async () => {
  const c = await initialized(), ticket = await c.coordinator.suspend();
  const before = structuredClone(c.io.live);
  if (changed === 'identity') c.io.live.get(IDENTITY_SLOT).library_id = c.f.ids('operation');
  if (changed === 'root') c.io.live.get(0).tip = null;
  if (changed === 'intent') c.io.live.delete(IDENTITY_SLOT + 1);
  const replaced = structuredClone(c.io.live);
  await rejects(c.coordinator.resume(ticket), 'LIBRARY_CHANGED');
  assert.deepEqual(c.io.live, replaced); assert.equal(c.coordinator.status, 'recovery-required');
  c.io.live = before; const h = await c.coordinator.resume(ticket);
  assert.equal((await h.lookup(c.input.operation_id)).status, 'published');
});

test('closed coordinator cannot recover or affect a replacement', async () => {
  const c = await initialized(); await c.coordinator.close();
  const next = new IntentCoordinator(c.io), h = await next.recover();
  await rejects(c.coordinator.recover(), 'OWNER_CLOSED'); await rejects(c.handle.read(), 'STALE_HANDLE');
  await c.coordinator.close(); assert.equal((await h.lookup(c.input.operation_id)).status, 'published');
});

test('creation refuses existing protocol or identity data without modifications', async () => {
  const c = await initialized(), before = structuredClone(c.io.live);
  await rejects(new IntentCoordinator(c.io).create(), 'IMPORT_TARGET_NOT_EMPTY'); assert.deepEqual(c.io.live, before);
});

for (const defect of ['input', 'generated', 'compiled', 'missing', 'duplicate']) test(`intent audit rejects checksum-valid ${defect} corruption`, async () => {
  const c = await initialized(), input = nextRequest(c, 'history'); await c.handle.prepare(input);
  const slot = IDENTITY_SLOT + 2, record = structuredClone(c.io.live.get(slot));
  if (defect === 'input') record.input.payload.created_at = '2026-09-20T00:00:00Z';
  if (defect === 'generated') record.generated[0].value = c.f.ids('snapshot');
  if (defect === 'compiled') record.compiled.result = { fake: true };
  if (defect === 'duplicate') record.input.operation_id = c.input.operation_id;
  const { checksum, ...body } = record; record.checksum = fingerprint('write-payload', body);
  c.io.live.set(slot, record);
  if (defect === 'missing') c.io.live.delete(IDENTITY_SLOT + 1);
  const before = structuredClone(c.io.live), reopened = new IntentCoordinator(c.io);
  await assert.rejects(reopened.recover()); assert.equal(reopened.status, 'recovery-required'); assert.deepEqual(c.io.live, before);
});

for (const edge of ['before', 'after']) test(`preparation not flushed (${edge}) is not claimed durable`, async () => {
  const c = await initialized(), input = nextRequest(c, 'history');
  c.io.fail = { label: 'intent-write', edge, n: 1, durable: false };
  await rejects(c.handle.prepare(input), 'RECOVERY_REQUIRED'); c.io.fail = null; c.io.crash();
  const h = await new IntentCoordinator(c.io).recover(); assert.equal((await h.pending()).length, 0);
  assert.equal(await h.lookup(input.operation_id), null);
});

for (const failsAfterClose of [false, true]) test(`maintenance close failure (${failsAfterClose}) keeps ticket and coordinator fenced`, async () => {
  const c = await initialized(); let fail = true;
  c.io.close = async () => { if (failsAfterClose) await c.io.flush(); if (fail) throw Error('close reply lost'); };
  await assert.rejects(c.coordinator.suspend());
  await rejects(c.coordinator.recover(), 'MAINTENANCE_REQUIRED');
  await rejects(c.handle.read(), 'STALE_HANDLE');
  fail = false;
  // Even when suspend did not return its ticket, permanent close followed by a
  // new diagnostic coordinator can recover the exact persisted request state.
  await c.coordinator.close(); const h = await new IntentCoordinator(c.io).recover();
  assert.equal((await h.lookup(c.input.operation_id)).status, 'published');
});

test('suspension drains an executing publication before allowing maintenance', async () => {
  const c = await initialized(), input = nextRequest(c, 'history'); await c.handle.prepare(input);
  let release, entered;
  const held = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  c.io.point = async (label, edge) => { if (label === 'publish-flush' && edge === 'before') { entered(); await held; } };
  const publish = c.handle.execute(input.operation_id); await ready;
  let done = false; const suspending = c.coordinator.suspend().then(t => { done = true; return t; });
  await Promise.resolve(); assert.equal(done, false); release();
  const result = await publish, ticket = await suspending, h = await c.coordinator.resume(ticket);
  assert.equal((await h.lookup(input.operation_id)).status, 'published'); assert.deepEqual(await h.execute(input.operation_id), result);
});

test('unknown identity read outcome quarantines until explicit recovery', async () => {
  const c = await initialized(), get = c.io.get.bind(c.io);
  c.io.get = async slot => { if (slot === IDENTITY_SLOT) throw Error('injected read IO error'); return get(slot); };
  await assert.rejects(c.handle.read()); assert.equal(c.coordinator.status, 'recovery-required');
  c.io.get = get; await rejects(c.handle.read(), 'RECOVERY_REQUIRED');
  const h = await c.coordinator.recover(); assert.equal((await h.lookup(c.input.operation_id)).status, 'published');
});
