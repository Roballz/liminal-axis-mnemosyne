import { openIntentTestStore, requireExternalMaintenanceFence } from '../intent-tt-adapter.mjs';
import { readIntentRecovery } from '../intent-prototype.mjs';
import { Pages } from '../pages.mjs';
import { PagedJSON } from '../paged-json.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { equal, validateState } from '../../contracts/index.mjs';
const assert = (ok, text) => { if (!ok) throw Error(text); };
const options = { dim: 2, syncMode: 'full', autoBuildQuiver: false };
const chunks = async source => { const a = []; for await (const x of source) a.push(x); return a; };
async function init(api, namespace, point) {
  const owner = await openIntentTestStore(api, namespace, { create: true, point }), h = owner.handle(), f = fixture(2);
  const command = Object.values(f.state.operations)[0].command;
  await h.prepare({ operation_id: command.operation_id, kind: 'history', payload: command }); await h.execute(command.operation_id);
  f.state = await h.read(); return { owner, h, f };
}
function append(f) {
  const source = f.source('user', 'P3隔离进程故障：未确认的虚构正文 😀');
  const command = f.command([...f.entries, source.ref], { change_kind: 'append', messages: [source.message], revisions: [source.revision] });
  return { operation_id: command.operation_id, kind: 'history', payload: command };
}
export async function runRecoveryNative(api, { phase, run, crashEvidence }, send) {
  const prefix = `mnemo-t03-p3-${run}`;
  if (['p3-before', 'p3-after', 'recover-p3-before', 'recover-p3-after'].includes(phase)) {
    const side = phase.endsWith('before') ? 'before' : 'after', namespace = `${prefix}-crash-${side}`;
    if (phase.startsWith('recover-')) {
      const owner = await openIntentTestStore(api, namespace), h = owner.handle();
      const snapshot = await readIntentRecovery(await h.export()), last = snapshot.intents.at(-1), operation = last.input.operation_id;
      assert(snapshot.intents.length === 2, 'Both original and prepared requests recovered');
      const found = await h.lookup(operation);
      assert(found.status === (side === 'before' ? 'prepared' : 'published'), 'Crash publication boundary');
      assert(crashEvidence?.namespace === namespace && crashEvidence.operation_id === operation &&
        equal(found.generated, crashEvidence.generated) && equal(last.compiled.result, crashEvidence.result),
      'Operation/IDs/result match independent pre-crash evidence');
      const result = await h.execute(operation); assert(equal(result, last.compiled.result), 'Original generated result reused');
      assert(equal(await h.execute(operation), result), 'Recovered idempotency');
      const state = await h.read(); validateState(state); assert(Object.keys(state.operations).length === 2, 'No duplicate operation');
      await owner.close();
      await send({ type: 'done', phase, namespace, previousStatus: found.status, result, generated: last.generated,
        publishedOperations: 2, processCrashTested: true, hardwarePowerLossTested: false, nativeArchiveOrSyncTriggered: false }); return;
    }
    let armed = false, receipt;
    const c = await init(api, namespace, async (label, edge) => {
      if (armed && edge === 'before' && label === (side === 'before' ? 'publish' : 'ack')) {
        await send({ type: 'kill-ready', phase, namespace, boundary: label, preparedIntentFlushed: true,
          publishedRootFlushed: side === 'after', isolatedFixture: true, operation_id: receipt.input.operation_id,
          generated: receipt.generated, result: receipt.request.result });
        await new Promise(() => {});
      }
    });
    const input = append(c.f); receipt = await c.h.prepare(input); armed = true; await c.h.execute(input.operation_id);
    throw Error('Crash boundary not reached');
  }
  assert(phase === 'p3-recovery', 'Unknown recovery phase');
  const source = prefix + '-source', target = prefix + '-restored', pageNamespace = prefix + '-pages';
  const c = await init(api, source);
  const memory = c.f.memory(c.f.entries), memoryInput = { operation_id: c.f.ids('operation'), kind: 'memory', payload: {
    archives: [memory], action: 'select', branch_id: c.f.branch, revision_id: memory.memory_revision_id,
    old_revision_id: null, expected_view: c.f.state.views[c.f.branch].version, mode: 'replace',
  } };
  await c.h.prepare(memoryInput); await c.h.execute(memoryInput.operation_id); c.f.state = await c.h.read();
  const pendingInput = append(c.f), pending = await c.h.prepare(pendingInput);
  const boundary = await chunks(await c.h.export()), originalState = await c.h.read();
  const restored = await openIntentTestStore(api, target, { restore: boundary }), h = restored.handle();
  assert(equal(await h.read(), originalState), 'Complete recovery logical equality');
  assert(equal(await h.pending(), [pending]), 'Complete recovery pending/IDs');
  const sourceSnapshot = await readIntentRecovery(boundary), targetSnapshot = await readIntentRecovery(await h.export());
  assert(equal(sourceSnapshot.bundle, targetSnapshot.bundle) && equal(sourceSnapshot.intents, targetSnapshot.intents), 'All recovery material identical');
  await h.execute(pendingInput.operation_id); await restored.close();
  const reopened = await openIntentTestStore(api, target);
  assert(equal(await reopened.handle().execute(pendingInput.operation_id), pending.request.result), 'Restored retry survives native reopen');
  await reopened.close(); await c.owner.close();

  // Exact high numeric IDs are verified against THIS binary, not inferred from a type.
  let raw = await api.open(pageNamespace, options); assert((await raw.stats()).nodeCount === 0, 'Fresh page test namespace');
  let maximumPhysicalId = 0;
  const io = { get: async slot => (await raw.get(slot + 1))?.payload ?? null,
    put: (slot, value) => { maximumPhysicalId = Math.max(maximumPhysicalId, slot + 1); return raw.upsert(slot + 1, [1, 0], value); } };
  const pages = new Pages(io), json = new PagedJSON(pages);
  const data = { manifest: Array.from({ length: 48 }, (_, i) => ({ message: `虚构-${i}`, revision: `r-${i}` })),
    view: { version: 'synthetic', corrections: {}, selections: {} }, body: '中文😀'.repeat(700) };
  const root = await json.write(data), replacement = await json.write({ message: '虚构-17', revision: 'r-new' });
  const next = await json.set(root, ['manifest', 17], replacement);
  await raw.upsert(1, [1, 0], { kind: 'isolated-pages-root', root, next }); await raw.flush();
  const stats = await raw.stats(); await raw.close(); raw = await api.open(pageNamespace, options);
  const stored = (await raw.get(1)).payload, cold = new PagedJSON(new Pages(io));
  assert(equal(await cold.read(stored.root), data), 'Paged old snapshot retained after reopen');
  const updated = structuredClone(data); updated.manifest[17].revision = 'r-new';
  assert(equal(await cold.read(stored.next), updated), 'Paged local edit after reopen'); await raw.close();
  let gate; try { requireExternalMaintenanceFence(); } catch (e) { gate = e.code; }
  assert(gate === 'HOST_MAINTENANCE_UNSUPPORTED', 'Automatic maintenance remains gated');
  await send({ type: 'done', phase, namespaces: [source, target, pageNamespace], sourcePublished: 2, restoredPublished: 3,
    completeAuxiliaryRoundtrip: true, pendingGenerated: pending.generated, logicalEquality: true, pagedReopen: true,
    pageNodes: stats.nodeCount, maximumPhysicalId,
    externalMaintenanceGate: gate, nativeArchiveOrSyncTriggered: false, processCrashTested: false });
}
