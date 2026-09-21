// Reproducible P5 command using synthetic data and an in-memory paged provider.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PagedCoordinator } from '../paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../paged-recovery.mjs';
import { RecallIndex } from '../recall-index.mjs';
import { collectPagedDiagnostic, verifyPagedBackupRestore } from '../paged-diagnostics.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { derivedFingerprint } from '../../contracts/memory.mjs';

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
  await handle.prepare(input); return handle.execute(input.operation_id);
}

const output = resolve(process.argv[2] ?? 'evals/t03/p4-p5/p5-diagnostic.json');
mkdirSync(dirname(output), { recursive: true });
const io = new MemoryIO(), owner = new PagedCoordinator(io), handle = await owner.create(), f = fixture(7);
const command = Object.values(f.state.operations)[0].command;
const history = await execute(handle, { operation_id: command.operation_id, kind: 'history', payload: command });
const original = f.memory(f.entries, 'Record', { content: 'P5 青石门 synthetic diagnostic marker' });
const memory = { ...structuredClone(original), basis_snapshot_id: history.snapshot_id };
memory.input_fingerprint = derivedFingerprint(memory);
const view = await handle.read('views', f.branch), memoryInput = { operation_id: f.ids('operation'),
  kind: 'memory', payload: { archives: [memory], action: 'select', branch_id: f.branch,
    revision_id: memory.memory_revision_id, old_revision_id: null, expected_view: view.version, mode: 'replace' } };
await execute(handle, memoryInput);
const index = new RecallIndex(new MemoryIO()); await index.rebuild(handle, f.branch);
const diagnostic = await collectPagedDiagnostic(handle,
  { branchId: f.branch, index, namespace: 'node-synthetic-p5', io });
const verification = await verifyPagedBackupRestore(handle,
  stream => restorePagedIntoEmpty(new MemoryIO(), stream), { branchId: f.branch });
const report = { status: 'passed', date: '2026-09-21', synthetic: true,
  scope: 'P5 reproducible Node diagnostic and empty-target restore command; not native/mobile acceptance',
  diagnostic, backup_restore_verification: verification };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
await owner.close();
console.log(JSON.stringify({ status: report.status, output, operation_count: diagnostic.storage.operation_count,
  index: diagnostic.index.status, backup_bytes: verification.bytes, backup_records: verification.records }));
