import { Pages } from './pages.mjs';
import { ROOT_SLOT, checkRoot } from './paged-coordinator.mjs';
import { equal, requireThat as check } from '../contracts/primitives.mjs';

const isRef = value => value && typeof value === 'object' && !Array.isArray(value) &&
  equal(Object.keys(value).sort(), ['hash', 'slot']) && /^[0-9a-f]{64}$/.test(value.hash) &&
  Number.isSafeInteger(value.slot);

export function readOnlyPagedHandle(handle) {
  const names = ['audit', 'diagnostics', 'enumerate', 'export', 'logical', 'lookup', 'memoryStatus', 'pending', 'range', 'read'];
  const result = {};
  for (const name of names) check(typeof handle[name] === 'function', 'INVALID_SCHEMA', 'Missing read method ' + name);
  for (const name of names) result[name] = (...args) => handle[name](...args);
  return Object.freeze(result);
}

export async function describePagedStore(handle, { branchId = null, index = null } = {}) {
  const storage = await handle.diagnostics(branchId);
  const indexStatus = index && branchId ? await index.status(handle, branchId) : null;
  return { storage, index: indexStatus, errors: [storage.error, indexStatus?.error].filter(Boolean),
    maintenance: { automatic_external: 'HOST_MAINTENANCE_UNSUPPORTED', cooperative: 'suspend-required' } };
}

export async function inventoryPagedIO(io) {
  check(io && typeof io.get === 'function', 'INVALID_SCHEMA', 'Paged IO required');
  const root = checkRoot(await io.get(ROOT_SLOT)), pages = new Pages(io);
  const directorySlots = new Set();
  async function walkDirectory(ref) {
    if (ref === null || directorySlots.has(ref.slot)) return;
    directorySlots.add(ref.slot); const node = await pages.get(ref);
    check(node.kind === 'map', 'NEEDS_RESOLUTION', 'Page directory must be a map');
    await walkDirectory(node.left); await walkDirectory(node.right);
  }
  await walkDirectory(root.directory);
  const business = new Map();
  for await (const [hash, ref] of pages.mapEntries(root.directory)) {
    check(hash === ref.hash, 'NEEDS_RESOLUTION', 'Directory hash mismatch'); business.set(hash, ref.slot);
  }
  const reachable = new Set();
  async function visit(value, depth = 0) {
    check(depth < 128, 'RESOURCE_LIMIT', 'Inventory reference depth');
    if (isRef(value)) {
      if (reachable.has(value.hash)) return;
      reachable.add(value.hash); await visit(await pages.get(value), depth + 1); return;
    }
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) await visit(child, depth + 1);
  }
  await visit(root.control);
  const physical = typeof io.stats === 'function' ? (await io.stats()).nodeCount : io.live?.size ?? null;
  const currentReachable = [...reachable].filter(hash => business.has(hash)).length;
  return {
    physical_nodes: physical,
    cataloged_business_pages: business.size,
    active_checkpoint_reachable_pages: currentReachable,
    cataloged_unreachable_pages: business.size - currentReachable,
    active_directory_pages: directorySlots.size,
    stale_directory_or_intermediate_pages: physical === null ? null : Math.max(0,
      physical - 1 - business.size - directorySlots.size),
    root_nodes: 1,
  };
}
