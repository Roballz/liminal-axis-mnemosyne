import { check } from './model';
export const DB_PREFIX = 'mnemosyne_daily_';
export const ACTIVE_KEY = 'mnemosyne_daily_active_v1';
export const DISABLED_LIBRARIES_KEY = 'mnemosyne_daily_disabled_libraries_v1';
let cachedRaw: string | null | undefined;
let cachedDisabled = new Set<string>();
/** Browser-local access policy, not archive data. Workers only receive explicit job targets. */
export function disabledLibraries(): ReadonlySet<string> {
    if (typeof localStorage === 'undefined') return new Set();
    const raw = localStorage.getItem(DISABLED_LIBRARIES_KEY) ?? null;
    if (raw !== cachedRaw) {
        const names: unknown = raw === null ? [] : JSON.parse(raw);
        check(Array.isArray(names) && names.every(name => typeof name === 'string' && name.startsWith(DB_PREFIX)),
            '旧库禁用设置损坏，请检查本机设置');
        cachedDisabled = new Set(names); cachedRaw = raw;
    }
    return cachedDisabled;
}
export function assertLibraryEnabled(name: string) {
    check(!disabledLibraries().has(name), '这个核心库已禁用，请在核心库管理中解除禁用；不会自动使用旧库');
}
export function selectedLibraryName() { return localStorage.getItem(ACTIVE_KEY) || `${DB_PREFIX}default`; }
export function updateLibraryDisabled(name: string, disabled: boolean, expectedActive: string) {
    check(name.startsWith(DB_PREFIX), '不是 Mnemosyne 核心库');
    check(selectedLibraryName() === expectedActive, '当前核心库已改变，请刷新列表');
    check(name !== expectedActive, '不能禁用当前使用的核心库');
    const names = new Set(disabledLibraries());
    if (disabled) names.add(name); else names.delete(name);
    localStorage.setItem(DISABLED_LIBRARIES_KEY, JSON.stringify([...names].sort()));
    check(disabledLibraries().has(name) === disabled, '旧库禁用设置未保存，请重试');
}
