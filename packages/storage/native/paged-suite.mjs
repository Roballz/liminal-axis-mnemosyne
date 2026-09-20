import { openPagedTestStore, requireExternalMaintenanceFence } from '../paged-tt-adapter.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { equal, importLogical, validateState } from '../../contracts/index.mjs';

const assert = (ok, message) => { if (!ok) throw Error(message); };
const collect = async source => {
  const resolved = await source, chunks = [];
  for await (const chunk of resolved) chunks.push(chunk);
  return chunks;
};

function historyInput(f) {
  const command = Object.values(f.state.operations)[0].command;
  return { operation_id: command.operation_id, kind: 'history', payload: command };
}

function appendInput(f) {
  const source = f.source('user', 'P3 分页故障边界中的虚构正文 😀');
  const command = f.command([...f.entries, source.ref], {
    change_kind: 'append', messages: [source.message], revisions: [source.revision],
  });
  const { entries, ...body } = command;
  return {
    operation_id: command.operation_id,
    kind: 'history-delta',
    payload: { ...body, splice: { start: f.entries.length, delete_count: 0, entries: [source.ref] } },
  };
}

function memoryInput(f) {
  const memory = f.memory(f.entries.slice(0, 2), 'Record');
  return {
    operation_id: f.ids('operation'), kind: 'memory',
    payload: {
      archives: [memory], action: 'select', branch_id: f.branch,
      revision_id: memory.memory_revision_id, old_revision_id: null,
      expected_view: f.state.views[f.branch].version, mode: 'replace',
    },
  };
}

function bindingInput(f) {
  const binding = {
    schema_version: 1, binding_id: f.ids('binding'), story_id: f.story, branch_id: f.branch,
    host_kind: 'fixture', host_scope: 'fictional', stable_id: 'fixture-host',
    mutable_ref: 'fictional.jsonl', binding_generation: 0,
    intent: 'confirmed_mapping', message_map: [],
  };
  return { operation_id: f.ids('operation'), kind: 'binding', payload: binding };
}

async function syncFixture(f, handle) {
  const logical = await handle.logical();
  validateState(logical.state);
  f.state = importLogical(logical);
  return logical;
}

async function publish(f, handle, input) {
  const prepared = await handle.prepare(input);
  const result = await handle.execute(input.operation_id);
  await syncFixture(f, handle);
  return { prepared, result };
}

async function runRoundtrip(api, run, send) {
  const sourceNamespace = `mnemo-t03-paged-${run}-source`;
  const targetNamespace = `mnemo-t03-paged-${run}-restored`;
  const f = fixture(2);
  const source = await openPagedTestStore(api, sourceNamespace, { create: true });
  let handle = source.handle();

  const initial = await publish(f, handle, historyInput(f));
  const initialOperation = initial.prepared.input.operation_id;
  const initialLogical = await handle.logical();
  const branch = initialLogical.state.branches[f.branch];
  const snapshot = await handle.read('snapshots', branch.head_snapshot_id);
  assert(snapshot.snapshot_id === branch.head_snapshot_id, 'Paged snapshot lookup mismatch');
  const operation = await handle.read('operations', initialOperation);
  assert(operation.operation_id === initialOperation && operation.payload_fingerprint, 'Paged operation lookup mismatch');
  const lookup = await handle.lookup(initialOperation);
  assert(lookup.status === 'published' && lookup.result.snapshot_id === branch.head_snapshot_id,
    'Paged durable lookup mismatch');
  const ranged = await handle.range(branch.head_snapshot_id, 0, f.entries.length);
  assert(equal(ranged, f.entries), 'Paged history range mismatch');

  await publish(f, handle, appendInput(f));
  await publish(f, handle, memoryInput(f));
  await publish(f, handle, bindingInput(f));
  const pendingInput = appendInput(f);
  const pending = await handle.prepare(pendingInput);
  assert(pending.status === 'prepared' && pending.result, 'Paged pending receipt missing result');
  assert(Object.hasOwn(pending, 'generated') && pending.generated.length > 0,
    'Paged pending receipt missing generated IDs');
  const sourceLogical = await handle.logical();
  const frozen = await collect(handle.export());
  await source.close();

  const restored = await openPagedTestStore(api, targetNamespace, { restore: frozen });
  handle = restored.handle();
  assert(equal(await handle.logical(), sourceLogical), 'Paged logical roundtrip mismatch');
  assert(equal(await handle.pending(), [pending]), 'Paged pending request/ID recovery mismatch');
  const retry = await handle.execute(pendingInput.operation_id);
  assert(equal(retry, pending.result), 'Paged restored retry result mismatch');
  assert(equal(await handle.execute(pendingInput.operation_id), retry), 'Paged restored idempotency mismatch');
  const restoredLogical = await handle.logical(); validateState(restoredLogical.state);
  // Memory and binding requests are durable coordinator operations but do not
  // create history command rows in the v2 domain operations table.
  assert(Object.keys(restoredLogical.state.operations).length === 3, 'Paged operation count mismatch');
  await restored.close();

  const reopened = await openPagedTestStore(api, targetNamespace);
  const reopenedHandle = reopened.handle();
  assert(equal(await reopenedHandle.execute(pendingInput.operation_id), retry), 'Paged reopen retry mismatch');
  validateState((await reopenedHandle.logical()).state);
  await reopened.close();

  let gate; try { requireExternalMaintenanceFence(); } catch (error) { gate = error.code; }
  assert(gate === 'HOST_MAINTENANCE_UNSUPPORTED', 'Automatic maintenance remains gated');
  await send({ type: 'done', phase: 'paged-roundtrip', run,
    namespaces: [sourceNamespace, targetNamespace], initialOperation,
    publishedOperations: 5, pendingGenerated: pending.generated,
    historyDelta: true, rangeRead: true, lookupRead: true, logicalRoundtrip: true,
    pendingIdRestore: true, restoredRetry: true, externalMaintenanceGate: gate,
    nativeArchiveOrSyncTriggered: false, processCrashTested: false });
}

