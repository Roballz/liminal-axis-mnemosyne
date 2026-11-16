import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
let selectors: Map<string,string>;
beforeEach(()=>{
    vi.resetModules(); selectors = new Map();
    vi.stubGlobal('localStorage',{getItem:(key:string)=>selectors.get(key)??null,
        setItem:(key:string,value:string)=>{selectors.set(key,value);}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

test('after migration, normal fork uses only the new shared library; disabled old library cannot reactivate or write',async()=>{
    const db=await import('./db'), {fixture}=await import('./fixtures');
    const {capture,forkBranch}=await import('./canonical');
    const {reorganizeCoreLibrary}=await import('./core-reorganization');
    const management=await import('./library-management');
    const f=await fixture(2), oldName=f.lib.db.name;
    await db.activateLibrary(f.lib);
    const report=await reorganizeCoreLibrary(f.lib,async()=>true);
    const target=await db.Library.open(report.library,true);
    await db.activateLibrary(target);
    const old=await db.Library.open(oldName,true);
    try {
        const before=await old.all('branches'), beforeStamp=await db.libraryWriteStamp(old);
        const inventory=await management.inspectCoreLibraries();
        expect(inventory.current).toBe(target.db.name);expect(inventory.shared).toBe(true);
        expect(inventory.entries.find(e=>e.name===oldName)).toMatchObject({current:false,disabled:false});
        const lib=await db.activeLibrary();
        const child=await forkBranch(lib,await capture(lib,f.branch.id),'new-store-fork');
        expect(await target.get('branches',child.id)).toBeDefined();
        expect(await old.all('branches')).toEqual(before);
        expect(await db.libraryWriteStamp(old)).toBe(beforeStamp);
        const read=vi.spyOn(db.Transaction.prototype,'rawAll');
        const open=vi.spyOn(db.Library,'open');
        await management.inspectCoreLibraries();
        expect(read).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
        await management.setCoreLibraryDisabled(oldName,true,target.db.name);
        await expect(db.activateLibrary(old)).rejects.toThrow('已禁用');
        await expect(old.transaction(['library_meta'],'readwrite',tx=>tx.put('library_meta',{id:'bad-write',schema:1}))).rejects.toThrow('已禁用');
        expect(await db.activeLibrary()).toBe(target);
        await management.setCoreLibraryDisabled(oldName,false,target.db.name);
        expect(await db.activeLibrary()).toBe(target); // Enabling never switches databases.
        expect(await old.all('branches')).toEqual(before);
        target.close(); vi.resetModules();
        const restarted=await import('./db'), reopened=await restarted.activeLibrary();
        try {
            expect(reopened.db.name).toBe(report.library); expect(reopened.compactWrites).toBe(true);
            expect(await reopened.get('branches',child.id)).toBeDefined();
        } finally {reopened.close();}
    } finally {old.close();target.close();f.lib.close();}
});

test('disabling the active library or applying a stale inventory is rejected without changing policy',async()=>{
    const db=await import('./db'), management=await import('./library-management');
    const lib=await db.Library.open(db.freshLibraryName());await db.activateLibrary(lib);
    try {
        const before=new Map(selectors);
        await expect(management.setCoreLibraryDisabled(lib.db.name,true,lib.db.name)).rejects.toThrow('不能禁用当前');
        await expect(management.setCoreLibraryDisabled(db.freshLibraryName(),true,'stale-current')).rejects.toThrow('已改变');
        expect(selectors).toEqual(before);
    } finally {lib.close();}
});

test('external selector changes reject cached active handles and direct old writes; no silent fallback',async()=>{
    const db=await import('./db');
    const lib=await db.Library.open(db.freshLibraryName());await db.activateLibrary(lib);
    try {
        const pending=db.activeLibrary();expect(db.activeLibrary()).toBe(pending);
        selectors.set(db.ACTIVE_KEY,db.freshLibraryName());
        expect(()=>db.activeLibrary()).toThrow('其他页面切换');
        await expect(lib.transaction(['library_meta'],'readwrite',tx=>tx.put('library_meta',{id:'stale',schema:1}))).rejects.toThrow('停止向旧库');
        expect(await lib.get('library_meta','stale')).toBeUndefined();
    } finally {lib.close();}
});

test('disabled policy survives module restart and refuses default fallback if selector is missing',async()=>{
    const db=await import('./db'), management=await import('./library-management');
    const lib=await db.Library.open(db.freshLibraryName());await db.activateLibrary(lib);
    const oldName=db.DB_PREFIX+'default';
    await management.setCoreLibraryDisabled(oldName,true,lib.db.name);
    selectors.delete(db.ACTIVE_KEY);lib.close();vi.resetModules();
    const restarted=await import('./db'), open=vi.spyOn(restarted.Library,'open');
    expect(()=>restarted.activeLibrary()).toThrow('已禁用');expect(open).not.toHaveBeenCalled();
});

test('enumeration unsupported and persistence errors do not scan or falsely disable archives',async()=>{
    const db=await import('./db'), management=await import('./library-management');
    const lib=await db.Library.open(db.freshLibraryName());await db.activateLibrary(lib);
    try {
        vi.spyOn(indexedDB,'databases').mockImplementation(undefined as any);
        // Some hosts omit this API entirely.
        Object.defineProperty(indexedDB,'databases',{configurable:true,value:undefined});
        const result=await management.inspectCoreLibraries();expect(result.enumerable).toBe(false);
        expect(result.entries).toEqual([{name:lib.db.name,current:true,disabled:false}]);
        vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new Error('storage unavailable');});
        await expect(management.setCoreLibraryDisabled(db.DB_PREFIX+'old',true,lib.db.name)).rejects.toThrow('storage unavailable');
        expect((await import('./library-policy')).disabledLibraries().size).toBe(0);
    } finally {lib.close();}
});

 test('a library disabled while activation is awaiting its barrier cannot be published',async()=>{
    const db=await import('./db'), management=await import('./library-management');
    const current=await db.Library.open(db.freshLibraryName()), target=await db.Library.open(db.freshLibraryName());
    await db.activateLibrary(current);
    try {
        await expect(db.activateLibrary(target,()=>true,async publish=>{
            await management.setCoreLibraryDisabled(target.db.name,true,current.db.name); publish();
        })).rejects.toThrow('已禁用');
        expect(await db.activeLibrary()).toBe(current); expect(selectors.get(db.ACTIVE_KEY)).toBe(current.db.name);
    } finally {current.close();target.close();}
});
