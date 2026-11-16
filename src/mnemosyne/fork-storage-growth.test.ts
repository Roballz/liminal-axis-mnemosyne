import 'fake-indexeddb/auto';
import { test, expect } from 'vitest';
import { fixture } from './fixtures';
import { capture, synchronize, forkBranch } from './canonical';
import { applyRows, newTable, saveTable } from './tables';
import { exportLibrary, restoreLibrary } from './migration';
import { Library } from './db';
import { reorganizeCoreLibrary } from './core-reorganization';
import { previewArchiveDeletion, commitArchiveDeletion, archiveDeletionResult, sameArchiveData } from './archive-deletion';
import { row, STORES, type Memory, type TableDef, type TableCommit, type TableRow, type MemoryRevision } from './model';

test('a first fork collapses legacy duplicate table evidence, preserves distinct evidence, and stays bounded on the next fork', async () => {
    const f = await fixture(1);
    try {
        f.input.memories.push({...f.input.memories[0],hostId:'higher',level:1,anchorKey:null,children:['leaf-0']});
        await synchronize(f.lib,f.input);
        const initial = await capture(f.lib,f.branch.id);
        const leaf = initial.memories.find(m=>m.level===0)!;
        const original = initial.memories.find(m=>m.level===1)!;
        const leafFamily = (await f.lib.get<Memory>('memories',leaf.owner))!;
        const def = newTable(initial, 'historical evidence');
        def.columns = [{id:'key',name:'Key',type:'text',description:'',mode:'replace'}];
        await saveTable(f.lib, initial, def);
        await applyRows(f.lib, await capture(f.lib, f.branch.id), (await f.lib.get<TableDef>('custom_table_defs',def.id))!,
            [{row_id:null,values:{key:'old evidence'}}], true, [original.id]);
        const family = (await f.lib.get<Memory>('memories', original.owner))!;
        const sources: string[] = [];
        await f.lib.transaction(STORES, 'readwrite', async tx => {
            // Old faulty forks could leave equivalent evidence under many different identities.
            for (let i = 0; i < 128; i++) {
                const childFamily = {...leafFamily,...row('mem')};
                const childRevision = {...leaf,...row('mr'),owner:childFamily.id};
                await tx.add('memories',childFamily); await tx.add('memory_revisions',childRevision);
                const duplicate = {...family,...row('mem')};
                const revision = {...original,...row('mr'),owner:duplicate.id,dependencies:[childRevision.id]};
                await tx.add('memories',duplicate); await tx.add('memory_revisions',revision); sources.push(revision.id);
            }
            const distinct = {...family,...row('mem')};
            const revision = {...original,...row('mr'),owner:distinct.id,declaration:'different generation evidence'};
            await tx.add('memories',distinct); await tx.add('memory_revisions',revision); sources.push(revision.id);
            for (const commit of await tx.all<TableCommit>('table_history','branch',f.branch.id)) {
                if (commit.rows.length) await tx.put('table_history',{...commit,rows:commit.rows.map(r=>({...r,sources}))} as TableCommit);
            }
            for (const record of await tx.all<TableRow>('custom_table_rows','branch',f.branch.id))
                await tx.put('custom_table_rows',{...record,sources} as TableRow);
        });
        const before = await exportLibrary(f.lib);
        const parent = await capture(f.lib,f.branch.id);
        const child = await forkBranch(f.lib,parent,'first-duplicate-fork');
        const childView = await capture(f.lib,child.id);
        const copied = await f.lib.all<MemoryRevision>('memory_revisions','branch',child.id);
        expect(copied).toHaveLength(3); // Two selected revisions plus truly distinct historical evidence.
        expect(childView.memories).toHaveLength(2);
        const selectedHigher = childView.memories.find(m=>m.level===1)!;
        const table = (await f.lib.all<TableRow>('custom_table_rows','branch',child.id))[0];
        expect(table.sources.slice(0,128)).toEqual(Array(128).fill(selectedHigher.id));
        expect(table.sources[128]).not.toBe(selectedHigher.id);
        expect(copied.find(r=>r.id===table.sources[128])!.declaration).toBe('different generation evidence');
        const after = await exportLibrary(f.lib);
        expect(after.counts.memories - before.counts.memories).toBe(3);
        expect(after.counts.source_messages).toBe(before.counts.source_messages);
        expect(await capture(f.lib,f.branch.id)).toEqual(parent);
        for (const store of ['memories','memory_revisions','table_history'] as const) {
            const ids = new Set(before.data[store].map(r=>r.id));
            expect(after.data[store].filter(r=>ids.has(r.id))).toEqual(before.data[store]);
        }
        const restored = await restoreLibrary(after,false);
        try {
            const grandchild = await forkBranch(restored,await capture(restored,child.id),'bounded-grandchild');
            expect(await restored.all('memory_revisions','branch',grandchild.id)).toHaveLength(3);
            await exportLibrary(restored);
        } finally { restored.close(); }
    } finally { f.lib.close(); }
});

