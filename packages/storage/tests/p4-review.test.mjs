import test from 'node:test';
import assert from 'node:assert/strict';
import { PagedCoordinator } from '../paged-coordinator.mjs';
import { Pages } from '../pages.mjs';
import { restorePagedIntoEmpty } from '../paged-recovery.mjs';
import { RecallIndex } from '../recall-index.mjs';
import { verifyPagedBackupRestore } from '../paged-diagnostics.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { derivedFingerprint } from '../../contracts/memory.mjs';

class IO {
  live = new Map(); durable = new Map();
  fail = null;
  async point(label, edge) { if (this.fail?.label === label && this.fail.edge === edge) throw Error('injected'); }
  async get(k) { return structuredClone(this.live.get(k) ?? null); }
  async put(k, v) { this.live.set(k, structuredClone(v)); }
  async flush() { this.durable = new Map(this.live); }
  async close() { await this.flush(); }
  async reopen() { this.live = new Map(this.durable); }
  async assertEmpty() { assert.equal(this.live.size, 0); }
}
async function execute(h, input) { await h.prepare(input); return h.execute(input.operation_id); }
async function setup() {
  const io = new IO(), owner = new PagedCoordinator(io), h = await owner.create(), f = fixture(2);
  const command = Object.values(f.state.operations)[0].command;
  const result = await execute(h, { kind: 'history', operation_id: command.operation_id, payload: command });
  async function select(content) {
    const memory = { ...f.memory(f.entries, 'Record', { content }), basis_snapshot_id: result.snapshot_id };
    memory.input_fingerprint = derivedFingerprint(memory);
    await execute(h, { kind: 'memory', operation_id: f.ids('operation'), payload: {
      archives: [memory], action: 'select', branch_id: f.branch, revision_id: memory.memory_revision_id,
      old_revision_id: null, expected_view: (await h.read('views', f.branch)).version, mode: 'replace',
    } });
    return memory;
  }
  return { io, owner, h, f, select };
}

test('recall rejects a view change after accepting the first real coordinator candidate', async () => {
  const c = await setup(); await c.select('first'); await c.select('second');
  const index = new RecallIndex(new IO()); await index.rebuild(c.h, c.f.branch);
  let changed = false;
  const interleaved = { ...c.h, memoryStatus: async (...args) => {
    const value = await c.h.memoryStatus(...args);
    if (!changed) { changed = true; await c.select('third'); }
    return value;
  } };
  const found = await index.search(interleaved, c.f.branch, { vector: [1, 1, 1] });
  assert.equal(found.status, 'behind'); assert.deepEqual(found.results, []);
});

test('index rebuild does not report ready after a concurrent view publication', async () => {
  const c = await setup(); await c.select('first');
  const index = new RecallIndex(new IO());
  const result = await index.rebuild(c.h, c.f.branch, { vector: async () => {
    await c.select('second'); return [1, 1, 1];
  } });
  assert.equal(result.status, 'behind');
});

test('recall rejects an edit after checking the first candidate while later reads see the new state', async () => {
  const c = await setup(); const a = await c.select('first'), b = await c.select('second');
  const index = new RecallIndex(new IO()); await index.rebuild(c.h, c.f.branch);
  let changed = false;
  const interleaved = { ...c.h, memoryStatus: async (...args) => {
    const status = await c.h.memoryStatus(...args);
    if (!changed) {
      changed = true;
      const branch = await c.h.read('branches', c.f.branch), source = c.f.source('user', 'edited', c.f.entries[0].message_id);
      const command = c.f.command([source.ref, c.f.entries[1]], { expected_head: branch.head_snapshot_id,
        change_kind: 'edit', revisions: [source.revision] });
      await execute(c.h, { kind: 'history', operation_id: command.operation_id, payload: command });
    }
    return status;
  } };
  const found = await index.search(interleaved, c.f.branch, { vector: [1, 1, 1] });
  assert.equal(found.status, 'behind'); assert.deepEqual(found.results, []);
  assert.notEqual(await c.h.memoryStatus(a.memory_revision_id, c.f.branch), 'valid');
  assert.notEqual(await c.h.memoryStatus(b.memory_revision_id, c.f.branch), 'valid');
});

test('recall discards an already accepted revision after correction while the second remains valid', async () => {
  const c = await setup(), memories = [await c.select('first'), await c.select('second')];
  const index = new RecallIndex(new IO()); await index.rebuild(c.h, c.f.branch);
  let corrected;
  const interleaved = { ...c.h, memoryStatus: async (...args) => {
    const status = await c.h.memoryStatus(...args);
    if (!corrected) {
      corrected = args[0]; const old = await c.h.read('memories', corrected);
      const replacement = { ...old, memory_revision_id: c.f.ids('memoryRevision'), content: 'corrected' };
      replacement.input_fingerprint = derivedFingerprint(replacement);
      await execute(c.h, { kind: 'memory', operation_id: c.f.ids('operation'), payload: {
        archives: [replacement], action: 'correct', branch_id: c.f.branch,
        revision_id: replacement.memory_revision_id, old_revision_id: corrected,
        expected_view: (await c.h.read('views', c.f.branch)).version, mode: null,
      } });
    }
    return status;
  } };
  const result = await index.search(interleaved, c.f.branch, { vector: [1, 1, 1] });
  assert.equal(result.status, 'behind'); assert.deepEqual(result.results, []);
  assert.equal(await c.h.memoryStatus(corrected, c.f.branch), 'needs-rebuild');
  const other = memories.find(m => m.memory_revision_id !== corrected);
  assert.equal(await c.h.memoryStatus(other.memory_revision_id, c.f.branch), 'valid');
});

