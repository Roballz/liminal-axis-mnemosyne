import { openPagedTestStore, requireExternalMaintenanceFence } from '../paged-tt-adapter.mjs';
import { collectPagedDiagnostic } from '../paged-diagnostics.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';

const assert = (condition, detail) => { if (!condition) throw Error(detail); };

export async function runP5Native(api, { run }, send) {
  const namespace = 'mnemo-t03-paged-' + run + '-p4-source', f = fixture(0);
  const owner = await openPagedTestStore(api, namespace), handle = owner.handle();
  const diagnostic = await collectPagedDiagnostic(handle, { branchId: f.branch, namespace });
  assert(diagnostic.read_only && diagnostic.capabilities.writes === false, 'P5 diagnostic must be read-only');
  assert(diagnostic.storage.operation_count === 12, 'Unexpected P4 stopped-run operation count');
  assert(diagnostic.storage.pending_operation_id === null, 'Stopped-run should not retain pending work');
  assert(diagnostic.storage.branch.marker.index === 'behind', 'Stopped-run index marker changed');
  let gate; try { requireExternalMaintenanceFence(); } catch (error) { gate = error.code; }
  assert(gate === 'HOST_MAINTENANCE_UNSUPPORTED', 'Automatic maintenance gate changed');
  await owner.close();
  await send({ type: 'done', phase: 'p5-diagnostics', run, status: 'passed', synthetic: true,
    scope: 'Read-only cold reopen of the stopped P4 isolated TT library; not mobile/production acceptance',
    namespace, diagnostic, externalMaintenanceGate: gate, backupRestoreVerification: 'node-command',
    nativeArchiveOrSyncTriggered: false, mobile: 'pending' });
}
