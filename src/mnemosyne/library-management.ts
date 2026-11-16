import { activeLibrary } from './db';
import { DB_PREFIX, disabledLibraries, selectedLibraryName, updateLibraryDisabled } from './library-policy';
import { check } from './model';
export interface CoreLibraryEntry { name: string; current: boolean; disabled: boolean }
export interface CoreLibraryInventory { current: string; shared: boolean; enumerable: boolean; entries: CoreLibraryEntry[] }
/** Only database names and the current connection's format flag; never read archive rows. */
export async function inspectCoreLibraries(): Promise<CoreLibraryInventory> {
    const lib = await activeLibrary(), current = lib.db.name;
    const enumerable = typeof indexedDB.databases === 'function';
    const names = enumerable ? (await indexedDB.databases()).map(info => info.name) : [];
    check(current === selectedLibraryName() && await activeLibrary() === lib, '当前核心库已改变，请刷新列表');
    const disabled = disabledLibraries();
    return { current, shared: lib.compactWrites, enumerable,
        entries: [...new Set([current, ...names.filter((name): name is string => !!name && name.startsWith(DB_PREFIX))])]
            .sort((a,b) => a === current ? -1 : b === current ? 1 : a.localeCompare(b))
            .map(name => ({ name, current: name === current, disabled: disabled.has(name) })) };
}
export async function setCoreLibraryDisabled(name: string, disabled: boolean, expectedActive: string) {
    const lib = await activeLibrary();
    check(lib.db.name === expectedActive, '当前核心库已改变，请刷新列表');
    updateLibraryDisabled(name, disabled, expectedActive);
}
