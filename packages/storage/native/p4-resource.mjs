// P4 desktop resource harness. Synthetic data only; not a mobile benchmark.
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream, mkdirSync, statfsSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { PagedCoordinator } from '../paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../paged-recovery.mjs';
import { inventoryPagedIO, describePagedStore } from '../paged-diagnostics.mjs';
import { RecallIndex, artificialVector } from '../recall-index.mjs';
import { exercisePagedScale } from '../p4-workload.mjs';
import { canonicalize } from '../../contracts/primitives.mjs';

class MeteredIO {
  live = new Map(); durable = new Map(); dirty = new Map(); reads = 0; writes = 0; flushes = 0;
  async get(slot) { this.reads++; return structuredClone(this.live.get(slot) ?? null); }
  async put(slot, value) { this.writes++; const saved = structuredClone(value); this.live.set(slot, saved); this.dirty.set(slot, saved); }
  async flush() { this.flushes++; for (const [slot, value] of this.dirty) this.durable.set(slot, value); this.dirty.clear(); }
  async close() { await this.flush(); }
  async reopen() { this.live = new Map(this.durable); this.dirty.clear(); }
  async assertEmpty() { assert.equal(this.live.size, 0); assert.equal(this.durable.size, 0); }
  async stats() { return { nodeCount: this.live.size }; }
}

const scale = Number(process.argv[2] ?? 1);
if (![1, 5, 10].includes(scale)) throw Error('usage: p4-resource.mjs [1|5|10] [output.json]');
const output = resolve(process.argv[3] ?? ('evals/t03/p4-p5/resource-' + scale + 'x.json'));
const backup = resolve('.t03-local/p4/p4-' + scale + 'x.ndjson');
mkdirSync(dirname(output), { recursive: true }); mkdirSync(dirname(backup), { recursive: true });

const limits = { rss_bytes: 1400 * 1024 * 1024, package_bytes: 512 * 1024 * 1024,
  physical_nodes: 1000000, elapsed_ms: 30 * 60 * 1000, minimum_free_disk_bytes: 20 * 1024 ** 3 };
const started = performance.now(), peaks = { rss: 0, heap_used: 0 }, samples = [];
function resourceSample(label, io = null) {
  const memory = process.memoryUsage(), disk = statfsSync('.');
  peaks.rss = Math.max(peaks.rss, memory.rss); peaks.heap_used = Math.max(peaks.heap_used, memory.heapUsed);
  const sample = { label, elapsed_ms: performance.now() - started, rss: memory.rss,
    heap_used: memory.heapUsed, physical_nodes: io?.live.size ?? null,
    free_disk_bytes: Number(disk.bavail) * Number(disk.bsize) };
  samples.push(sample);
  assert.ok(sample.rss < limits.rss_bytes, 'P4 RSS safety stop');
  assert.ok(sample.elapsed_ms < limits.elapsed_ms, 'P4 elapsed-time safety stop');
  assert.ok(sample.free_disk_bytes > limits.minimum_free_disk_bytes, 'P4 free-disk safety stop');
  if (io) assert.ok(io.live.size < limits.physical_nodes, 'P4 physical-node safety stop');
  return sample;
}

const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
const sourceIO = new MeteredIO(), sourceOwner = new PagedCoordinator(sourceIO);
let source = await sourceOwner.create();
const workloadStarted = performance.now();
const workload = await exercisePagedScale(source, { scale, onProgress: async progress => {
  if (progress.operations % 4 === 0) resourceSample(progress.phase + '-' + progress.operations, sourceIO);
} });
const workloadMs = performance.now() - workloadStarted;
resourceSample('workload-complete', sourceIO);

await sourceOwner.close(); sourceIO.reads = 0; const reopenStarted = performance.now();
const reopenedOwner = new PagedCoordinator(sourceIO); source = await reopenedOwner.recover();
const coldReopen = { elapsed_ms: performance.now() - reopenStarted, provider_reads: sourceIO.reads };
for (const range of workload.ranges) assert.deepEqual(await source.range(range.snapshot_id, range.start, range.values.length), range.values);
const sourceDiagnostic = await source.diagnostics(workload.branch_id), sourceInventory = await inventoryPagedIO(sourceIO);

