import test from 'node:test';
import assert from 'node:assert/strict';
import { PagedCoordinator } from '../paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../paged-recovery.mjs';
import { RecallIndex, artificialVector, filterRecallCandidates } from '../recall-index.mjs';
import { collectPagedDiagnostic, describePagedStore, diagnosticFailure, inventoryPagedIO,
  readOnlyPagedHandle, verifyPagedBackupRestore } from '../paged-diagnostics.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { canonicalize } from '../../contracts/primitives.mjs';
import { derivedFingerprint } from '../../contracts/memory.mjs';
import { sha256 } from '../../contracts/runtime.mjs';

class MemoryIO {
  live = new Map(); durable = new Map();
  async get(slot) { return structuredClone(this.live.get(slot) ?? null); }
  async put(slot, value) { this.live.set(slot, structuredClone(value)); }
  async flush() { this.durable = structuredClone(this.live); }
  async close() { await this.flush(); }
  async reopen() { this.live = structuredClone(this.durable); }
  async assertEmpty() { assert.equal(this.live.size, 0); }
  async stats() { return { nodeCount: this.live.size }; }
}

async function execute(handle, input) {
  await handle.prepare(input);
  return handle.execute(input.operation_id);
}

function historyInput(command) {
  return { operation_id: command.operation_id, kind: 'history', payload: command };
}

async function setup() {
  const io = new MemoryIO(), owner = new PagedCoordinator(io), handle = await owner.create(), f = fixture(2);
  const initial = Object.values(f.state.operations)[0].command;
  const result = await execute(handle, historyInput(initial));
  return { io, owner, handle, f, head: result.snapshot_id };
}

async function addMemory(context, content, action = 'select') {
  const original = context.f.memory(context.f.entries, 'Record', { content });
  const memory = { ...structuredClone(original), basis_snapshot_id: context.head };
  memory.input_fingerprint = derivedFingerprint(memory);
  const view = await context.handle.read('views', context.f.branch);
  const input = { operation_id: context.f.ids('operation'), kind: 'memory', payload: {
    archives: [memory], action, branch_id: action === 'archive' ? null : context.f.branch,
    revision_id: action === 'archive' ? null : memory.memory_revision_id,
    old_revision_id: null, expected_view: action === 'archive' ? null : view.version,
    mode: action === 'archive' ? null : 'replace',
  } };
  await execute(context.handle, input);
  return { memory, input };
}

async function append(context, text = '索引过期后的虚构追加') {
  const source = context.f.source('user', text), command = context.f.command([], {
    change_kind: 'append', expected_head: context.head, messages: [source.message], revisions: [source.revision],
  });
  const { entries: ignored, ...payload } = command;
  payload.splice = { start: context.f.entries.length, delete_count: 0, entries: [source.ref] };
  const result = await execute(context.handle, { operation_id: command.operation_id, kind: 'history-delta', payload });
  context.head = result.snapshot_id;
}

test('recall index failure/loss is rebuildable and never changes confirmed storage', async () => {
  const context = await setup();
  const selected = await addMemory(context, '青石门 角色约定 只用于虚构索引');
  const archived = await addMemory(context, '错误候选 不应进入结果', 'archive');
  const logical = await context.handle.logical(), receipt = await context.handle.lookup(selected.input.operation_id);
  const indexIO = new MemoryIO(), index = new RecallIndex(indexIO);
  await assert.rejects(index.rebuild(context.handle, context.f.branch, { vector: () => { throw Error('synthetic index failure'); } }));
  assert.equal(index.describe().status, 'failed');
  assert.deepEqual(await context.handle.logical(), logical);
  assert.deepEqual(await context.handle.lookup(selected.input.operation_id), receipt);

  indexIO.live.clear(); indexIO.durable.clear();
  const rebuilt = new RecallIndex(indexIO);
  assert.equal((await rebuilt.recover()).status, 'missing');
  assert.equal((await rebuilt.rebuild(context.handle, context.f.branch)).status, 'ready');
  const found = await rebuilt.search(context.handle, context.f.branch,
    { markers: ['青石门'], vector: artificialVector(selected.memory) });
  assert.equal(found.status, 'ready');
  assert.deepEqual(found.results.map(item => item.memory_revision_id), [selected.memory.memory_revision_id]);
  assert.equal(found.results[0].rerank_score, null);

  const source = rebuilt.describe().source, fingerprint = sha256(canonicalize(selected.memory));
  const candidate = { memory_revision_id: selected.memory.memory_revision_id, story_id: context.f.story,
    branch_id: context.f.branch, view_version: source.view_version, fingerprint, index_score: 1 };
  const rejected = await filterRecallCandidates(context.handle,
    { story_id: context.f.story, branch_id: context.f.branch, source }, [
      { ...candidate, story_id: 'st_00000000-0000-4000-8000-ffffffffffff' },
      { ...candidate, branch_id: 'br_00000000-0000-4000-8000-ffffffffffff' },
      { ...candidate, view_version: 'mv_00000000-0000-4000-8000-ffffffffffff' },
      { ...candidate, fingerprint: '0'.repeat(64) },
      { ...candidate, memory_revision_id: archived.memory.memory_revision_id,
        fingerprint: sha256(canonicalize(archived.memory)) }, candidate,
    ]);
  assert.deepEqual(rejected.map(item => item.memory_revision_id), [selected.memory.memory_revision_id]);

  await append(context);
  assert.deepEqual(await rebuilt.search(context.handle, context.f.branch,
    { markers: ['青石门'], vector: artificialVector(selected.memory) }), { status: 'behind', results: [] });
  assert.equal((await rebuilt.rebuild(context.handle, context.f.branch)).status, 'ready');
  assert.equal((await rebuilt.search(context.handle, context.f.branch,
    { markers: ['青石门'], vector: artificialVector(selected.memory) })).results.length, 1);
});

