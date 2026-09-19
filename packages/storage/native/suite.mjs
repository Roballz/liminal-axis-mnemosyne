import { sha256 } from '../../contracts/runtime.mjs';
import { canonicalize, newId, validateState, equal, memoryStatus, fingerprint } from '../../contracts/index.mjs';
import { openTestStore } from '../tt-adapter.mjs';
import { importIntoEmpty, expected, inspectBundle, prepareTransaction } from '../protocol.mjs';
import { scenario } from '../tests/scenario.mjs';
const assert = (condition, detail) => { if (!condition) throw Error(detail); };
const errorCode = async fn => { try { await fn(); return null; } catch (e) { return e.code ?? String(e); } };
export async function runNative(api, { phase, run }, send) {
  const prefix = `mnemo-t03-${run}`, s = scenario();
  if (phase === 'reopen-check') {
    const owner = await openTestStore(api, prefix + '-restored'), handle = owner.handle();
    const state = await handle.read(); validateState(state);
    assert(equal(state, s.f.state), 'Existing restored library changed after process exit');
    for (const request of s.requests) assert(equal(await handle.commit(request), request.result), 'Existing retry result changed');
    await send({ type: 'done', phase, namespace: prefix + '-restored',
      state: expected(state), ledgerCount: owner.ledger.size, validation: 'passed' });
    await owner.close(); return;
  }
  if (phase === 'p0') {
    const text = canonicalize({ z: '中文😀\r\n', a: [-0, 1e30, true, null] });
    const web = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    assert(sha256(text) === web, 'SHA/WebCrypto disagreement');
    const uuid = newId('operation');
    const name = prefix + '-capability';
    let native = await api.open(name, { dim: 2, syncMode: 'full', autoBuildQuiver: false });
    const payload = { format: 'synthetic-capability', unicode: '中文😀\r\n', nested: { a: [null, true, 17] } };
    assert(await native.get(777) === null, 'Fresh namespace not empty');
    await native.upsert(777, [1, 0], payload); await native.flush();
    assert(equal((await native.get(777)).payload, payload), 'Exact read mismatch');
    await native.close(); native = await api.open(name, { dim: 2, syncMode: 'full', autoBuildQuiver: false });
    assert(equal((await native.get(777)).payload, payload), 'Reopen mismatch');
    const stats = await native.stats();
    await send({ type: 'done', phase, namespace: name, sha256: web, uuidValid: /^op_.*-4.*-[89ab]/.test(uuid),
      methods: Object.keys(native), options: native.options, nodeCount: stats.nodeCount,
      complexJson: true, exactId: true, normalReopen: true, paidApiCalls: 0 });
    await native.close(); return;
  }
  if (['before', 'after', 'recover-before', 'recover-after'].includes(phase)) {
    const which = phase.endsWith('before') ? 'before' : 'after';
    const name = prefix + '-crash-' + which;
    let armed = false;
    const point = async (label, edge) => {
      if (armed && (which === 'before' ? label === 'publish' && edge === 'before' : label === 'publish-flush' && edge === 'after')) {
        await send({ type: 'kill-ready', phase, namespace: name, label, edge, operation: s.requests[2].operation_id,
          acknowledged: false, expected: s.requests[2].expected, result: s.requests[2].result, seed: 20260919 });
        await new Promise(() => {}); // Controller kills only the proven isolated executable.
      }
    };
    const owner = await openTestStore(api, name, point), handle = owner.handle();
    if (!phase.startsWith('recover-')) {
      for (const r of s.requests.slice(0, 2)) await handle.commit(r);
      await send({ type: 'baseline', namespace: name, state: expected(await handle.read()), acknowledged: true });
      armed = true; await handle.commit(s.requests[2]); throw Error('Kill boundary was not hit');
    }
    const beforeRetry = await handle.read(); validateState(beforeRetry);
    const selected = beforeRetry.views[s.f.branch].selections[s.old.memory_id];
    assert(selected === (which === 'before' ? s.old.memory_revision_id : s.fixed.memory_revision_id), 'Wrong recovered publication');
    assert(memoryStatus(beforeRetry, s.old.memory_revision_id, s.child) === 'valid', 'Child changed');
    const result = await handle.commit(s.requests[2]);
    assert(equal(result, s.requests[2].result), 'Retry result mismatch');
    assert(equal(await handle.commit(s.requests[2]), result), 'Repeat mismatch');
    await send({ type: 'done', phase, namespace: name, beforeRetry: expected(beforeRetry),
      afterRetry: expected(await handle.read()), selectedBeforeRetry: selected, seed: 20260919,
      operation: s.requests[2].operation_id, result, validation: 'passed', ledgerCount: owner.ledger.size });
    await owner.close(); return;
  }
  const source = await openTestStore(api, prefix + '-roundtrip'), h = source.handle();
  for (const r of s.requests) await h.commit(r);
  assert(equal(await h.read(), s.f.state), 'Native final state mismatch');
  const bundle = await h.export(); inspectBundle(bundle);
  await h.commit(prepareTransaction(s.f.state, s.f.state, s.f.ids('operation'), { step: 'after-export' }));
  assert(bundle.journal.length === s.requests.length, 'Export changed during later commit');
  const target = await openTestStore(api, prefix + '-restored');
  const restored = await importIntoEmpty(target, bundle);
  assert(equal(await restored.read(), s.f.state), 'Native import mismatch');
  for (const r of s.requests) assert(equal(await restored.commit(r), r.result), 'Restored idempotency mismatch');
  const conflict = await errorCode(() => restored.commit({ ...s.requests[0], result: null }));
  assert(conflict === 'OPERATION_CONFLICT', 'Wrong idempotency conflict');
  const bad = structuredClone(bundle), state = bad.logical.state;
  state.views[s.f.branch].selections[s.old.memory_id] = s.old.memory_revision_id;
  bad.logical.checksum = fingerprint('logical-export', { format_version: 2, state });
  const { checksum, ...payload } = bad; bad.checksum = fingerprint('write-payload', payload);
  const contradiction = await errorCode(() => importIntoEmpty(target, bad));
  assert(contradiction === 'NEEDS_RESOLUTION', 'R5 must reject a checksummed contradictory bundle');
  let release, entered;
  const held = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  let pause = true;
  const racing = await openTestStore(api, prefix + '-race', async (label, edge) => {
    if (pause && label === 'publish' && edge === 'after') { pause = false; entered(); await held; }
  });
  assert(await openTestStore(api, prefix + '-race') === racing, 'Two handles got different owners');
  const first = racing.handle().commit(s.requests[0]); await started;
  assert(await Promise.race([first, Promise.resolve('cancelled-waiter')]) === 'cancelled-waiter', 'Unexpected acknowledgement');
  let secondDone = false;
  const second = racing.handle().commit(s.requests[1]).then(value => { secondDone = true; return value; });
  const stale = racing.handle().commit({ ...s.requests[1], operation_id: s.f.ids('operation') });
  await Promise.resolve(); assert(!secondDone, 'Waiter cancellation released writer ownership');
  release(); await first; await second;
  assert(await errorCode(() => stale) === 'STALE_WRITE', 'Competing stale writer accepted');
  const oldHandle = racing.handle(); await racing.close();
  assert(await errorCode(() => oldHandle.read()) === 'STALE_HANDLE', 'Closed handle remained valid');
  let writes = 0;
  const staging = await openTestStore(api, prefix + '-interrupted-import', async (label, edge) => {
    if (label === 'publish' && edge === 'before' && ++writes === 2) throw Error('Synthetic import interruption');
  });
  assert(await errorCode(() => importIntoEmpty(staging, bundle)) === 'RECOVERY_REQUIRED', 'Import interruption missing');
  await staging.close();
  const stagedReopen = await openTestStore(api, prefix + '-interrupted-import');
  assert(await errorCode(() => stagedReopen.handle().read()) === 'RECOVERY_REQUIRED', 'Partial import activated');
  await stagedReopen.close();
  await source.close(); await target.close();
  const reopened = await openTestStore(api, prefix + '-restored');
  assert(equal(await reopened.handle().read(), s.f.state), 'Imported cold handle mismatch');
  await send({ type: 'done', phase, source: prefix + '-roundtrip', target: prefix + '-restored',
    stories: Object.keys(s.f.state.stories).length, branches: Object.keys(s.f.state.branches).length,
    logicalChecksum: bundle.logical.checksum, storageChecksum: bundle.checksum,
    restoredIdempotency: true, conflict, contradiction, normalReopen: true, sharedOwner: true,
    cancelledWaiterRetainedOwnership: true, staleWriterRejected: true, closedHandleRejected: true,
    interruptedImportNotActivated: true, exportSnapshotFixed: true, validation: 'passed' });
  await reopened.close();
}
