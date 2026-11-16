import { test, expect, vi } from 'vitest';
import { fixture } from './fixtures';
import { capture, synchronize, statuses, keepSummary, forkBranch, confirmRecoveredSummaries } from './canonical';
import { editEvent, eventView } from './events';
import { applyRows, newTable, saveTable } from './tables';
import { row, STORES, type Branch, type Memory, type MemoryRevision, type TableDef } from './model';
import { publishMemoryView } from './memory-selections';
import { exportLibrary } from './migration';
import { Library, Transaction } from './db';
import { reorganizeCoreLibrary } from './core-reorganization';

async function inheritedFixture(compact: boolean) {
 const f=await fixture(1); let lib=f.lib;
  f.input.memories.push({...f.input.memories[0], hostId:'higher',level:1,anchorKey:null,children:['leaf-0']},
      {...f.input.memories[0], hostId:'highest',level:2,anchorKey:null,children:['higher']});
  await synchronize(lib,f.input);
  const original=await capture(lib,f.branch.id), leaf=original.memories.find(m=>m.hostId==='leaf-0')!;
  const family=(await lib.get<Memory>('memories',leaf.owner))!;
  const duplicate={...family,...row('mem')};
  const historical={...leaf,...row('mr'),owner:duplicate.id};
  await lib.transaction(STORES,'readwrite', async tx=>{await tx.add('memories',duplicate); await tx.add('memory_revisions',historical);});
  f.input.messages[0].content+=' edited';
  f.input.messages.push({key:'future-user',role:'user',content:'future question',swipe:0},{key:'future-ai',role:'assistant',content:'future answer',swipe:0});
  await lib.transaction(STORES,'readwrite',async tx=>{await tx.delete('memories',duplicate.id);});
  await synchronize(lib,f.input);
  await lib.transaction(STORES,'readwrite',async tx=>{await tx.add('memories',duplicate);});
  await keepSummary(lib,await capture(lib,f.branch.id),leaf.id);
  let view=await capture(lib,f.branch.id); expect([...await statuses(lib,view)].every(([,s])=>s==='valid')).toBe(true);
  await editEvent(lib,view,null,{title:'prior event',status:'open',keywords:[],overview:'summary',summarized:[leaf.id]}, {memory:leaf.id,active:true,kind:'progress'});
  const table=newTable(view,'history');
  table.columns=[{id:'key',name:'Key',type:'text',description:'',mode:'replace'}];
  await saveTable(lib,await capture(lib,f.branch.id),table);
  const current=await capture(lib,f.branch.id);
  await lib.transaction(STORES,'readwrite',async tx=>{
   const selection={...row('mv'),branch:f.branch.id,selections:{[duplicate.id]:historical.id}};
   await publishMemoryView(tx,selection);
   await tx.put('branches',{...current.branch,view:selection.id,epoch:current.branch.epoch+1} as Branch);
  });
  await keepSummary(lib,await capture(lib,f.branch.id),historical.id);
  await applyRows(lib,await capture(lib,f.branch.id),(await lib.get<TableDef>('custom_table_defs',table.id))!,[{row_id:null,values:{key:'history'}}],false,[historical.id]);
  await lib.transaction(STORES,'readwrite',async tx=>{
   const branch=(await tx.get<any>('branches',f.branch.id))!;
   await tx.put('branches',{...branch,view:current.selection.id,epoch:branch.epoch+1});
  });
  f.input.messages.push({key:'later-user',role:'user',content:'later question',swipe:0},{key:'later-ai',role:'assistant',content:'later answer',swipe:0});
  await lib.transaction(STORES,'readwrite',tx=>tx.delete('memories',duplicate.id));
  await synchronize(lib,f.input);
  await lib.transaction(STORES,'readwrite',tx=>tx.add('memories',duplicate));
  expect([...await statuses(lib,await capture(lib,f.branch.id))].every(([,s])=>s==='valid')).toBe(true);
  await exportLibrary(lib);
  if(compact){const report=await reorganizeCoreLibrary(lib,async()=>true);lib=await Library.open(report.library,true);}
  // Make physical key order deterministic. Table evidence is copied after selected memories.
  let seq=0; const uuid=vi.spyOn(crypto,'randomUUID').mockImplementation(()=>`ffffffff-ffff-4fff-8fff-${String(++seq).padStart(12,'0')}`);
  const child=await forkBranch(lib,await capture(lib,f.branch.id,4),'duplicate-child'); uuid.mockRestore();
  const inherited=await capture(lib,child.id);
  const good = inherited.memories.find(m=>m.hostId==='leaf-0')!;
  const stale = (await lib.all<MemoryRevision>('memory_revisions','branch',child.id)).find(m=>m.hostId===good.hostId && m.owner!==good.owner)!;
  const input={...f.input,scope:'duplicate-child',messages:f.input.messages.slice(0,4)};
  return {lib, original:f.lib, child, good, stale, inherited, input, parent:await capture(lib,f.branch.id)};
}
async function misselect(f: Awaited<ReturnType<typeof inheritedFixture>>) {
 await f.lib.transaction(STORES,'readwrite',async tx=>{
  const selections={...f.inherited.selection.selections}; delete selections[f.good.owner]; selections[f.stale.owner]=f.stale.id;
  const selection={...row('mv'),branch:f.child.id,selections};
  await publishMemoryView(tx,selection,f.inherited.selection);
  await tx.put('branches',{...f.child,view:selection.id,epoch:f.child.epoch+1} as Branch);
 });
}
for (const compact of [false,true]) for (const mode of ['new','broken','confirmed'] as const)
 test(`fork keeps and recovers inherited identity (${mode}, compact=${compact})`, async()=>{
 const f=await inheritedFixture(compact);
 try {
  const tableHistory=await f.lib.all('table_history','branch',f.child.id);
  if(mode!=='new') await misselect(f);
  if(mode==='confirmed') {
   const broken=await capture(f.lib,f.child.id);
   await confirmRecoveredSummaries(f.lib,broken,[f.stale.id]);
  }
  await synchronize(f.lib,f.input);
  const view=await capture(f.lib,f.child.id);
  expect(view.memories.find(m=>m.hostId==='leaf-0')!.id).toBe(f.good.id);
  expect([...await statuses(f.lib,view)].every(([,state])=>state==='valid')).toBe(true);
  expect((await eventView(f.lib,view)).cards[0]).toMatchObject({needsReview:false,blocked:false});
  expect(await capture(f.lib,f.parent.branch.id)).toEqual(f.parent);
  expect(await f.lib.all('table_history','branch',f.child.id)).toEqual(tableHistory);
  await exportLibrary(f.lib);
  // Warm the checked selection once; subsequent ordinary syncs do not rescan events/history.
  f.input.messages.push({key:'warm-retention',role:'user',content:'warm retention',swipe:0});
  await synchronize(f.lib,f.input);
  const reads=vi.spyOn(Transaction.prototype,'rawAll');
  for(let i=0;i<4;i++) {
   f.input.messages.push({key:`append-${i}`,role:'user',content:`append ${i}`,swipe:0});
   await synchronize(f.lib,f.input);
  }
  expect(reads.mock.calls.filter(([store,index])=>store==='event_revisions' && index==='branch')).toHaveLength(0);
  // Ordinary body retirement may initialize its story-level evidence cache once.
  for(const store of ['event_revisions','memory_revisions'])
   expect(reads.mock.calls.filter(([name])=>name===store).length).toBeLessThanOrEqual(1);
 } finally {f.lib.close();f.original.close();vi.restoreAllMocks();}
 });