test('explicit archive deletion reclaims child-only payloads and orphan nodes but retains all parent and sibling history', async () => {
    const f = await fixture(12); let lib = f.lib;
    try {
        f.input.memories.push({...f.input.memories[0],hostId:'higher',level:1,anchorKey:null,
            children:f.input.memories.map(m=>m.hostId),content:'higher summary'});
        await synchronize(lib,f.input);
        const compact = await reorganizeCoreLibrary(lib,async()=>true); lib = await Library.open(compact.library,true);
        const parent = await capture(lib,f.branch.id);
        // An unselected historical row remains a root; an already removed row does not.
        const historic = {...parent.memories[0],...row('mr'),content:'retained history '.repeat(100)};
        const orphan = {...parent.memories[0],...row('mr'),content:'discarded history '.repeat(100)};
        await lib.transaction(STORES,'readwrite',async tx=>{
            await tx.add('memory_revisions',historic); await tx.add('memory_revisions',orphan);
            await tx.delete('memory_revisions',orphan.id);
        });
        const historicRaw = await lib.transaction(['memory_revisions'],'readonly',tx=>tx.rawGet<any>('memory_revisions',historic.id));
        const historicalKey = historicRaw.content.shared;
        const orphanKey = (await lib.all<any>('memory_payloads')).find(p=>p.kind==='text' && p.value===orphan.content)!.id;
        const child = await forkBranch(lib,parent,'payload-child');
        const sibling = await forkBranch(lib,parent,'payload-sibling');
        const siblingBefore = await capture(lib,sibling.id);
        const physical = await lib.transaction(['memory_revisions'],'readonly',tx=>tx.rawAll<any>('memory_revisions','branch',child.id));
        const key = physical.find(m=>m.level===1).dependencies.shared;
        expect(key).toBeTruthy();
        const prior = await exportLibrary(lib);
        const plan = await previewArchiveDeletion(lib,child.id);
        expect(plan.remove.memory_payloads).toContain(key);
        expect(plan.remove.memory_payloads).toContain(orphanKey);
        expect(plan.remove.memory_payloads).not.toContain(historicalKey);
        expect(plan.remove.memory_selection_nodes.length).toBeGreaterThan(0);
        await commitArchiveDeletion(lib,plan,()=>true);
        expect(await lib.get('memory_payloads',key)).toBeUndefined();
        expect(await lib.get('memory_payloads',orphanKey)).toBeUndefined();
        expect(await lib.get('memory_revisions',historic.id)).toEqual(historic);
        expect(await capture(lib,parent.branch.id)).toEqual(parent);
        expect(await capture(lib,sibling.id)).toEqual(siblingBefore);
        const pack = await exportLibrary(lib);
        expect(sameArchiveData(pack.data,archiveDeletionResult(plan))).toBe(true);
        for (const store of ['memory_payloads','memory_selection_nodes','memory_revisions','memory_views'] as const) {
            const removed = new Set(plan.remove[store]);
            expect(pack.data[store]).toEqual(prior.data[store].filter(r=>!removed.has(r.id)));
        }
        const restored = await restoreLibrary(pack,false);
        try {
            const next = await forkBranch(restored,await capture(restored,sibling.id),'retained-history-fork');
            expect((await capture(restored,next.id)).memories).toHaveLength(13);
            await exportLibrary(restored);
        } finally { restored.close(); }
        await commitArchiveDeletion(lib,await previewArchiveDeletion(lib,sibling.id),()=>true);
        await commitArchiveDeletion(lib,await previewArchiveDeletion(lib,parent.branch.id),()=>true);
        expect(await lib.all('memory_payloads')).toEqual([]);
        expect(await lib.all('memory_selection_nodes')).toEqual([]);
    } finally { lib.close(); f.lib.close(); }
});
