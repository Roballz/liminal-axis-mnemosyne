// Immutable, content-addressed pages for isolated P3 storage experiments.
// No root publication, domain validation or host-maintenance promise is implied.
import { canonicalize, equal, freeze, requireThat } from '../contracts/primitives.mjs';
import { sha256 } from '../contracts/runtime.mjs';
const check = requireThat;
export const PAGE_FORMAT = 'mnemosyne-pages-v1';
export const PAGE_LIMITS = Object.freeze({ bytes: 8192, leaf: 16, keyBytes: 512, cache: 128, depth: 64 });
const bytes = value => new TextEncoder().encode(canonicalize(value)).length;
const reference = value => value && typeof value === 'object' &&
  equal(Object.keys(value).sort(), ['hash', 'slot']) && /^[0-9a-f]{64}$/.test(value.hash) &&
  Number.isSafeInteger(value.slot) && value.slot >= 65536 && value.slot < 2 ** 48 + 65536;
export const pageSlot = hash => parseInt(hash.slice(0, 12), 16) + 65536;

export class Pages {
  #io; #cache = new Map(); #address;
  constructor(io, { address = pageSlot } = {}) { this.#io = io; this.#address = address; }
  clearCache() { this.#cache.clear(); }
  get cacheSize() { return this.#cache.size; }
  #remember(ref, page) {
    this.#cache.delete(ref.hash); this.#cache.set(ref.hash, freeze(page));
    if (this.#cache.size > PAGE_LIMITS.cache) this.#cache.delete(this.#cache.keys().next().value);
  }
  async put(body) {
    const page = { format: PAGE_FORMAT, body }, hash = sha256(canonicalize(page));
    const ref = { hash, slot: this.#address(hash) };
    check(reference(ref), 'RESOURCE_LIMIT', 'Page address outside exact integer range');
    check(bytes(page) <= PAGE_LIMITS.bytes, 'RESOURCE_LIMIT', 'Page exceeds byte limit');
    const old = await this.#io.get(ref.slot);
    check(old === null || equal(old, page), 'ID_COLLISION', 'Physical address collision; existing page preserved');
    if (old === null) {
      await this.#io.point?.('page-write', 'before');
      await this.#io.put(ref.slot, page);
      await this.#io.point?.('page-write', 'after');
    }
    this.#remember(ref, structuredClone(page)); return ref;
  }
  async get(ref) {
    check(reference(ref) && this.#address(ref.hash) === ref.slot, 'NEEDS_RESOLUTION', 'Invalid page reference');
    const cached = this.#cache.get(ref.hash);
    if (cached) return cached.body;
    const page = await this.#io.get(ref.slot);
    check(page && equal(Object.keys(page).sort(), ['body', 'format']) && page.format === PAGE_FORMAT &&
      bytes(page) <= PAGE_LIMITS.bytes && sha256(canonicalize(page)) === ref.hash,
    'NEEDS_RESOLUTION', 'Missing, corrupt or oversized page');
    this.#remember(ref, page); return page.body;
  }
  // A persistent AVL map: one key/value per page. Updates only copy the search
  // path and rotations, independent of the total number of archived objects.
  async #map(ref) {
    if (ref === null) return null;
    const n = await this.get(ref);
    check(n.kind === 'map' && equal(Object.keys(n).sort(), ['height', 'key', 'kind', 'left', 'right', 'value']) &&
      typeof n.key === 'string' && bytes(n.key) <= PAGE_LIMITS.keyBytes && reference(n.value) &&
      (n.left === null || reference(n.left)) && (n.right === null || reference(n.right)) &&
      Number.isSafeInteger(n.height) && n.height >= 1 && n.height <= PAGE_LIMITS.depth,
    'NEEDS_RESOLUTION', 'Malformed map page'); return n;
  }
  async #height(ref) { return ref === null ? 0 : (await this.#map(ref)).height; }
  async #node(key, value, left, right) {
    return this.put({ kind: 'map', key, value, left, right,
      height: Math.max(await this.#height(left), await this.#height(right)) + 1 });
  }
  async #balance(key, value, left, right) {
    const delta = await this.#height(left) - await this.#height(right);
    if (delta > 1) {
      let l = await this.#map(left);
      if (await this.#height(l.left) < await this.#height(l.right)) {
        const middle = await this.#map(l.right);
        left = await this.#node(middle.key, middle.value,
          await this.#node(l.key, l.value, l.left, middle.left), middle.right);
        l = await this.#map(left);
      }
      return this.#node(l.key, l.value, l.left, await this.#node(key, value, l.right, right));
    }
    if (delta < -1) {
      let r = await this.#map(right);
      if (await this.#height(r.right) < await this.#height(r.left)) {
        const middle = await this.#map(r.left);
        right = await this.#node(middle.key, middle.value, middle.left,
          await this.#node(r.key, r.value, middle.right, r.right));
        r = await this.#map(right);
      }
      return this.#node(r.key, r.value, await this.#node(key, value, left, r.left), r.right);
    }
    return this.#node(key, value, left, right);
  }
  async mapGet(root, key) {
    for (let depth = 0; root !== null; depth++) {
      check(depth < PAGE_LIMITS.depth, 'NEEDS_RESOLUTION', 'Map depth limit');
      const n = await this.#map(root); if (key === n.key) return n.value;
      root = key < n.key ? n.left : n.right;
    }
    return null;
  }
  async mapSet(root, key, value, depth = 0) {
    check(typeof key === 'string' && key.isWellFormed() && bytes(key) <= PAGE_LIMITS.keyBytes && reference(value),
      'RESOURCE_LIMIT', 'Map key/value limit');
    check(depth < PAGE_LIMITS.depth, 'RESOURCE_LIMIT', 'Map depth limit');
    if (root === null) return this.#node(key, value, null, null);
    const n = await this.#map(root);
    if (key === n.key) return equal(n.value, value) ? root : this.#node(key, value, n.left, n.right);
    return key < n.key ? this.#balance(n.key, n.value, await this.mapSet(n.left, key, value, depth + 1), n.right)
      : this.#balance(n.key, n.value, n.left, await this.mapSet(n.right, key, value, depth + 1));
  }
  async mapDelete(root, key, depth = 0) {
    check(depth < PAGE_LIMITS.depth, 'NEEDS_RESOLUTION', 'Map depth limit');
    if (root === null) return null;
    const n = await this.#map(root);
    if (key < n.key) return this.#balance(n.key, n.value, await this.mapDelete(n.left, key, depth + 1), n.right);
    if (key > n.key) return this.#balance(n.key, n.value, n.left, await this.mapDelete(n.right, key, depth + 1));
    if (n.left === null) return n.right;
    if (n.right === null) return n.left;
    let next = await this.#map(n.right), count = depth;
    while (next.left) { check(++count < PAGE_LIMITS.depth, 'NEEDS_RESOLUTION', 'Map depth limit'); next = await this.#map(next.left); }
    return this.#balance(next.key, next.value, n.left, await this.mapDelete(n.right, next.key, depth + 1));
  }
  async *mapEntries(root, after = null, depth = 0) {
    if (root === null) return;
    check(depth < PAGE_LIMITS.depth, 'NEEDS_RESOLUTION', 'Map depth limit');
    const n = await this.#map(root);
    if (after === null || n.key > after) {
      yield* this.mapEntries(n.left, after, depth + 1); yield [n.key, n.value];
    }
    yield* this.mapEntries(n.right, after, depth + 1);
  }
  // Counted AVL rope. Stable prefix/suffix references support local splice and
  // fixed forks without copying all later positions as an index-keyed map would.
  async #rope(ref) {
    if (ref === null) return { count: 0, height: 0 };
    const n = await this.get(ref);
    check(['leaf', 'rope'].includes(n.kind) && Number.isSafeInteger(n.count) && n.count > 0 &&
      Number.isSafeInteger(n.height) && n.height > 0 && n.height <= PAGE_LIMITS.depth,
    'NEEDS_RESOLUTION', 'Malformed sequence page');
    if (n.kind === 'leaf') check(equal(Object.keys(n).sort(), ['count', 'height', 'items', 'kind']) &&
      Array.isArray(n.items) && n.items.length === n.count && n.count <= PAGE_LIMITS.leaf &&
      n.height === 1 && n.items.every(reference), 'NEEDS_RESOLUTION', 'Malformed sequence leaf');
    else check(equal(Object.keys(n).sort(), ['count', 'height', 'kind', 'left', 'right']) &&
      reference(n.left) && reference(n.right), 'NEEDS_RESOLUTION', 'Malformed sequence directory');
    return n;
  }
  async #joinNode(left, right) {
    if (left === null) return right; if (right === null) return left;
    const l = await this.#rope(left), r = await this.#rope(right);
    check(Number.isSafeInteger(l.count + r.count), 'RESOURCE_LIMIT', 'Sequence count overflow');
    return this.put({ kind: 'rope', left, right, count: l.count + r.count, height: Math.max(l.height, r.height) + 1 });
  }
  async concat(left, right, depth = 0) {
    check(depth < PAGE_LIMITS.depth, 'NEEDS_RESOLUTION', 'Sequence depth limit');
    if (left === null) return right; if (right === null) return left;
    const l = await this.#rope(left), r = await this.#rope(right);
    if (l.height > r.height + 1) {
      const joined = await this.concat(l.right, right, depth + 1), j = await this.#rope(joined), ll = await this.#rope(l.left);
      if (j.height > ll.height + 1) {
        const jl = await this.#rope(j.left), jr = await this.#rope(j.right);
        if (jl.height > jr.height) return this.#joinNode(await this.#joinNode(l.left, jl.left), await this.#joinNode(jl.right, j.right));
        return this.#joinNode(await this.#joinNode(l.left, j.left), j.right);
      }
      return this.#joinNode(l.left, joined);
    }
    if (r.height > l.height + 1) {
      const joined = await this.concat(left, r.left, depth + 1), j = await this.#rope(joined), rr = await this.#rope(r.right);
      if (j.height > rr.height + 1) {
        const jl = await this.#rope(j.left), jr = await this.#rope(j.right);
        if (jr.height > jl.height) return this.#joinNode(await this.#joinNode(j.left, jr.left), await this.#joinNode(jr.right, r.right));
        return this.#joinNode(j.left, await this.#joinNode(j.right, r.right));
      }
      return this.#joinNode(joined, r.right);
    }
    return this.#joinNode(left, right);
  }
  async sequence(items) {
    if (items.length === 0) return null;
    check(items.every(reference), 'INVALID_SCHEMA', 'Sequence requires page references');
    if (items.length <= PAGE_LIMITS.leaf) return this.put({ kind: 'leaf', count: items.length, height: 1, items });
    const mid = Math.floor(items.length / 2); return this.concat(await this.sequence(items.slice(0, mid)), await this.sequence(items.slice(mid)));
  }
  async length(root) { return (await this.#rope(root)).count; }
  async split(root, position, depth = 0) {
    check(depth < PAGE_LIMITS.depth, 'NEEDS_RESOLUTION', 'Sequence depth limit');
    const n = await this.#rope(root);
    check(Number.isSafeInteger(position) && position >= 0 && position <= n.count, 'INVALID_SCHEMA', 'Sequence offset');
    if (position === 0) return [null, root]; if (position === n.count) return [root, null];
    if (n.kind === 'leaf') return [await this.sequence(n.items.slice(0, position)), await this.sequence(n.items.slice(position))];
    const size = await this.length(n.left);
    if (position < size) { const [a, b] = await this.split(n.left, position, depth + 1); return [a, await this.concat(b, n.right)]; }
    const [a, b] = await this.split(n.right, position - size, depth + 1); return [await this.concat(n.left, a), b];
  }
  async splice(root, start, count, inserted = null) {
    check(Number.isSafeInteger(count) && count >= 0 && start + count <= await this.length(root), 'INVALID_SCHEMA', 'Sequence deletion count');
    const [prefix, rest] = await this.split(root, start), [, suffix] = await this.split(rest, count);
    return this.concat(await this.concat(prefix, inserted), suffix);
  }
  async *range(root, start = 0, count = null, depth = 0) {
    check(depth < PAGE_LIMITS.depth, 'NEEDS_RESOLUTION', 'Sequence depth limit');
    const n = await this.#rope(root); count ??= n.count - start;
    check(Number.isSafeInteger(start) && Number.isSafeInteger(count) && start >= 0 && count >= 0 && start + count <= n.count,
      'INVALID_SCHEMA', 'Sequence range');
    if (count === 0) return;
    if (n.kind === 'leaf') { yield* n.items.slice(start, start + count); return; }
    const size = await this.length(n.left), leftCount = Math.max(0, Math.min(count, size - start));
    if (leftCount) yield* this.range(n.left, start, leftCount, depth + 1);
    if (count > leftCount) yield* this.range(n.right, Math.max(0, start - size), count - leftCount, depth + 1);
  }
  // Explicit full audit, separate from bounded ordinary lookups/updates.
  async audit(root, type, maxPages = 1000000) {
    let visited = 0;
    const walk = async (ref, min = null, max = null, depth = 0) => {
      if (ref === null) return { height: 0, count: 0 };
      check(++visited <= maxPages && depth < PAGE_LIMITS.depth, 'RESOURCE_LIMIT', 'Audit resource limit');
      const n = type === 'map' ? await this.#map(ref) : await this.#rope(ref);
      if (type === 'map') check((min === null || n.key > min) && (max === null || n.key < max), 'NEEDS_RESOLUTION', 'Map order');
      if (n.kind === 'leaf') return n;
      const l = await walk(n.left, min, type === 'map' ? n.key : null, depth + 1);
      const r = await walk(n.right, type === 'map' ? n.key : null, max, depth + 1);
      check(Math.abs(l.height - r.height) <= 1 && n.height === Math.max(l.height, r.height) + 1 &&
        (type === 'map' || n.count === l.count + r.count), 'NEEDS_RESOLUTION', 'Unbalanced/count-invalid tree');
      return { height: n.height, count: type === 'map' ? l.count + r.count + 1 : n.count };
    };
    check(['map', 'sequence'].includes(type), 'INVALID_SCHEMA', 'Unknown audit kind');
    return { ...await walk(root), visited };
  }
}
