// Dedicated P3 prerequisite diagnostics. No automatic host-maintenance support.
import { IntentCoordinator, restoreIntentIntoEmpty } from './intent-prototype.mjs';
import { requireThat } from '../contracts/primitives.mjs';
const key = Symbol.for('mnemosyne.t03.intent-test-owners.v1');

export async function openIntentTestStore(api, namespace, { create = false, restore = null, point } = {}) {
  requireThat(/^mnemo-t03-p3-[a-z0-9-]+$/.test(namespace), 'INVALID_NAMESPACE', 'New P3 isolated test namespace required');
  requireThat(!(create && restore), 'INVALID_SCHEMA', 'Choose create or restore');
  const registry = globalThis[key] ??= new WeakMap();
  let owners = registry.get(api);
  if (!owners) { owners = new Map(); registry.set(api, owners); }
  if (owners.has(namespace)) {
    const registered = owners.get(namespace), facade = await registered;
    await facade.settled();
    if (owners.get(namespace) !== registered) return openIntentTestStore(api, namespace, { create, restore, point });
    if (facade.status === 'closed') { owners.delete(namespace); return openIntentTestStore(api, namespace, { create, restore, point }); }
    requireThat(!restore, 'IMPORT_TARGET_NOT_EMPTY', 'Cannot restore into an owned namespace');
    return facade;
  }
  const opening = (async () => {
    await Promise.resolve();
    let native;
    const owned = () => requireThat(owners.get(namespace) === opening, 'OWNER_CLOSED', 'Not the registered diagnostic coordinator');
    const io = {
      reopen: async () => { owned(); native = await api.open(namespace, { dim: 2, syncMode: 'full', autoBuildQuiver: false }); },
      get: async slot => {
        owned(); const node = await native.get(slot + 1);
        if (node === null) return null;
        requireThat(node && typeof node.payload === 'object' && node.payload !== null && !Array.isArray(node.payload),
          'NEEDS_RESOLUTION', 'Malformed native payload');
        return node.payload;
      },
      put: (slot, payload) => { owned(); return native.upsert(slot + 1, [1, 0], payload); },
      flush: () => { owned(); return native.flush(); },
      close: () => { owned(); return native.close(); },
      assertEmpty: async () => { owned(); requireThat((await native.stats()).nodeCount === 0,
        'IMPORT_TARGET_NOT_EMPTY', 'Creation needs an empty isolated namespace'); },
      point,
    };
    const coordinator = restore ? await restoreIntentIntoEmpty(io, restore) : new IntentCoordinator(io);
    if (!restore) { if (create) await coordinator.create(); else await coordinator.recover(); }
    return Object.freeze({
      get status() { return coordinator.status; },
      settled: () => coordinator.settled(),
      handle: () => coordinator.handle(), recover: () => coordinator.recover(),
      suspend: () => coordinator.suspend(), resume: ticket => coordinator.resume(ticket),
      close: () => coordinator.close(),
    });
  })();
  owners.set(namespace, opening);
  try { return await opening; }
  catch (error) { if (owners.get(namespace) === opening) owners.delete(namespace); throw error; }
}

// This gate is intentionally closed. No user flag can turn missing native
// fencing into a verified automatic synchronization/archive integration.
export function requireExternalMaintenanceFence() {
  requireThat(false, 'HOST_MAINTENANCE_UNSUPPORTED',
    'TT 367b0c7 public database API dispatches by namespace without a lease or expected open generation');
}
