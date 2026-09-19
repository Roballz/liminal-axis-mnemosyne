import { StoreOwner } from './protocol.mjs';

const registryKey = Symbol.for('mnemosyne.t03.storage.owners.v1');
// Dedicated synthetic namespaces only. No semantic vector queries are exposed.
export async function openTestStore(api, namespace, point) {
  if (!/^mnemo-t03-[a-z0-9-]+$/.test(namespace)) throw new Error('Dedicated T03 test namespace required');
  const registry = globalThis[registryKey] ??= new WeakMap();
  let owners = registry.get(api);
  if (!owners) { owners = new Map(); registry.set(api, owners); }
  if (owners.has(namespace)) return owners.get(namespace);
  const opening = (async () => {
    const native = await api.open(namespace, { dim: 2, syncMode: 'full', autoBuildQuiver: false });
    const io = {
      // TT 367b0c7 runtime rejects physical NodeId 0 (reserved), despite the
      // public type saying nonnegative. Logical slot 0 maps to physical ID 1.
      get: async id => (await native.get(id + 1))?.payload ?? null,
      put: (id, payload) => native.upsert(id + 1, [1, 0], payload),
      flush: () => native.flush(),
      close: async () => { try { await native.close(); } finally { owners.delete(namespace); } },
      point,
    };
    const owner = new StoreOwner(io);
    await owner.recover();
    return owner;
  })();
  owners.set(namespace, opening);
  try { return await opening; } catch (error) { owners.delete(namespace); throw error; }
}
