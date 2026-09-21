import { openPagedTestStore, requireExternalMaintenanceFence } from '../paged-tt-adapter.mjs';
import { RecallIndex, artificialVector } from '../recall-index.mjs';
import { describePagedStore } from '../paged-diagnostics.mjs';
import { exercisePagedScale } from '../p4-workload.mjs';
import { equal } from '../../contracts/primitives.mjs';

const options = { dim: 2, syncMode: 'full', autoBuildQuiver: false };
const limit = { elapsed_ms: 30 * 60 * 1000, physical_nodes: 1000000, package_bytes: 512 * 1024 * 1024 };
const assert = (condition, detail) => { if (!condition) throw Error(detail); };

async function indexIO(api, namespace) {
  let native;
  const io = {
    reopen: async () => { native = await api.open(namespace, options); },
    get: async slot => {
      const node = await native.get(slot + 1);
      if (node === null) return null;
      assert(node.payload && typeof node.payload === 'object' && !Array.isArray(node.payload), 'Invalid index payload');
      return node.payload;
    },
    put: (slot, payload) => native.upsert(slot + 1, [1, 0], payload),
    flush: () => native.flush(),
  };
  await io.reopen();
  return { io, stats: () => native.stats(), close: () => native.close() };
}

export async function runP4Native(api, { run }, send) {
  const sourceNamespace = 'mnemo-t03-paged-' + run + '-p4-source';
  const targetNamespace = 'mnemo-t03-paged-' + run + '-p4-restored';
  const indexNamespace = 'mnemo-t03-index-' + run + '-p4';
  const started = performance.now(), progress = [], heap = [];
  let maxLag = 0, expected = performance.now() + 100;
  const timer = setInterval(() => {
    const now = performance.now(); maxLag = Math.max(maxLag, now - expected); expected = now + 100;
  }, 100);
  const sample = async (label, handle) => {
    const diagnostic = await handle.diagnostics();
    const value = { label, elapsed_ms: performance.now() - started, physical_nodes: diagnostic.physical_nodes };
    progress.push(value);
    if (performance.memory) heap.push({ label, used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit });
    assert(value.elapsed_ms < limit.elapsed_ms, 'P4 native elapsed-time safety stop');
    assert(value.physical_nodes < limit.physical_nodes, 'P4 native physical-node safety stop');
    return value;
  };

  const sourceOwner = await openPagedTestStore(api, sourceNamespace, { create: true });
  let source = sourceOwner.handle(), workloadStarted = performance.now();
  await send({ type: 'progress', phase: 'p4-resource', run, stage: 'started', elapsed_ms: 0,
    source_namespace: sourceNamespace });
  const workload = await exercisePagedScale(source, { scale: 1, onProgress: async state => {
    if (state.operations % 4 === 0) {
      const value = await sample(state.phase + '-' + state.operations, source);
      await send({ type: 'progress', phase: 'p4-resource', run, stage: state.phase,
        completed: state.completed, total: state.total, operations: state.operations, ...value });
    }
  } });
  const workloadMs = performance.now() - workloadStarted;
  const completed = await sample('workload-complete', source);
  await send({ type: 'progress', phase: 'p4-resource', run, stage: 'workload-complete', ...completed });

  const indexStore = await indexIO(api, indexNamespace), index = new RecallIndex(indexStore.io);
  await index.rebuild(source, workload.branch_id);
  const search = await index.search(source, workload.branch_id,
    { markers: ['青石门'], vector: artificialVector(workload.memory) });
  assert(search.results.length === 1 && search.results[0].memory_revision_id === workload.memory.memory_revision_id,
    'Native index result mismatch');
  await indexStore.close();
  const reopenedIndexStore = await indexIO(api, indexNamespace), reopenedIndex = new RecallIndex(reopenedIndexStore.io);
  assert((await reopenedIndex.recover()).status === 'ready', 'Native index did not reopen');
  assert((await reopenedIndex.search(source, workload.branch_id,
    { markers: ['青石门'], vector: artificialVector(workload.memory) })).results.length === 1,
  'Native reopened index result mismatch');

  const beforeClose = await source.diagnostics(workload.branch_id);
  await sourceOwner.close(); const reopenStarted = performance.now();
  const reopenedOwner = await openPagedTestStore(api, sourceNamespace); source = reopenedOwner.handle();
  const coldReopen = { elapsed_ms: performance.now() - reopenStarted,
    diagnostic: await source.diagnostics(workload.branch_id) };
  assert(coldReopen.diagnostic.operation_count === beforeClose.operation_count, 'Native cold reopen count');
  for (const range of workload.ranges)
    assert(equal(await source.range(range.snapshot_id, range.start, range.values.length), range.values), 'Native range mismatch');

  let backupBytes = 0, backupRecords = 0;
  async function* countedExport() {
    for await (const chunk of await source.export()) {
      backupBytes += chunk.length; backupRecords++;
      assert(backupBytes < limit.package_bytes, 'P4 native package safety stop');
      yield chunk;
    }
  }
  const restoreStarted = performance.now();
  const targetOwner = await openPagedTestStore(api, targetNamespace, { restore: countedExport() });
  const restoreMs = performance.now() - restoreStarted, target = targetOwner.handle();
  await send({ type: 'progress', phase: 'p4-resource', run, stage: 'restore-complete',
    elapsed_ms: performance.now() - started, restore_ms: restoreMs, backup_bytes: backupBytes,
    backup_records: backupRecords });
  for (const range of workload.ranges)
    assert(equal(await target.range(range.snapshot_id, range.start, range.values.length), range.values), 'Native restored range mismatch');
  for (const operation of [workload.operations[0], workload.operations.at(-1)])
    assert(equal(await target.lookup(operation), await source.lookup(operation)), 'Native restored result mismatch');
  assert((await target.read('memories', workload.memory.memory_revision_id)).content === workload.memory.content,
    'Native restored memory mismatch');
  const targetDiagnostic = await target.diagnostics(workload.branch_id);
  assert(targetDiagnostic.operation_count === coldReopen.diagnostic.operation_count, 'Native restore operation count');
  const diagnostic = await describePagedStore(source, { branchId: workload.branch_id, index: reopenedIndex });
  let gate; try { requireExternalMaintenanceFence(); } catch (error) { gate = error.code; }
  assert(gate === 'HOST_MAINTENANCE_UNSUPPORTED', 'Native maintenance gate changed');
  clearInterval(timer);
  const indexStats = await reopenedIndexStore.stats(); await reopenedIndexStore.close();
  await reopenedOwner.close(); await targetOwner.close();
  await send({ type: 'done', phase: 'p4-resource', run, status: 'passed', synthetic: true,
    scope: 'Fixed TT 367b0c7 desktop provider P4 1x; not mobile/production acceptance',
    namespaces: [sourceNamespace, targetNamespace, indexNamespace], workload: {
      messages: workload.messages, current_characters: workload.current_characters,
      archived_revision_characters: workload.archived_revision_characters,
      operations: workload.operations.length, growth_rounds: workload.growth_rounds,
      edits: workload.edits, deletes: workload.deletes, forks: workload.forks },
    timings: { workload_ms: workloadMs, restore_ms: restoreMs, cold_reopen_ms: coldReopen.elapsed_ms,
      operation_ms: workload.metrics, main_thread_lag_max_ms: maxLag },
    provider: { source_physical_nodes: coldReopen.diagnostic.physical_nodes,
      restored_physical_nodes: targetDiagnostic.physical_nodes, index_physical_nodes: indexStats.nodeCount },
    backup: { bytes: backupBytes, records: backupRecords }, progress, heap,
    correctness: { ranges: true, confirmed_results: true, selected_memory: true,
      index_reopen: true, complete_restore: true }, diagnostic,
    limits: limit, externalMaintenanceGate: gate, nativeArchiveOrSyncTriggered: false,
    processCrashTested: false, mobile: 'pending' });
}
