import { openIntentTestStore, requireExternalMaintenanceFence } from '../intent-tt-adapter.mjs';
import { IDENTITY_SLOT } from '../intent-prototype.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { equal, validateState } from '../../contracts/index.mjs';
const assert = (ok, message) => { if (!ok) throw Error(message); };
const code = async fn => { try { await fn(); return null; } catch (e) { return e.code ?? String(e); } };
const options = { dim: 2, syncMode: 'full', autoBuildQuiver: false };

export async function runIntentNative(api, { run }, send) {
  const prefix = `mnemo-t03-p3-${run}`;
  const namespace = prefix + '-intent';
  const owner = await openIntentTestStore(api, namespace, { create: true });
  const f = fixture(2), command = Object.values(f.state.operations)[0].command;
  let h = owner.handle();
  const input = { operation_id: command.operation_id, kind: 'history', payload: command };
  const receipt = await h.prepare(input);
  await owner.close();
  const reopened = await openIntentTestStore(api, namespace); h = reopened.handle();
  assert(equal((await h.pending())[0], receipt), 'Native prepared request/ID recovery');
  const result = await h.execute(input.operation_id);
  assert(equal(await h.execute(input.operation_id), result), 'Native published retry');
  f.state = await h.read();
  const memory = f.memory(f.entries);
  const memoryInput = { operation_id: f.ids('operation'), kind: 'memory', payload: {
    archives: [memory], action: 'select', branch_id: f.branch, revision_id: memory.memory_revision_id,
    old_revision_id: null, expected_view: f.state.views[f.branch].version, mode: 'replace',
  } };
  await h.prepare(memoryInput);
  const ticket = await reopened.suspend();
  const stale = await code(() => h.read()); assert(stale === 'STALE_HANDLE', 'Old maintenance handle rejected');
  h = await reopened.resume(ticket); await h.execute(memoryInput.operation_id);
  validateState(await h.read());
  const secondTicket = await reopened.suspend();
  // Only synthetic identity metadata in this new namespace is changed.
  const raw = await api.open(namespace, options), original = await raw.get(IDENTITY_SLOT + 1);
  await raw.upsert(IDENTITY_SLOT + 1, [1, 0], { ...original.payload, library_id: f.ids('operation') });
  await raw.flush(); await raw.close();
  const changed = await code(() => reopened.resume(secondTicket));
  assert(changed === 'LIBRARY_CHANGED', 'Same-name library replacement quarantined');
  const repair = await api.open(namespace, options);
  await repair.upsert(IDENTITY_SLOT + 1, [1, 0], original.payload); await repair.flush(); await repair.close();
  h = await reopened.resume(secondTicket);
  const finalState = await h.read(); validateState(finalState);
  await reopened.close();
  const third = await openIntentTestStore(api, namespace), thirdHandle = third.handle();
  assert(equal(await thirdHandle.read(), finalState), 'Native re-reopen preserves published history and selection');
  assert((await thirdHandle.lookup(memoryInput.operation_id)).status === 'published', 'Memory ledger restored');
  await third.close();

  // Real native close/reopen with an old handle, NOT a real archive/sync test.
  // It reproduces the primitive that a before-write JS identity check cannot fence.
  const fenceNamespace = prefix + '-fence';
  const old = await api.open(fenceNamespace, options);
  assert((await old.stats()).nodeCount === 0, 'Fresh race namespace required');
  await old.upsert(1, [1, 0], { library: 'synthetic-A' }); await old.flush();
  const checked = await old.get(1);
  await old.close();
  const replacement = await api.open(fenceNamespace, options);
  await replacement.upsert(1, [1, 0], { library: 'synthetic-B' }); await replacement.flush();
  await old.upsert(2, [1, 0], { writer: 'old-A-handle' }); await old.flush();
  const leaked = await replacement.get(2);
  assert(checked.payload.library === 'synthetic-A' && leaked.payload.writer === 'old-A-handle', 'Native namespace dispatch counterexample');
  await replacement.close();
  const gate = await code(() => requireExternalMaintenanceFence());
  assert(gate === 'HOST_MAINTENANCE_UNSUPPORTED', 'Production maintenance gate stays closed');
  await send({ type: 'done', phase: 'p3-intent', run, namespaces: [namespace, fenceNamespace],
    preparedRequestRecovered: true, generatedIdsRecovered: receipt.generated, historyResult: result,
    memoryResult: finalState.views[f.branch], oldHandle: stale, replacedIdentity: changed,
    publishedRequests: 2, oldNativeHandleWroteAfterReopen: true, externalMaintenanceGate: gate,
    nativeArchiveOrSyncTriggered: false, processCrashTested: false });
}
