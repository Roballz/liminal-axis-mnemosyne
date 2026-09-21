// Dedicated P3 paged-storage diagnostics. Automatic host maintenance remains gated.
import { PagedCoordinator } from './paged-coordinator.mjs';
import { restorePagedIntoEmpty } from './paged-recovery.mjs';
import { requireThat } from '../contracts/primitives.mjs';

const key = Symbol.for('mnemosyne.t03.paged-test-owners.v1');
const options = { dim: 2, syncMode: 'full', autoBuildQuiver: false };

export async function openPagedTestStore(api, namespace, { create = false, createIfEmpty = false, restore = null, point, meter } = {}) {
  requireThat(/^mnemo-t03-paged-[a-z0-9-]+$/.test(namespace),
    'INVALID_NAMESPACE', 'New P3 paged namespace required');
  requireThat(!((create || createIfEmpty) && restore), 'INVALID_SCHEMA', 'Choose create or restore');
  const registry = globalThis[key] ??= new WeakMap();
  let owners = registry.get(api);
  if (!owners) { owners = new Map(); registry.set(api, owners); }
  if (owners.has(namespace)) {
    const registered = owners.get(namespace), facade = await registered;
    await facade.settled();
    if (owners.get(namespace) !== registered) {
      return openPagedTestStore(api, namespace, { create, createIfEmpty, restore, point, meter });
    }
    if (facade.status === 'closed') {
      owners.delete(namespace);
      return openPagedTestStore(api, namespace, { create, createIfEmpty, restore, point, meter });
    }
    requireThat(!restore, 'IMPORT_TARGET_NOT_EMPTY', 'Cannot restore into an owned namespace');
    return facade;
  }
  const opening = (async () => {
    // Install the registry entry before the first native call so concurrent opens
    // share the same coordinator and a closing owner cannot be replaced early.
    await Promise.resolve();
    let native;
    const owned = () => requireThat(owners.get(namespace) === opening,
      'OWNER_CLOSED', 'Not the registered paged coordinator');
    const io = {
      reopen: async () => {
        owned(); native = await api.open(namespace, options);
      },
      get: async slot => {
        owned(); const node = await native.get(slot + 1);
        if (node === null) return null;
        requireThat(node && typeof node === 'object' && !Array.isArray(node) &&
          Object.hasOwn(node, 'payload') && node.payload !== null &&
          typeof node.payload === 'object' && !Array.isArray(node.payload),
        'NEEDS_RESOLUTION', 'Existing native node has an invalid paged payload');
        return node.payload;
      },
      put: (slot, payload) => { owned(); return native.upsert(slot + 1, [1, 0], payload); },
      flush: () => { owned(); return native.flush(); },
      stats: () => { owned(); return native.stats(); },
      close: () => { owned(); return native.close(); },
      assertEmpty: async () => {
        owned(); requireThat((await native.stats()).nodeCount === 0,
          'IMPORT_TARGET_NOT_EMPTY', 'Paged creation needs an empty isolated namespace');
      },
      point,
    };
    // Probe only under the registered owner; a nonempty/corrupt namespace is never recreated.
    if (createIfEmpty) {
      await io.reopen();
      try { create = (await io.stats()).nodeCount === 0; }
      finally { await io.close(); }
    }
    const measured = meter ? meter.io(io) : io;
    const coordinator = restore
      ? await restorePagedIntoEmpty(measured, restore)
      : new PagedCoordinator(measured);
    if (!restore) {
      if (create) await coordinator.create();
      else await coordinator.recover();
    }
    return Object.freeze({
      get status() { return coordinator.status; },
      settled: () => coordinator.settled(),
      handle: () => coordinator.handle(),
      recover: () => coordinator.recover(),
      suspend: () => coordinator.suspend(),
      resume: ticket => coordinator.resume(ticket),
      close: () => coordinator.close(),
    });
  })();
  owners.set(namespace, opening);
  try { return await opening; }
  catch (error) { if (owners.get(namespace) === opening) owners.delete(namespace); throw error; }
}

// Keep the same explicit safety gate as the intent diagnostic adapter. A user
// flag cannot turn namespace-only dispatch into a verified maintenance fence.
export { requireExternalMaintenanceFence } from './intent-tt-adapter.mjs';
