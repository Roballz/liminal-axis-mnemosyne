import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, fingerprint } from '../../contracts/primitives.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { IntentCoordinator, IDENTITY_SLOT, restoreIntentIntoEmpty, readIntentRecovery } from '../intent-prototype.mjs';
import { encodeIntentRecovery, RESTORE_SLOT } from '../intent-recovery.mjs';
import { parseStrictJSON, readJSONLines, TEXT_LIMITS } from '../strict-json.mjs';
import { FakeIO } from './fake-io.mjs';
const collect = async stream => { const output = []; for await (const chunk of stream) output.push(chunk); return output; };
const rejects = (p, code) => assert.rejects(p, e => e.code === code);
const emptyIO = () => {
  const io = new FakeIO(); io.assertEmpty = async () => {
    if (io.live.size) throw Object.assign(Error('Nonempty target'), { code: 'IMPORT_TARGET_NOT_EMPTY' });
  }; return io;
};
async function source() {
  const io = emptyIO(), owner = new IntentCoordinator(io), h = await owner.create(), f = fixture(2);
  const send = async input => { await h.prepare(input); await h.execute(input.operation_id); f.state = await h.read(); };
  const command = Object.values(f.state.operations)[0].command;
  await send({ operation_id: command.operation_id, kind: 'history', payload: command });
  const memory = f.memory(f.entries);
  const input = { operation_id: f.ids('operation'), kind: 'memory', payload: {
    archives: [memory], action: 'select', branch_id: f.branch, revision_id: memory.memory_revision_id,
    old_revision_id: null, expected_view: f.state.views[f.branch].version, mode: 'replace',
  } }; await send(input);
  const fixed = { ...memory, memory_revision_id: f.ids('memoryRevision'), content: '已保留的虚构纠错 😀' };
  await send({ operation_id: f.ids('operation'), kind: 'memory', payload: {
    archives: [fixed], action: 'correct', branch_id: f.branch, revision_id: fixed.memory_revision_id,
    old_revision_id: memory.memory_revision_id, expected_view: f.state.views[f.branch].version, mode: null,
  } });
  f.prepare(); const binding = Object.values(f.state.bindings)[0];
  await send({ operation_id: f.ids('operation'), kind: 'binding', payload: binding });
  const src = f.source('user', '未确认请求原文');
  const next = f.command([...f.entries, src.ref], { change_kind: 'append', messages: [src.message], revisions: [src.revision] });
  const pending = await h.prepare({ operation_id: next.operation_id, kind: 'history', payload: next });
  return { io, owner, h, f, memory, fixed, pending, chunks: await collect(await h.export()) };
}
test('complete v1 recovery retains old memory/correction, ledger, binding and prepared IDs; retry survives second reopen', async () => {
  const c = await source(), io = emptyIO(), restored = await restoreIntentIntoEmpty(io, c.chunks), h = restored.handle();
  assert.deepEqual(await h.read(), await c.h.read()); assert.deepEqual(await h.pending(), [c.pending]);
  assert.notEqual(io.live.get(IDENTITY_SLOT).library_id, c.io.live.get(IDENTITY_SLOT).library_id);
  const before = await readIntentRecovery(c.chunks), after = await readIntentRecovery(await collect(await h.export()));
  assert.deepEqual(after.bundle, before.bundle); assert.deepEqual(after.intents, before.intents);
  const result = await h.execute(c.pending.input.operation_id); await restored.close(); io.crash();
  const reopened = new IntentCoordinator(io), again = await reopened.recover();
  assert.deepEqual(await again.execute(c.pending.input.operation_id), result);
  assert.equal((await again.pending()).length, 0); assert.deepEqual(await c.h.pending(), [c.pending]);
});
test('export pins one boundary while source continues publishing', async () => {
  const c = await source(), frozen = await c.h.export(), state = await c.h.read();
  await c.h.execute(c.pending.input.operation_id);
  const restored = await restoreIntentIntoEmpty(emptyIO(), frozen);
  assert.deepEqual(await restored.handle().read(), state); assert.deepEqual(await restored.handle().pending(), [c.pending]);
});
test('UTF-8 stream split in every byte preserves non-BMP text and canonical fingerprints', async () => {
  const c = await source();
  async function* bytes() { for (const chunk of c.chunks) for (const b of chunk) yield new Uint8Array([b]); }
  assert.deepEqual(await readIntentRecovery(bytes()), await readIntentRecovery(c.chunks));
});
for (const defect of ['truncated', 'trailing', 'reordered', 'unknown', 'duplicate-id', 'bad-utf8', 'duplicate-key']) {
  test(`invalid ${defect} backup never writes to target`, async () => {
    const c = await source(), chunks = [...c.chunks], io = emptyIO();
    if (defect === 'truncated') chunks.pop();
    if (defect === 'trailing') chunks.push(chunks.at(-1));
    if (defect === 'reordered') [chunks[1], chunks[2]] = [chunks[2], chunks[1]];
    if (defect === 'unknown') chunks[0] = new TextEncoder().encode(new TextDecoder().decode(chunks[0]).replace('mnemosyne-intent-recovery-v1', 'unknown'));
    if (defect === 'duplicate-id') {
      const rows = chunks.map(c => JSON.parse(new TextDecoder().decode(c))); rows.splice(2, 0, rows[1]);
      let prev = null; chunks.length = 0;
      rows.forEach((row, i) => { const { checksum, ...body } = row; body.sequence = i; body.previous = prev;
        prev = fingerprint('write-payload', body); chunks.push(new TextEncoder().encode(canonicalize({ ...body, checksum: prev }) + '\n')); });
    }
    if (defect === 'bad-utf8') chunks[0] = Uint8Array.of(0xff, 10);
    if (defect === 'duplicate-key') chunks[0] = new TextEncoder().encode('{"a":1,"\\u0061":2}\n');
    await assert.rejects(restoreIntentIntoEmpty(io, chunks)); assert.equal(io.live.size, 0);
  });
}
for (const defect of ['r5', 'generated', 'missing-intent', 'ledger', 'markers', 'pending-input']) {
  test(`checksum-valid ${defect} recovery fails domain/intent audit before activation`, async () => {
    const c = await source(), original = await readIntentRecovery(c.chunks), s = structuredClone(original), io = emptyIO();
    if (defect === 'r5') s.bundle.logical.state.views[c.f.branch].selections[c.memory.memory_id] = c.memory.memory_revision_id;
    if (defect === 'generated') s.intents.at(-1).generated[0].value = c.f.ids(s.intents.at(-1).generated[0].kind);
    if (defect === 'missing-intent') s.intents.shift();
    if (defect === 'ledger') s.bundle.ledger[0][1].result = { altered: true };
    if (defect === 'markers') s.bundle.markers[c.f.branch].index = 'ready';
    if (defect === 'pending-input') s.intents.at(-1).input.payload.created_at = '2026-09-20T00:00:00Z';
    for (const r of s.intents) { const { checksum, ...body } = r; r.checksum = fingerprint('write-payload', body); }
    const { checksum: logicalChecksum, ...logical } = s.bundle.logical;
    s.bundle.logical.checksum = fingerprint('logical-export', logical);
    const { checksum: bundleChecksum, ...bundle } = s.bundle; s.bundle.checksum = fingerprint('write-payload', bundle);
    await assert.rejects(restoreIntentIntoEmpty(io, encodeIntentRecovery(s))); assert.equal(io.live.size, 0);
  });
}
for (const label of ['restore-stage', 'restore-intent', 'object', 'publish', 'import-activate', 'restore-activate']) {
  for (const edge of ['before', 'after']) test(`restore failure ${label}/${edge}: retained staging or exact active state, never partial activation`, async () => {
    const c = await source(), io = emptyIO(); io.fail = { label, edge, n: 1, durable: true, code: 'ENOSPC' };
    await assert.rejects(restoreIntentIntoEmpty(io, c.chunks)); io.fail = null; io.crash();
    const owner = new IntentCoordinator(io);
    if (label === 'restore-activate' && edge === 'after') {
      const h = await owner.recover(); assert.deepEqual(await h.read(), await c.h.read()); assert.deepEqual(await h.pending(), [c.pending]);
    } else {
      await assert.rejects(owner.recover()); assert.equal(owner.status, 'recovery-required');
      if (io.live.size) { assert.equal(io.live.get(RESTORE_SLOT).status, 'staging');
        const original = structuredClone(io.live); await rejects(restoreIntentIntoEmpty(io, c.chunks), 'IMPORT_TARGET_NOT_EMPTY');
        assert.deepEqual(io.live, original); }
    }
  });
}
test('nonempty target is unchanged; complete source retains its own prepared work', async () => {
  const c = await source(), original = structuredClone(c.io.live);
  await rejects(restoreIntentIntoEmpty(c.io, c.chunks), 'IMPORT_TARGET_NOT_EMPTY'); assert.deepEqual(c.io.live, original);
});
for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":0,"a":0}}']) {
  test(`strict JSON duplicate ${text}`, () => assert.throws(() => parseStrictJSON(text), e => e.code === 'DUPLICATE_KEY'));
}
for (const text of ['"\\ud800"', '"\\udc00"', '01', '1e999', '[1,]', '{"a":1,}', 'true x', '\ufeff{}']) {
  test(`strict JSON rejects malformed ${JSON.stringify(text)}`, () => assert.throws(() => parseStrictJSON(text)));
}
test('strict parser accepts safe own __proto__ without changing object prototype', () => {
  const result = parseStrictJSON('{"__proto__":{"x":1},"emoji":"😀","n":-0.1e2}');
  assert.equal(Object.getPrototypeOf(result), Object.prototype); assert.equal(result.__proto__.x, 1); assert.equal({}.x, undefined);
});
for (const [key, value, text] of [['depth', 3, '[[[[[0]]]]]'], ['values', 3, '[0,1,2]'], ['lineBytes', 3, '"中文"']]) {
  test(`strict JSON ${key} resource bound`, () => assert.throws(() => parseStrictJSON(text, { ...TEXT_LIMITS, [key]: value }), e => e.code === 'RESOURCE_LIMIT'));
}
test('stream total byte and record count budgets reject without truncation', async () => {
  const chunks = [new TextEncoder().encode('{}\n{}\n')];
  for (const limits of [{ ...TEXT_LIMITS, lines: 1 }, { ...TEXT_LIMITS, totalBytes: 4 }]) {
    await rejects(collect(readJSONLines(chunks, limits)), 'RESOURCE_LIMIT');
  }
});
test('restored library uses a distinct identity format so the old v1 reader cannot bypass staging', async () => {
  const c = await source(), io = emptyIO(), owner = await restoreIntentIntoEmpty(io, c.chunks);
  assert.equal(io.live.get(IDENTITY_SLOT).format, 'mnemosyne-storage-restored-intents-v1');
  await owner.close(); io.live.delete(RESTORE_SLOT);
  await rejects(new IntentCoordinator(io).recover(), 'STAGING_IMPORT');
});
test('corruption of persisted import objects is caught on readback before activation', async () => {
  const c = await source(), io = emptyIO(), put = io.put.bind(io);
  let corrupt = true;
  io.put = async (slot, value) => {
    if (corrupt && value.kind === 'object') { value = { ...value, checksum: 'corrupted' }; corrupt = false; }
    return put(slot, value);
  };
  await assert.rejects(restoreIntentIntoEmpty(io, c.chunks));
  assert.equal(io.live.get(RESTORE_SLOT).status, 'staging');
  await rejects(new IntentCoordinator(io).recover(), 'STAGING_IMPORT');
});
test('export refuses byte budget before producing a completed footer', async () => {
  const c = await source(), snapshot = await readIntentRecovery(c.chunks), rows = [];
  await rejects((async () => { for await (const bytes of encodeIntentRecovery(snapshot, { ...TEXT_LIMITS, totalBytes: 2000 })) {
    rows.push(JSON.parse(new TextDecoder().decode(bytes)));
  } })(), 'RESOURCE_LIMIT');
  assert.equal(rows.some(x => x.type === 'end'), false);
});
test('full recovery includes deleted sources, old snapshots, fixed child and a second story', async () => {
  const c = await source(); await c.h.execute(c.pending.input.operation_id); c.f.state = await c.h.read();
  const publish = async command => {
    await c.h.prepare({ operation_id: command.operation_id, kind: 'history', payload: command });
    await c.h.execute(command.operation_id); c.f.state = await c.h.read();
  };
  const parentBefore = c.f.state.branches[c.f.branch].head_snapshot_id, oldRevision = c.f.entries[1].revision_id;
  const child = c.f.fork(2), childCommand = Object.values(c.f.state.operations).find(x => x.command.branch_id === child).command;
  await publish(childCommand); const fixedChild = c.f.state.branches[child].head_snapshot_id;
  const changed = c.f.source('assistant', '父线修改不改变子线', c.f.entries[1].message_id), edited = c.f.entries;
  edited[1] = changed.ref; await publish(c.f.command(edited, { change_kind: 'edit', revisions: [changed.revision] }));
  const deletedMessage = c.f.entries[0].message_id;
  await publish(c.f.command(c.f.entries.slice(1), { change_kind: 'delete' }));
  const otherStory = c.f.ids('story'), otherBranch = c.f.ids('branch');
  await publish(c.f.command([], { story_id: otherStory, branch_id: otherBranch, expected_head: null, change_kind: 'init' }));
  const original = await c.h.read(), restored = await restoreIntentIntoEmpty(emptyIO(), await c.h.export()), read = await restored.handle().read();
  assert.deepEqual(read, original); assert.equal(read.branches[child].head_snapshot_id, fixedChild);
  assert.ok(read.snapshots[parentBefore]); assert.ok(read.revisions[oldRevision]); assert.ok(read.messages[deletedMessage]);
  assert.ok(read.stories[otherStory]); assert.ok(read.memories[c.memory.memory_revision_id]);
  const a = await readIntentRecovery(await c.h.export()), b = await readIntentRecovery(await restored.handle().export());
  assert.deepEqual(b.bundle, a.bundle); assert.deepEqual(b.intents, a.intents);
});
