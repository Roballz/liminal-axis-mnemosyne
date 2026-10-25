import 'fake-indexeddb/auto';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { Library, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, invalidateDaily, captureSummaryEvidence, attachSummaryEvidence, confirmFork, dailyState } from './bridge';
import { capture, statuses, keepSummary } from './canonical';
import { exportLibrary, restoreLibrary } from './migration';
import { withoutCompactSelections, withoutTableHistory } from './fixtures';
import { fingerprint, row, STORES } from './model';
import { editLeafAt } from '@/memory/apply';
import { eventView, editEvent } from './events';
import { reviewDifference } from './review-diagnostics';
import { CoreBackups } from './core-backups';
import { memory } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
let lib: Library, ctx: any, dispose: any;
const message = (user: boolean, text: string) => ({ name: user ? 'User' : 'Character', is_user: user, is_system: false, mes: text, extra: {} as any });
beforeEach(async () => {
 const storage = new Map<string,string>();
 vi.stubGlobal('localStorage', {getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});
 Object.assign(memory, createEmptyMemory());
 ctx={chat:[message(true,'synthetic question'),message(false,'synthetic reply')],chatMetadata:{},characters:[{name:'Synthetic',avatar:'synthetic.png'}],characterId:0,getCurrentChatId:()=> 'ancestor',saveChat:vi.fn().mockResolvedValue(undefined),saveMetadata:vi.fn().mockResolvedValue(undefined),eventTypes:{},eventSource:{on:vi.fn(),off:vi.fn()},setExtensionPrompt:vi.fn()};
 ctx.chat[1].extra.bbs_leaf={id:'old-leaf',text:'synthetic old summary',delta:{},createdAt:1,v:1,swipe:0};
 vi.stubGlobal('window',{SillyTavern:{getContext:()=>ctx}});
 lib=await Library.open(freshLibraryName());await activateLibrary(lib);dispose=bindDaily();
});
afterEach(()=>{dispose?.();lib.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
test.each([11,12])('v%s ancestor backup preserves newer host summary as unresolved and remains exportable', async version=>{
 const ancestor=await syncDaily();
 const backup=await exportLibrary(lib);
 if(version===11){withoutTableHistory(backup);backup.data.table_history=[];}else{withoutCompactSelections(backup);}
 backup.version=version as 11|12;backup.counts=Object.fromEntries(Object.entries(backup.data).map(([k,v])=>[k,v.length])) as any;const {checksum,...base}=backup;backup.checksum=await fingerprint(base);
 ctx.getCurrentChatId=()=> 'child';ctx.chat.push(message(true,'new question'),message(false,'new reply'));invalidateDaily();
 await confirmFork(ancestor.branch.id,2);
 const evidence=await captureSummaryEvidence([2,3]);
 ctx.chat[3].extra.bbs_leaf={id:'new-leaf',text:'synthetic new summary',delta:{},createdAt:2,v:1,swipe:0};
 attachSummaryEvidence(ctx.chat,3,evidence,[2,3]);invalidateDaily();await syncDaily();
 ctx.getCurrentChatId=()=> 'grandchild';dispose();lib=await restoreLibrary(backup);dispose=bindDaily();
 expect(await lib.get('history_snapshots',evidence!.view.snapshot.id)).toBeUndefined();
 await confirmFork(ancestor.branch.id,2);
 const binding=(await lib.all<any>('host_bindings')).find(b=>b.scope==='["synthetic.png","grandchild"]')!;
 expect(binding).toBeDefined();const view=await capture(lib,binding.branch);
 expect(view.refs).toHaveLength(4);expect(view.memories).toHaveLength(2);
 const missing=view.memories.filter(m=>m.basis===evidence!.view.snapshot.id);
 expect(missing).toHaveLength(1);expect(ctx.chat[3].extra.bbs_leaf.text).toBe('synthetic new summary');
 expect((await capture(lib,ancestor.branch.id)).refs).toEqual(ancestor.refs);
 expect(missing[0].sourceRecovery).toMatchObject({version:1,reason:'missing_basis'});
 expect(missing[0].inputRefs).toEqual(evidence!.inputRefs);
 expect((await statuses(lib,view)).get(missing[0].id)).toBe('needs_review');
 expect(dailyState).toMatchObject({pending:false,error:'',archived:4,summaries:2,review:1});
 expect((await eventView(lib,view)).valid.map(m=>m.id)).not.toContain(missing[0].id);
 const saved=await exportLibrary(lib);expect(saved.version).toBe(15);
 const restored=await restoreLibrary(saved,false);
 try {expect(await exportLibrary(restored)).toMatchObject({data:saved.data});expect((await statuses(restored,await capture(restored,view.branch.id))).get(missing[0].id)).toBe('needs_review');}finally{restored.close();}
 const files=new Map<string,Blob>();
 const disk={list:async()=>[...files.keys()],read:async(k:string)=>files.get(k)!,write:async(k:string,v:Blob)=>{files.set(k,v)},remove:async(k:string)=>{files.delete(k)},readSettings:async()=>undefined,writeSettings:async()=>{}};
 const backupManager=new CoreBackups(disk);
 expect((await backupManager.save(lib,'manual')).state).toBe('saved');
 expect((await backupManager.inventory()).entries).toHaveLength(1);
});
test('same old v11 ancestor restore and fork without dangling host summary evidence succeeds',async()=>{
 const ancestor=await syncDaily();const backup=await exportLibrary(lib);withoutTableHistory(backup);backup.version=11;backup.data.table_history=[];backup.counts=Object.fromEntries(Object.entries(backup.data).map(([k,v])=>[k,v.length])) as any;const{checksum,...base}=backup;backup.checksum=await fingerprint(base);
 ctx.getCurrentChatId=()=> 'grandchild';ctx.chat.push(message(true,'new question'),message(false,'new reply'));ctx.chat[3].extra.bbs_leaf={id:'new-leaf',text:'synthetic new summary',delta:{},createdAt:2,v:1,swipe:0};
 dispose();lib=await restoreLibrary(backup);dispose=bindDaily();const child=await confirmFork(ancestor.branch.id,2);
 expect((await statuses(lib,child)).size).toBe(2);await expect(exportLibrary(lib)).resolves.toBeDefined();
});

async function recoveredChild() {
 const ancestor=await syncDaily(), backup=await exportLibrary(lib);
 ctx.getCurrentChatId=()=> 'child';ctx.chat.push(message(true,'new question'),message(false,'new reply'));invalidateDaily();await confirmFork(ancestor.branch.id,2);
 const evidence=await captureSummaryEvidence([2,3]);
 ctx.chat[3].extra.bbs_leaf={id:'new-leaf',text:'synthetic new summary',delta:{},createdAt:2,v:1,swipe:0};attachSummaryEvidence(ctx.chat,3,evidence,[2,3]);
 memory.summaries.push({id:'high',text:'synthetic high summary',level:1,createdAt:3,auto:true,childIds:['new-leaf']});
 invalidateDaily();await syncDaily();
 ctx.getCurrentChatId=()=> 'grandchild';dispose();lib=await restoreLibrary(backup);dispose=bindDaily();
 const view=await confirmFork(ancestor.branch.id,2);
 return {ancestor,view,summary:view.memories.find(m=>m.hostId==='new-leaf')!};
}

test('already committed poison and matching historical revisions repair idempotently without changing IDs or parent',async()=>{
 const {ancestor,view,summary}=await recoveredChild();
 const valid=view.memories.find(m=>m.hostId==='old-leaf')!;
 const event=await editEvent(lib,view,null,{title:'preserved child event',status:'open',keywords:[]},{memory:valid.id,active:true,kind:'reference'});
 const old={...summary,...row('mr'),content:'older synthetic summary'};delete old.sourceRecovery;
 const selected={...summary};delete selected.sourceRecovery;
 await lib.transaction(STORES,'readwrite',async tx=>{await tx.put('memory_revisions',selected);await tx.add('memory_revisions',old)});
 await expect(exportLibrary(lib)).rejects.toThrow('引用缺失 history_snapshots');
 dispose();dispose=bindDaily();invalidateDaily();const repaired=await syncDaily();
 expect(repaired.branch.id).toBe(view.branch.id);
 expect(repaired.memories.find(m=>m.hostId==='new-leaf')?.id).toBe(summary.id);
 expect(await lib.get('memory_revisions',old.id)).toMatchObject({...old,sourceRecovery:{reason:'missing_basis'}});
 expect((await eventView(lib,repaired)).cards.map(c=>c.chain.id)).toContain(event);
 expect((await capture(lib,ancestor.branch.id)).refs).toEqual(ancestor.refs);
 const before=await exportLibrary(lib);invalidateDaily();await syncDaily();expect((await exportLibrary(lib)).data).toEqual(before.data);
 expect((await statuses(lib,repaired)).get(repaired.memories.find(m=>m.hostId==='high')!.id)).toBe('needs_review');
});

test('manual confirmation is explicit, free of model calls, preserves original proof and later source edits still invalidate',async()=>{
 const {view,summary}=await recoveredChild();
 await expect(keepSummary(lib,view,summary.id)).rejects.toThrow('不可直接保留');
 expect((await reviewDifference(lib,view,summary.id)).explanation).toContain('旧核心包');
 expect(editLeafAt(3,summary.content,'','')).toBe(true);invalidateDaily();
 let current=await syncDaily(), approved=current.memories.find(m=>m.hostId==='new-leaf')!;
 expect(approved.id).not.toBe(summary.id);expect(approved.sourceRecovery).toBeUndefined();
 expect(approved.inputRefs).toEqual(current.refs);expect(approved.coverage).toEqual([]);
 expect(approved.declaration).toContain('人工核对恢复摘要');expect((await statuses(lib,current)).get(approved.id)).toBe('valid');
 expect(await lib.get('memory_revisions',summary.id)).toEqual(summary);
 await exportLibrary(lib);
 ctx.chat[0].mes+=' changed';invalidateDaily();current=await syncDaily();
 expect((await statuses(lib,current)).get(approved.id)).toBe('needs_review');await exportLibrary(lib);
});

test('unrelated corrupted history is never automatically accepted as recovered host evidence',async()=>{
 const {view,summary}=await recoveredChild();
 const unrelated={...summary,...row('mr'),basis:'unrelated-missing-baseline'};delete unrelated.sourceRecovery;
 await lib.transaction(STORES,'readwrite',tx=>tx.add('memory_revisions',unrelated));
 invalidateDaily();await syncDaily();
 expect(await lib.get('memory_revisions',unrelated.id)).toEqual(unrelated);
 await expect(exportLibrary(lib)).rejects.toThrow('引用缺失 history_snapshots/unrelated-missing-baseline');
});

test('recovery declaration cannot hide malformed, present or foreign references in a recomputed package',async()=>{
 const {summary,view}=await recoveredChild();const saved=await exportLibrary(lib);
 for(const mutate of [
  (p:any)=>{p.version=12},
  (p:any)=>{delete p.data.memory_revisions.find((m:any)=>m.id===summary.id).sourceRecovery},
  (p:any)=>{p.data.memory_revisions.find((m:any)=>m.id===summary.id).sourceRecovery.version=2},
  (p:any)=>{p.data.memory_revisions.find((m:any)=>m.id===summary.id).basis=view.snapshot.id},
  (p:any)=>{p.data.memory_revisions.find((m:any)=>m.id===summary.id).inputRefs[0].unexpected=true},
  (p:any)=>{p.data.memory_revisions.find((m:any)=>m.id===summary.id).inputRefs[0]={message:view.refs[0].message,revision:view.refs[1].revision}},
 ]) {
  const forged=structuredClone(saved);mutate(forged);const {checksum,...base}=forged;forged.checksum=await fingerprint(base);
  await expect(restoreLibrary(forged,false)).rejects.toThrow();
 }
});

test('missing basis never gains implicit sidecar approval and old receipts remain non-authoritative',async()=>{
 await syncDaily();const evidence=await captureSummaryEvidence([0,1]);
 ctx.chat[1].mes+=' synthetic sidecar';ctx.chat[1].extra.bbs_leaf.text+=' newly generated';
 attachSummaryEvidence(ctx.chat,1,evidence,[0,1]);ctx.chat[1].extra.mnemosyne_summary_evidence_v1.basis='missing-after-restore';invalidateDaily();
 const view=await syncDaily(), summary=view.memories[0];
 expect(summary.sourceRecovery).toBeDefined();expect(await lib.all('reviews','owner',summary.id)).toEqual([]);
 // A previous buggy version may already have written a sidecar approval. Retain
 // its exact audit record, but it cannot approve the unresolved generation evidence.
 await lib.transaction(STORES,'readwrite',async tx=>{await tx.add('reviews',{
  ...row('review'),story:view.branch.story,branch:view.branch.id,owner:summary.id,snapshot:view.snapshot.id,
  decision:'compatible',origin:'generated_sidecar',created:1,reviewSchema:2,sourceRefs:view.refs,coverage:view.refs,dependencies:[],
 } as any)});
 expect((await statuses(lib,view)).get(summary.id)).toBe('needs_review');
 const pack=await exportLibrary(lib), restored=await restoreLibrary(pack,false);
 try{expect((await statuses(restored,await capture(restored,view.branch.id))).get(summary.id)).toBe('needs_review');}finally{restored.close();}
});
