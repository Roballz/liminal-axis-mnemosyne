/** Reuse the exact JSON version only after checking every selected live value.
 * Immutable strings are retained, not copied into a new multi-megabyte JSON on
 * each getter. Host events, object identity and string length are not evidence. */
const unsupported = Symbol('non-json-source');
function plain(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return (Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null) &&
        !('toJSON' in value) &&
        Object.keys(value).every(key => {
            const property = Object.getOwnPropertyDescriptor(value, key);
            return property && 'value' in property;
        });
}
function snapshot(value: unknown, active = new Set<object>()): unknown {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw unsupported;
    if (!value || typeof value !== 'object') return value;
    if (!plain(value) || active.has(value)) throw unsupported;
    active.add(value);
    const result = Array.isArray(value)
        ? value.map(item => snapshot(item, active))
        : Object.fromEntries(Object.keys(value).map(key => [key, snapshot((value as Record<string, unknown>)[key], active)]));
    active.delete(value);
    return result;
}
function same(value: unknown, saved: unknown): boolean {
    if (Object.is(value, saved)) return true;
    if (!value || !saved || typeof value !== 'object' || typeof saved !== 'object' || !plain(value)) return false;
    if (Array.isArray(value) || Array.isArray(saved)) {
        if (!Array.isArray(value) || !Array.isArray(saved) || value.length !== saved.length) return false;
        for (let index = 0; index < value.length; index++) {
            if (Object.hasOwn(value, index) !== Object.hasOwn(saved, index) || !same(value[index], saved[index])) return false;
        }
        return true;
    }
    const keys = Object.keys(value), oldKeys = Object.keys(saved);
    return keys.length === oldKeys.length && keys.every((key, index) => key === oldKeys[index] &&
        same((value as Record<string, unknown>)[key], (saved as Record<string, unknown>)[key]));
}
export class HostVersionMemo {
    private saved: unknown;
    private encoded: string | undefined;
    read(value: unknown): string {
        if (this.encoded !== undefined && same(value, this.saved)) return this.encoded;
        try {
            const saved = snapshot(value);
            this.encoded = JSON.stringify(saved);
            this.saved = saved;
            return this.encoded;
        }
        catch (error) {
            if (error !== unsupported) throw error;
            // Unknown host metadata retains the original JSON/toJSON behavior.
            this.saved = undefined; this.encoded = undefined;
            return JSON.stringify(value);
        }
    }
    clear() { this.saved = undefined; this.encoded = undefined; }
}