test('diagnostics expose checkpoint/head/view/index state without write methods', async () => {
  const context = await setup(), selected = await addMemory(context, '月台 marker 诊断');
  const index = new RecallIndex(new MemoryIO()); await index.rebuild(context.handle, context.f.branch);
  const diagnostic = await describePagedStore(context.handle, { branchId: context.f.branch, index });
  assert.equal(diagnostic.storage.operation_count, 2);
  assert.equal(diagnostic.storage.pending_operation_id, null);
  assert.equal(diagnostic.storage.branch.marker.index, 'behind');
  assert.equal(diagnostic.index.status, 'ready');
  assert.equal(diagnostic.maintenance.automatic_external, 'HOST_MAINTENANCE_UNSUPPORTED');
  const readOnly = readOnlyPagedHandle(context.handle);
  assert.equal(readOnly.prepare, undefined); assert.equal(readOnly.execute, undefined);
  assert.equal((await readOnly.read('memories', selected.memory.memory_revision_id)).content, selected.memory.content);
  const before = await context.handle.logical(), snapshot = await collectPagedDiagnostic(context.handle,
    { branchId: context.f.branch, index, namespace: 'node-test', io: context.io,
      capturedAt: () => '2026-09-21T00:00:00.000Z' });
  assert.equal(snapshot.format, 'mnemosyne-storage-diagnostic-v1');
  assert.equal(snapshot.read_only, true); assert.equal(snapshot.capabilities.writes, false);
  assert.equal(snapshot.index.status, 'ready'); assert.ok(snapshot.inventory.physical_nodes > 0);
  const verified = await verifyPagedBackupRestore(context.handle,
    stream => restorePagedIntoEmpty(new MemoryIO(), stream), { branchId: context.f.branch });
  assert.equal(verified.status, 'passed'); assert.ok(verified.bytes > 0); assert.ok(verified.records > 0);
  assert.deepEqual(await context.handle.logical(), before);
  const failure = diagnosticFailure(Object.assign(Error('synthetic failure'), { code: 'P5_SYNTHETIC' }));
  assert.deepEqual(failure, { code: 'P5_SYNTHETIC', message: 'synthetic failure', cause: null });
});

test('inventory separates business, active, unreachable and directory pages across restore', async () => {
  const context = await setup(); await append(context, '占用分类的虚构正文');
  const source = await inventoryPagedIO(context.io);
  assert.ok(source.physical_nodes >= source.cataloged_business_pages + source.active_directory_pages + 1);
  assert.ok(source.active_checkpoint_reachable_pages > 0);
  assert.equal(source.cataloged_business_pages,
    source.active_checkpoint_reachable_pages + source.cataloged_unreachable_pages);
  const chunks = [];
  for await (const chunk of await context.handle.export()) chunks.push(chunk);
  const targetIO = new MemoryIO(), restored = await restorePagedIntoEmpty(targetIO, chunks), target = restored.handle();
  assert.deepEqual(await target.logical(), await context.handle.logical());
  assert.deepEqual(await target.audit(), await context.handle.audit());
  const targetInventory = await inventoryPagedIO(targetIO);
  assert.equal(targetInventory.cataloged_business_pages, source.cataloged_business_pages);
  assert.equal((await target.diagnostics(context.f.branch)).maintenance_gate, 'HOST_MAINTENANCE_UNSUPPORTED');
});
