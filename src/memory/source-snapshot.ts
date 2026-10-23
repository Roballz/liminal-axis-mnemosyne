/** Immutable evidence for JSON-shaped source metadata. Strings are retained by
 * value/reference, without serializing or duplicating whole historical bodies. */
export function sourceSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sourceSnapshot);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sourceSnapshot(item)]));
  }
  return value;
}
export function sameSourceSnapshot(value: unknown, snapshot: unknown): boolean {
  if (value === snapshot) return true;
  if (!value || !snapshot || typeof value !== 'object' || typeof snapshot !== 'object') return false;
  if (Array.isArray(value) || Array.isArray(snapshot)) {
    return Array.isArray(value) && Array.isArray(snapshot) && value.length === snapshot.length &&
      value.every((item, i) => sameSourceSnapshot(item, snapshot[i]));
  }
  const keys = Object.keys(value), saved = snapshot as Record<string, unknown>;
  return keys.length === Object.keys(saved).length && keys.every(key =>
    Object.hasOwn(saved, key) && sameSourceSnapshot((value as Record<string, unknown>)[key], saved[key]));
}
