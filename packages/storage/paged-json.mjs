// Structural JSON references: nested command.entries, views/corrections, expected,
// marker maps and directories use the SAME bounded maps/sequences, not giant pages.
// write/read are explicit full conversion/audit operations; set/splice are local.
import { Pages, PAGE_LIMITS } from './pages.mjs';
import { canonicalize, equal, requireThat } from '../contracts/primitives.mjs';
const check = requireThat;
export class PagedJSON {
  constructor(pages) { check(pages instanceof Pages, 'INVALID_SCHEMA', 'Page store required'); this.pages = pages; }
  async write(value, depth = 0) {
    check(depth < PAGE_LIMITS.depth, 'RESOURCE_LIMIT', 'JSON nesting limit');
    const p = this.pages;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      const text = canonicalize(value);
      if (new TextEncoder().encode(text).length < 2048) return p.put({ kind: 'json-scalar', value });
      check(typeof value === 'string', 'RESOURCE_LIMIT', 'Oversize scalar');
      let chunks = null;
      for (let offset = 0; offset < value.length;) {
        let end = Math.min(value.length, offset + 512);
        if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
        const part = await p.put({ kind: 'json-scalar', value: value.slice(offset, end) });
        chunks = await p.concat(chunks, await p.sequence([part])); offset = end;
      }
      return p.put({ kind: 'json-string', root: chunks });
    }
    check(value && typeof value === 'object' && (Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), 'INVALID_SCHEMA', 'JSON object required');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    check(keys.every(k => typeof k === 'string' && (Array.isArray(value) && k === 'length' ||
      descriptors[k].enumerable && 'value' in descriptors[k])), 'INVALID_SCHEMA', 'Not plain JSON');
    let root = null;
    if (Array.isArray(value)) {
      check(keys.length === value.length + 1, 'INVALID_SCHEMA', 'Sparse/extended array');
      for (let offset = 0; offset < value.length; offset += PAGE_LIMITS.leaf) {
        const items = [];
        for (let i = offset; i < Math.min(offset + PAGE_LIMITS.leaf, value.length); i++) {
          check(Object.hasOwn(value, i), 'INVALID_SCHEMA', 'Sparse array'); items.push(await this.write(value[i], depth + 1));
        }
        root = await p.concat(root, await p.sequence(items));
      }
      return p.put({ kind: 'json-array', root });
    }
    for (const key of Object.keys(value).sort()) root = await p.mapSet(root, key, await this.write(value[key], depth + 1));
    return p.put({ kind: 'json-object', root });
  }
  async at(ref, path) {
    check(Array.isArray(path) && path.length < PAGE_LIMITS.depth, 'RESOURCE_LIMIT', 'JSON path limit');
    for (const key of path) {
      const n = await this.pages.get(ref);
      if (n.kind === 'json-object') { check(typeof key === 'string', 'INVALID_SCHEMA', 'Object key must be string'); ref = await this.pages.mapGet(n.root, key); }
      else if (n.kind === 'json-array') { const values = this.pages.range(n.root, key, 1); ref = (await values.next()).value; }
      else check(false, 'INVALID_SCHEMA', 'Path enters a scalar');
      check(ref !== null, 'NEEDS_RESOLUTION', 'JSON path missing');
    }
    return ref;
  }
  async set(ref, path, replacement, depth = 0) {
    check(Array.isArray(path) && path.length + depth < PAGE_LIMITS.depth, 'RESOURCE_LIMIT', 'JSON path limit');
    if (path.length === 0) return replacement;
    const [key, ...tail] = path, n = await this.pages.get(ref);
    check(['json-object', 'json-array'].includes(n.kind), 'INVALID_SCHEMA', 'Path enters a scalar');
    let next = replacement;
    if (tail.length) next = await this.set(await this.at(ref, [key]), tail, replacement, depth + 1);
    const root = n.kind === 'json-object' ? await this.pages.mapSet(n.root, key, next)
      : await this.pages.splice(n.root, key, 1, await this.pages.sequence([next]));
    return this.pages.put({ kind: n.kind, root });
  }
  async splice(ref, path, start, count, inserted) {
    const target = await this.at(ref, path), n = await this.pages.get(target), values = await this.pages.get(inserted);
    check(n.kind === 'json-array' && values.kind === 'json-array', 'INVALID_SCHEMA', 'Array splice required');
    const root = await this.pages.splice(n.root, start, count, values.root);
    return this.set(ref, path, await this.pages.put({ kind: 'json-array', root }));
  }
  async read(ref, { maxBytes = 8 * 1024 * 1024, maxValues = 200000 } = {}) {
    let bytes = 0, values = 0;
    const charge = value => { bytes += new TextEncoder().encode(canonicalize(value)).length;
      check(bytes <= maxBytes, 'RESOURCE_LIMIT', 'Materialization byte limit'); };
    const visit = async (ref, depth = 0) => {
      check(depth < PAGE_LIMITS.depth && ++values <= maxValues, 'RESOURCE_LIMIT', 'Materialization depth/value limit');
      const n = await this.pages.get(ref);
      bytes += 2; check(bytes <= maxBytes, 'RESOURCE_LIMIT', 'Materialization byte limit');
      check(equal(Object.keys(n).sort(), n.kind === 'json-scalar' ? ['kind', 'value'] : ['kind', 'root']),
        'NEEDS_RESOLUTION', 'Malformed JSON wrapper');
      if (n.kind === 'json-scalar') { check(n.value === null || ['string', 'number', 'boolean'].includes(typeof n.value),
        'NEEDS_RESOLUTION', 'Invalid scalar'); charge(n.value); return n.value; }
      if (n.kind === 'json-string' || n.kind === 'json-array') {
        const result = []; await this.pages.audit(n.root, 'sequence', maxValues);
        for await (const item of this.pages.range(n.root)) {
          const value = await visit(item, depth + 1);
          if (n.kind === 'json-string') check(typeof value === 'string', 'NEEDS_RESOLUTION', 'Invalid string fragment');
          result.push(value);
        }
        return n.kind === 'json-string' ? result.join('') : result;
      }
      check(n.kind === 'json-object', 'NEEDS_RESOLUTION', 'Unknown JSON page');
      await this.pages.audit(n.root, 'map', maxValues); const result = {};
      for await (const [key, child] of this.pages.mapEntries(n.root)) {
        charge(key); Object.defineProperty(result, key, { value: await visit(child, depth + 1), enumerable: true });
      }
      return result;
    };
    return visit(ref);
  }
}