test.each(['edited','changed-source','ambiguous'] as const)('identity repair does not override %s',async mode=>{
 const f=await inheritedFixture(true);
 try {
  await misselect(f);
  if(mode==='edited') { f.input.memories[0].content+=' new manual edit'; (f.input.memories[0] as import('./canonical').HostMemory).manualEdit=true; }
  if(mode==='changed-source') f.input.messages[0].content+=' new source';
  if(mode==='ambiguous') {
   await confirmRecoveredSummaries(f.lib,await capture(f.lib,f.child.id),[f.stale.id]);
   const current=await capture(f.lib,f.child.id), leaf=current.memories.find(m=>m.hostId==='leaf-0')!;
   await editEvent(f.lib,current,null,{title:'new competing reference',status:'open',keywords:[]},{memory:leaf.id,active:true,kind:'progress'});
  }
  await synchronize(f.lib,f.input);
  const view=await capture(f.lib,f.child.id), leaf=view.memories.find(m=>m.hostId==='leaf-0')!;
  expect(leaf.owner).toBe(f.stale.owner);
  if(mode==='edited') expect(leaf.content).toContain('new manual edit');
  expect((await eventView(f.lib,view)).cards.some(c=>c.needsReview)).toBe(true);
 } finally {f.lib.close();f.original.close();vi.restoreAllMocks();}
});

test('an aborted identity repair rolls back and is retried, with no duplicate-family full history scan',async()=>{
 const f=await inheritedFixture(true);
 try {
  await misselect(f);
  const before=await capture(f.lib,f.child.id), binding=(await f.lib.all<any>('host_bindings','branch',f.child.id))[0];
  let checks=0;
  await expect(synchronize(f.lib,f.input,{branch:before.branch,binding,isCurrent:()=>++checks===1})).rejects.toThrow('事务回滚');
  expect(await capture(f.lib,f.child.id)).toEqual(before);
  await synchronize(f.lib,f.input);
  expect((await capture(f.lib,f.child.id)).memories.find(m=>m.hostId==='leaf-0')!.id).toBe(f.good.id);
 } finally {f.lib.close();f.original.close();vi.restoreAllMocks();}
});