const indexIO = new MeteredIO(), index = new RecallIndex(indexIO);
await index.rebuild(source, workload.branch_id);
const search = await index.search(source, workload.branch_id,
  { markers: ['青石门'], vector: artificialVector(workload.memory) });
assert.deepEqual(search.results.map(item => item.memory_revision_id), [workload.memory.memory_revision_id]);
const diagnostic = await describePagedStore(source, { branchId: workload.branch_id, index });

const sink = createWriteStream(backup); let backupBytes = 0, backupRecords = 0;
const exportStarted = performance.now();
for await (const chunk of await source.export()) {
  backupBytes += chunk.length; backupRecords++;
  assert.ok(backupBytes < limits.package_bytes, 'P4 package safety stop');
  if (!sink.write(chunk)) await once(sink, 'drain');
  if (backupRecords % 10000 === 0) resourceSample('export-' + backupRecords, sourceIO);
}
sink.end(); await once(sink, 'finish'); const exportMs = performance.now() - exportStarted;

const targetIO = new MeteredIO(), restoreStarted = performance.now();
async function* checkedInput() {
  let records = 0;
  for await (const chunk of createReadStream(backup, { highWaterMark: 32768 })) {
    yield chunk;
    if (++records % 1000 === 0) resourceSample('restore-stream-' + records, targetIO);
  }
}
const targetOwner = await restorePagedIntoEmpty(targetIO, checkedInput()), target = targetOwner.handle();
const restoreMs = performance.now() - restoreStarted;
for (const range of workload.ranges) assert.deepEqual(await target.range(range.snapshot_id, range.start, range.values.length), range.values);
for (const operation of [workload.operations[0], workload.operations.at(-1)])
  assert.deepEqual(await target.lookup(operation), await source.lookup(operation));
assert.equal((await target.read('memories', workload.memory.memory_revision_id)).content, workload.memory.content);
const targetDiagnostic = await target.diagnostics(workload.branch_id), targetInventory = await inventoryPagedIO(targetIO);
assert.equal(targetDiagnostic.operation_count, sourceDiagnostic.operation_count);
resourceSample('restore-complete', targetIO); delay.disable();

const physicalBytes = io => [...io.live.values()].reduce((sum, value) =>
  sum + Buffer.byteLength(canonicalize(value), 'utf8'), 0);
const report = { status: 'passed', date: '2026-09-21', scale, synthetic: true,
  scope: 'Windows desktop P4 resource exploration with metered in-memory provider; not native TT/mobile acceptance',
  device: { platform: process.platform, arch: process.arch, node: process.version, os_release: os.release(),
    cpu: os.cpus()[0]?.model ?? null, logical_cpus: os.cpus().length, total_memory_bytes: os.totalmem() },
  scenario: { ...workload, metrics: undefined, ranges: workload.ranges.map(range => ({
    snapshot_id: range.snapshot_id, start: range.start, count: range.values.length })) },
  timings: { workload_ms: workloadMs, cold_reopen: coldReopen, export_ms: exportMs, restore_ms: restoreMs,
    operation_ms: workload.metrics, event_loop_delay_max_ms: delay.max / 1e6 },
  provider: { source: { reads: sourceIO.reads, writes: sourceIO.writes, flushes: sourceIO.flushes,
    physical_payload_bytes: physicalBytes(sourceIO), inventory: sourceInventory },
    restored: { reads: targetIO.reads, writes: targetIO.writes, flushes: targetIO.flushes,
      physical_payload_bytes: physicalBytes(targetIO), inventory: targetInventory } },
  backup: { path: backup, bytes: backupBytes, records: backupRecords },
  resources: { peaks, samples, limits, stop_triggered: false }, diagnostic,
  correctness: { ranges: true, confirmed_results: true, selected_memory: true, complete_restore: true },
  maintenance_gate: 'HOST_MAINTENANCE_UNSUPPORTED', mobile: 'pending' };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, scale, output, backupBytes, sourceInventory, targetInventory, peaks }));
