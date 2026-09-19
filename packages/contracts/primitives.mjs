import { createHash, randomUUID } from 'node:crypto';

export const PREFIXES = Object.freeze({
  story: 'st', branch: 'br', message: 'msg', revision: 'rev', snapshot: 'hs',
  block: 'hm', operation: 'op', memory: 'mem', memoryRevision: 'mr',
  memoryView: 'mv', binding: 'hb', run: 'run', contextBlock: 'cb',
});
export class ContractError extends Error {
  constructor(code, detail, scope = null) {
    super(detail);
    this.name = 'ContractError';
    this.code = code;
    this.scope = scope;
  }
}
export function requireThat(condition, code, detail, scope = null) {
  if (!condition) throw new ContractError(code, detail, scope);
}
export function id(kind, value) {
  const prefix = PREFIXES[kind];
  requireThat(prefix && typeof value === 'string' &&
    new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(value),
  'INVALID_SCHEMA', `Invalid ${kind} ID`);
  return value;
}
export const newId = kind => id(kind, `${PREFIXES[kind]}_${randomUUID()}`);

// JSON data only: do not normalize text, invoke getters/toJSON, or silently drop values.
export function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    requireThat(value.isWellFormed(), 'INVALID_SCHEMA', 'Invalid Unicode');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    requireThat(Number.isFinite(value), 'INVALID_SCHEMA', 'Non-finite number');
    return JSON.stringify(value);
  }
  requireThat(typeof value === 'object' && !stack.has(value), 'INVALID_SCHEMA', 'Non-JSON or cyclic value');
  requireThat(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null, 'INVALID_SCHEMA', 'Non-JSON object');
  stack.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requireThat(keys.every(k => typeof k === 'string' &&
    (Array.isArray(value) && k === 'length' || descriptors[k].enumerable && 'value' in descriptors[k])),
  'INVALID_SCHEMA', 'Accessors/symbols/hidden fields are not JSON');
  let output;
  if (Array.isArray(value)) {
    requireThat(keys.length === value.length + 1 &&
      Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean),
    'INVALID_SCHEMA', 'Sparse or extended array');
    output = `[${value.map(v => canonicalize(v, stack)).join(',')}]`;
  } else {
    output = `{${Object.keys(value).sort().map(k =>
      `${canonicalize(k, stack)}:${canonicalize(value[k], stack)}`).join(',')}}`;
  }
  stack.delete(value);
  return output;
}
export const equal = (a, b) => canonicalize(a) === canonicalize(b);
export function fingerprint(purpose, payload) {
  requireThat(['content', 'derived-input', 'prepare-input', 'write-payload', 'logical-export'].includes(purpose),
    'INVALID_SCHEMA', 'Unknown fingerprint purpose');
  const bytes = canonicalize({ purpose, version: 1, payload });
  return `sha256:${purpose}:v1:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function put(table, key, value) {
  requireThat(!Object.hasOwn(table, key), 'ID_COLLISION', `ID already exists: ${key}`);
  table[key] = structuredClone(value);
}
