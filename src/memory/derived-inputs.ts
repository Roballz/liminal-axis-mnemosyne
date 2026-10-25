/** One owned snapshot of the inputs used by the displayed derived state.
 * Strings retain their value without serializing the chat. Mutable leaves and
 * templates are copied so in-place edits cannot masquerade as unchanged data. */
const unsupported = Symbol('unsupported-derived-input');

function keys(value: object): string[] {
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw unsupported;
  const result = Object.keys(value);
  for (const key of result) if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) throw unsupported;
  return result;
}

function snapshot(value: unknown, active = new Set<object>()): unknown {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw unsupported;
  if (!value || typeof value !== 'object') return value;
  if (active.has(value)) throw unsupported;
  const ownKeys = keys(value);
  active.add(value);
  const copy: unknown[] | Record<string, unknown> = Array.isArray(value) ? new Array(value.length) : {};
  for (const key of ownKeys) Object.defineProperty(copy, key, { value: snapshot((value as Record<string, unknown>)[key], active), enumerable: true, writable: true, configurable: true });
  active.delete(value);
  return copy;
}

function same(value: unknown, saved: unknown): boolean {
  if (Object.is(value, saved)) return true;
  if (!value || !saved || typeof value !== 'object' || typeof saved !== 'object') return false;
  if (Array.isArray(value) !== Array.isArray(saved) || (Array.isArray(value) && value.length !== (saved as unknown[]).length)) return false;
  const currentKeys = keys(value), savedKeys = Object.keys(saved);
  return currentKeys.length === savedKeys.length && currentKeys.every((key, index) => key === savedKeys[index] &&
    same((value as Record<string, unknown>)[key], (saved as Record<string, unknown>)[key]));
}

export class DerivedInputs {
  private saved: unknown;
  private ready = false;
  matches(value: unknown): boolean {
    try { return this.ready && same(value, this.saved); }
    catch (error) { if (error !== unsupported) throw error; return false; }
  }
  remember(value: unknown): void {
    this.ready = false;
    this.saved = undefined;
    try { this.saved = snapshot(value); this.ready = true; }
    catch (error) { if (error !== unsupported) throw error; }
  }
}
