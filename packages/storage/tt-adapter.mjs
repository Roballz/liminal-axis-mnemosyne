import { StoreOwner } from './protocol.mjs';
import { requireThat } from '../contracts/primitives.mjs';

const registryKey = Symbol.for('mnemosyne.t03.storage.owners.v1');
// Dedicated synthetic namespaces only. No semantic vector queries are exposed.
export async function openTestStore(api, namespace, point) {
  if (!/^mnemo-t03-[a-z0-9-]+$/.test(namespace)) throw new Error('Dedicated T03 test namespace required');
  const registry = globalThis[registryKey] ??= new WeakMap();
  let owners = registry.get(api);
  if (!owners) { owners = new Map(); registry.set(api, owners); }
  if (owners.has(namespace)) {
    const registered = owners.get(namespace), owner = await registered;
    await owner.tail; // A close/open race must settle before choosing its owner.
    if (owners.get(namespace) !== registered) return openTestStore(api, namespace, point);
    return owner; // Failed close stays quarantined under this same owner.
  }
  const opening = (async () => {
    await Promise.resolve(); // Install registry entry before the first native call.
    let native;
    const owned = () => requireThat(owners.get(namespace) === opening,
      'OWNER_CLOSED', 'Native access requires the registered owner');
    const io = {
      reopen: async () => {
        owned(); native = await api.open(namespace, { dim: 2, syncMode: 'full', autoBuildQuiver: false });
      },
      // TT 367b0c7 runtime rejects physical NodeId 0 (reserved), despite the
      // public type saying nonnegative. Logical slot 0 maps to physical ID 1.
      get: async id => {
        owned(); const node = await native.get(id + 1);
        if (node === null) return null; // Only explicit native absence is an empty slot.
        requireThat(node && typeof node === 'object' && !Array.isArray(node) &&
          Object.hasOwn(node, 'payload') && node.payload !== null &&
          typeof node.payload === 'object' && !Array.isArray(node.payload),
        'NEEDS_RESOLUTION', 'Existing native node has an invalid protocol payload');
        return node.payload;
      },
      put: (id, payload) => { owned(); return native.upsert(id + 1, [1, 0], payload); },
      flush: () => { owned(); return native.flush(); },
      close: async () => {
        owned(); await native.close();
        if (owners.get(namespace) === opening) owners.delete(namespace);
      },
      point,
    };
    const owner = new StoreOwner(io);
    await owner.recover();
    return owner;
  })();
  owners.set(namespace, opening);
  try { return await opening; }
  catch (error) { if (owners.get(namespace) === opening) owners.delete(namespace); throw error; }
}