async function runCrash(api, { phase, run, crashEvidence }, send) {
  const side = phase.endsWith('before') ? 'before' : 'after';
  const namespace = `mnemo-t03-paged-${run}-crash-${side}`;
  if (phase.startsWith('recover-')) {
    const owner = await openPagedTestStore(api, namespace), handle = owner.handle();
    const operation = crashEvidence.operation_id, found = await handle.lookup(operation);
    assert(found && found.status === (side === 'before' ? 'prepared' : 'published'),
      'Paged crash publication boundary');
    assert(equal(found.generated, crashEvidence.generated) && equal(found.result, crashEvidence.result),
      'Paged operation/IDs/result disagree with independent pre-crash evidence');
    const pending = await handle.pending();
    assert(pending.length === (side === 'before' ? 1 : 0), 'Paged pending checkpoint mismatch');
    const result = await handle.execute(operation);
    assert(equal(result, crashEvidence.result), 'Paged recovered result mismatch');
    assert(equal(await handle.execute(operation), result), 'Paged recovered idempotency mismatch');
    const logical = await handle.logical(); validateState(logical.state);
    assert(Object.keys(logical.state.operations).length === 2, 'Paged recovered operation count mismatch');
    await owner.close();
    await send({ type: 'done', phase, run, namespace, previousStatus: found.status, result,
      generated: found.generated, publishedOperations: 2, processCrashTested: true,
      materialsEvidenceMatched: true, nativeArchiveOrSyncTriggered: false });
    return;
  }

  const f = fixture(2);
  let armed = false, receipt;
  const boundary = side === 'before' ? 'paged-publish' : 'paged-ack';
  const point = async (label, edge) => {
    if (!armed || label !== boundary || edge !== 'before') return;
    await send({ type: 'kill-ready', phase, run, namespace, boundary: label, edge,
      operation_id: receipt.input.operation_id, input: receipt.input,
      generated: receipt.generated, result: receipt.result,
      preparedMaterialsFlushed: side === 'before', publishedRootFlushed: side === 'after',
      independentBeforeEvidence: true, isolatedFixture: true });
    await new Promise(() => {}); // Controller kills only the matching isolated process.
  };
  const owner = await openPagedTestStore(api, namespace, { create: true, point });
  const handle = owner.handle();
  // The owner is already open; initialize and prepare before arming the new-path
  // publication boundary so setup writes cannot be mistaken for the fault test.
  await publish(f, handle, historyInput(f));
  receipt = await handle.prepare(appendInput(f));
  assert(receipt.status === 'prepared', 'Paged crash request did not remain prepared');
  armed = true;
  await handle.execute(receipt.input.operation_id);
  throw Error('Paged crash boundary was not reached');
}

export async function runPagedNative(api, { phase, run, crashEvidence }, send) {
  if (phase === 'paged-reopen-check') {
    const sourceNamespace=`mnemo-t03-paged-${run}-source`, targetNamespace=`mnemo-t03-paged-${run}-restored`;
    const source=await openPagedTestStore(api,sourceNamespace), sh=source.handle();
    const pending=await sh.pending(); assert(pending.length===1,'Expected original durable pending request');
    const sourceLogical=await sh.logical(); await source.close();
    const target=await openPagedTestStore(api,targetNamespace), th=target.handle();
    const found=await th.lookup(pending[0].input.operation_id);
    assert(found.status==='published'&&equal(found.generated,pending[0].generated)&&equal(found.result,pending[0].result),'Final reader pending/result disagreement');
    const logical=await th.logical(); validateState(logical.state);
    assert(Object.keys(logical.state.operations).length===Object.keys(sourceLogical.state.operations).length+1,'Final reader operation count');
    await target.close();
    await send({type:'done',phase,run,namespaces:[sourceNamespace,targetNamespace],finalReaderCheckpointValidated:true,pendingIdsAndConfirmedResultPreserved:true,nativeArchiveOrSyncTriggered:false,processCrashTested:false});
    return;
  }
  if (phase === 'paged-roundtrip') return runRoundtrip(api, run, send);
  if (['paged-before', 'paged-after', 'recover-paged-before', 'recover-paged-after'].includes(phase)) {
    return runCrash(api, { phase, run, crashEvidence }, send);
  }
  throw Error(`Unknown paged phase ${phase}`);
}