test('backup compares the exported snapshot when the source advances during restore', async () => {
  const c = await setup(), checkpoint = (await c.h.diagnostics()).checkpoint;
  const result = await verifyPagedBackupRestore(c.h, async stream => {
    const target = await restorePagedIntoEmpty(new IO(), stream);
    await c.select('after export'); return target;
  }, { branchId: c.f.branch });
  assert.equal(result.status, 'passed'); assert.deepEqual(result.source_checkpoint, checkpoint);
  assert.notDeepEqual((await c.h.diagnostics()).checkpoint, checkpoint);
});

test('backup rejects a wrong checkpoint even if target audit and branch are unchanged', async () => {
  const c = await setup(); let closed = false;
  await assert.rejects(verifyPagedBackupRestore(c.h, async stream => {
    const target = await restorePagedIntoEmpty(new IO(), stream), h = target.handle();
    return { handle: () => ({ ...h, diagnostics: async (...args) => ({
      ...await h.diagnostics(...args), checkpoint: { hash: '0'.repeat(64), slot: 65536 },
    }) }), close: async () => { closed = true; await target.close(); } };
  }), { code: 'NEEDS_RESOLUTION' });
  assert.equal(closed, true);
});

test('backup captures a publication before export and permits a different target library', async () => {
  const c = await setup(); let expected, targetLibrary;
  const source = { ...c.h, exportSnapshot: async (...args) => {
    await c.select('before capture'); expected = await c.h.diagnostics(); return c.h.exportSnapshot(...args);
  } };
  const result = await verifyPagedBackupRestore(source, async stream => {
    const owner = await restorePagedIntoEmpty(new IO(), stream);
    targetLibrary = (await owner.handle().diagnostics()).library_id; return owner;
  });
  assert.equal(result.status, 'passed'); assert.deepEqual(result.source_checkpoint, expected.checkpoint);
  assert.notEqual(targetLibrary, expected.library_id);
});

test('backup preserves the verification error when target close also fails', async () => {
  const c = await setup();
  await assert.rejects(verifyPagedBackupRestore(c.h, async stream => {
    const owner = await restorePagedIntoEmpty(new IO(), stream), h = owner.handle();
    return { handle: () => ({ ...h, diagnostics: async () => ({ ...await h.diagnostics(), checkpoint: null }) }),
      close: async () => { await owner.close(); throw Error('close failed'); } };
  }), error => error.code === 'NEEDS_RESOLUTION' && error.close_error.message === 'close failed');
});

for (const edge of ['before', 'after']) test('directory batch IO failure preserves committed root: ' + edge, async () => {
  const c = await setup(), before = await c.h.logical();
  c.io.fail = { label: 'directory-write', edge };
  await assert.rejects(c.select('unconfirmed'));
  c.io.fail = null; await c.io.reopen();
  const recovered = await new PagedCoordinator(c.io).recover();
  assert.deepEqual(await recovered.logical(), before);
  assert.deepEqual(await recovered.pending(), []);
});

test('bounded map batch preserves old roots and AVL invariants across overlapping batches', async () => {
  const io = new IO(), pages = new Pages(io); let root = null;
  const value = await pages.put({ kind: 'fixture', content: 'synthetic' }), expected = new Map();
  const saved = [];
  for (let batch = 0; batch < 6; batch++) {
    const entries = Array.from({ length: 96 }, (_, i) => [String((i * 37 + batch * 83) % 997).padStart(4, '0'), value]);
    saved.push([root, [...expected].sort()]);
    root = await pages.mapSetMany(root, entries);
    for (const [k, v] of entries) expected.set(k, v);
  }
  const collect = async r => { const rows = []; for await (const e of pages.mapEntries(r)) rows.push(e); return rows; };
  assert.deepEqual(await collect(root), [...expected].sort());
  for (const [r, entries] of saved) assert.deepEqual(await collect(r), entries);
  const visit = async r => { if (!r) return 0; const n = await pages.get(r);
    const l = await visit(n.left), right = await visit(n.right);
    assert.ok(Math.abs(l - right) <= 1); assert.equal(n.height, Math.max(l, right) + 1); return n.height; };
  await visit(root);
  assert.deepEqual(await pages.mapSetMany(root, []), root);
  await assert.rejects(pages.mapSetMany(root, Array(1025).fill(['a', value])), { code: 'RESOURCE_LIMIT' });
});
