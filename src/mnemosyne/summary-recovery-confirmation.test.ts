import 'fake-indexeddb/auto';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { Library, Transaction, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, invalidateDaily, hostVersion, dailyState, confirmFork } from './bridge';
import { capture, confirmRecoveredSummaries, statuses, keepSummaries, summarySources } from './canonical';
import * as canonical from './canonical';
import * as api from '@/api/client';
import { recoveredSummaryTargets, retainRecoveredSummaries } from './summary-recovery-confirmation';
import { exportLibrary, restoreLibrary } from './migration';
import { memory } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import { normalizeTags } from '@/memory/contextTags';
import { getLeaf } from '@/memory/apply';
import { eventView, editEvent } from './events';
import type { CapturedView } from './model';
let lib: Library, ctx: any, dispose: (() => void) | undefined;
const message = (user: boolean, text: string) => ({ name: user ? 'User' : 'Character', is_user: user, is_system: false, mes: text, extra: {} as any });
beforeEach(async () => {
 const storage = new Map<string, string>();
 vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k,v), removeItem: (k: string) => storage.delete(k) });
 Object.assign(memory, createEmptyMemory());
 ctx = { chat: [], chatMetadata: {}, characters: [{name:'Synthetic',avatar:'synthetic.png'}], characterId:0,
  getCurrentChatId:()=> 'recovery', saveChat:vi.fn().mockResolvedValue(undefined),saveMetadata:vi.fn().mockResolvedValue(undefined),
  eventTypes:{},eventSource:{on:vi.fn(),off:vi.fn()},setExtensionPrompt:vi.fn() };
 vi.stubGlobal('window',{SillyTavern:{getContext:()=>ctx}});
 lib=await Library.open(freshLibraryName()); await activateLibrary(lib); dispose=bindDaily();
});
afterEach(()=>{dispose?.();lib.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function recovered(count=2, high=true, prefix=0) {
 for(let i=0;i<prefix;i++) ctx.chat.push(message(i%2===0,`synthetic prefix ${i}`));
 for(let i=0;i<count;i++) {
  ctx.chat.push(message(true,`synthetic question ${i}`),message(false,`synthetic reply ${i}`));
  ctx.chat.at(-1).extra.bbs_leaf={id:`leaf-${i}`,text:`synthetic retained summary ${i}`,delta:{},createdAt:i+1,v:1,swipe:0};
 }
 let view=await syncDaily();
 for(let i=0;i<count;i++) {
  const floor=prefix+i*2+1, leaf=ctx.chat[floor].extra.bbs_leaf;
  ctx.chat[floor].extra.mnemosyne_summary_evidence_v1={leaf:leaf.id,text:leaf.text,basis:`missing-basis-${i}`,
   inputRefs:[{message:`missing-message-${i}`,revision:`missing-revision-${i}`}],coverage:[],generationKey:i+1};
 }
 if(high) memory.summaries.push({id:'higher',text:'synthetic higher summary',level:1,createdAt:3,auto:true,childIds:['leaf-0']});
 invalidateDaily();view=await syncDaily();return view;
}
function guardFor(view: CapturedView) {
 const host=hostVersion(),generation=dailyState.generation;
 return ()=>host===hostVersion()&&generation===dailyState.generation;
}
test('155 recovered L0 summaries commit in one epoch without host edits or API calls, preserving evidence and higher review', async()=>{
 const view=await recovered(155,true,1690), before=JSON.stringify(ctx.chat), originals=recoveredSummaryTargets(view);
 const apiCall=vi.spyOn(api,'requestCompletion'), mainApiCall=vi.spyOn(api,'requestViaMainApi');
 expect(originals).toHaveLength(155);
 const captureSpy=vi.spyOn(canonical,'capture'), syncSpy=vi.spyOn(canonical,'synchronize');
 ctx.saveChat.mockClear();
 const next=await retainRecoveredSummaries(view,originals.map(m=>m.id),guardFor(view));
 expect(next.branch.epoch).toBe(view.branch.epoch+1);
 expect(captureSpy).toHaveBeenCalledTimes(1);expect(syncSpy).toHaveBeenCalledTimes(1);
 expect(ctx.saveChat).not.toHaveBeenCalled();expect(apiCall).not.toHaveBeenCalled();expect(mainApiCall).not.toHaveBeenCalled();expect(JSON.stringify(ctx.chat)).toBe(before);
 const validity=await statuses(lib,next);
 for(const original of originals) {
  const current=next.memories.find(m=>m.owner===original.owner)!;
  expect(current.id).not.toBe(original.id);expect(current.content).toBe(original.content);
  expect(current.fingerprint).toBe(original.fingerprint);expect(current.sourceRecovery).toBeUndefined();
  expect(current.inputRefs).toEqual([]);expect(current.basis).toBe(view.snapshot.id);
  expect(current.coverage).toEqual([]);expect(current.declaration).toContain('人工核对恢复摘要');
  expect(validity.get(current.id)).toBe('valid');expect(await lib.get('memory_revisions',original.id)).toEqual(original);
 }
 expect(validity.get(next.memories.find(m=>m.hostId==='higher')!.id)).toBe('needs_rebuild');
 expect(await lib.all('reviews')).toEqual([]);
 expect(next.refs).toHaveLength(2000);
 const last=next.memories.find(m=>m.hostId==='leaf-154')!;
 expect(await lib.transaction(['history_snapshots','manifest_blocks'],'readonly',tx=>summarySources(tx,last))).toEqual(next.refs);
 expect(JSON.stringify(next.memories.filter(m=>!m.level)).length).toBeLessThan(200000);
 expect(dailyState).toMatchObject({pending:false,error:'',review:1});
 await expect(exportLibrary(lib)).resolves.toMatchObject({version:13});
},15000);
test('ordinary keep still rejects recovery; single explicit retain survives sync, reopen, export restore and fork',async()=>{
 const view=await recovered(1,false), original=view.memories[0];
 await expect(keepSummaries(lib,view,[original.id])).rejects.toThrow('不可直接保留');
 let next=await retainRecoveredSummaries(view,[original.id],guardFor(view));
 const approved=next.memories[0];
 for(let i=0;i<2;i++){invalidateDaily();next=await syncDaily();expect(next.memories[0]).toEqual(approved);}
 dispose?.();dispose=bindDaily();next=await syncDaily();expect(next.memories[0]).toEqual(approved);
 const pack=await exportLibrary(lib);dispose?.();lib=await restoreLibrary(pack);dispose=bindDaily();
 next=await syncDaily();expect(next.memories[0]).toEqual(approved);expect((await statuses(lib,next)).get(approved.id)).toBe('valid');
 ctx.getCurrentChatId=()=> 'recovery-child';invalidateDaily();
 const child=await confirmFork(next.branch.id,next.refs.length);
 expect(child.memories).toHaveLength(1);expect(child.memories[0].content).toBe(original.content);
 expect(child.memories[0].sourceRecovery).toBeUndefined();expect((await statuses(lib,child)).get(child.memories[0].id)).toBe('valid');
 expect(await lib.get('memory_revisions',original.id)).toEqual(original);await exportLibrary(lib);
});
test('batch rollback is all-or-nothing on final guard cancellation, stale branch and repeated submission',async()=>{
 const view=await recovered(), ids=recoveredSummaryTargets(view).map(m=>m.id), before=(await exportLibrary(lib)).data;
 let checks=0;
 await expect(confirmRecoveredSummaries(lib,view,ids,()=>++checks===1)).rejects.toThrow('未保存');
 expect(checks).toBe(2);expect((await exportLibrary(lib)).data).toEqual(before);
 await confirmRecoveredSummaries(lib,view,ids);
 const after=(await exportLibrary(lib)).data;
 await expect(confirmRecoveredSummaries(lib,view,ids)).rejects.toThrow('视图已改变');
 expect((await exportLibrary(lib)).data).toEqual(after);
});
test('write failure rolls back revisions, selection and epoch, with no false success',async()=>{
 const view=await recovered(), ids=recoveredSummaryTargets(view).map(m=>m.id), before=(await exportLibrary(lib)).data;
 const original=Transaction.prototype.add;let writes=0;
 vi.spyOn(Transaction.prototype,'add').mockImplementation(function(this: Transaction,store,value){
  if(store==='memory_revisions'&&++writes===2) return Promise.reject(new Error('synthetic disk write failed'));
  return original.call(this,store,value);
 });
 await expect(retainRecoveredSummaries(view,ids,guardFor(view))).rejects.toThrow('synthetic disk write failed');
 expect((await exportLibrary(lib)).data).toEqual(before);expect(dailyState.review).toBe(3);
});
test('invalid, unmapped, omitted, wrong swipe and high summaries are excluded and never partly confirmed',async()=>{
 const view=await recovered(3), original=view.memories.find(m=>m.hostId==='leaf-0')!;
 ctx.chat[3].extra.bbs_omit=true;ctx.chat[5].extra.bbs_leaf.swipe=1;
 expect(recoveredSummaryTargets(view).map(m=>m.id)).toEqual([original.id]);
 const before=(await exportLibrary(lib)).data;
 await expect(retainRecoveredSummaries(view,[original.id,view.memories.find(m=>m.hostId==='leaf-1')!.id],()=>true)).rejects.toThrow('无法映射');
 expect((await exportLibrary(lib)).data).toEqual(before);
 await expect(confirmRecoveredSummaries(lib,view,[view.memories.find(m=>m.level>0)!.id])).rejects.toThrow('L0');
 ctx.chat[1].extra.mnemosyne_message_v1='mismatched-host-key';expect(recoveredSummaryTargets(view)).toEqual([]);
});
test('tag-only edits keep manual provenance, but later source edits and changed generation stamps do not gain approval',async()=>{
 const view=await recovered(1,false);let next=await retainRecoveredSummaries(view,[view.memories[0].id],guardFor(view));
 const approved=next.memories[0], leaf=getLeaf(ctx.chat[1])!;
 // Make the unresolved same-fingerprint history sort first, rather than relying on random UUID order.
 await lib.transaction(['memory_revisions'],'readwrite',tx=>tx.add('memory_revisions',{...view.memories[0],id:'mr_0000_unresolved'}));
 for(const tags of [normalizeTags({participants:['one']}),normalizeTags({participants:['two']}),undefined]) {
  leaf.tags=tags;invalidateDaily();next=await syncDaily();const current=next.memories[0];
  expect(current.sourceRecovery).toBeUndefined();expect(current.basis).toBe(approved.basis);
  expect(current.inputRefs).toEqual(approved.inputRefs);expect((await statuses(lib,next)).get(current.id)).toBe('valid');
 }
 ctx.chat[0].mes+=' changed source';leaf.tags=normalizeTags({participants:['three']});invalidateDaily();next=await syncDaily();
 expect(next.memories[0].inputRefs).toEqual(approved.inputRefs);expect(next.memories[0].basis).toBe(approved.basis);
 expect((await statuses(lib,next)).get(next.memories[0].id)).toBe('needs_review');
 ctx.chat[1].extra.mnemosyne_summary_evidence_v1.generationKey++;
 leaf.tags=normalizeTags({participants:['four']});invalidateDaily();next=await syncDaily();
 expect(next.memories[0].sourceRecovery).toBeDefined();expect((await statuses(lib,next)).get(next.memories[0].id)).toBe('needs_review');await exportLibrary(lib);
});
test('later earlier-body edits invalidate confirmed prefixes and preserve existing event history',async()=>{
 const view=await recovered(2,false), next=await retainRecoveredSummaries(view,view.memories.map(m=>m.id),guardFor(view));
 const event=await editEvent(lib,next,null,{title:'synthetic preserved event',status:'open',keywords:[]},{memory:next.memories[0].id,active:true,kind:'reference'});
 ctx.chat[0].mes+=' changed';invalidateDaily();const edited=await syncDaily();
 expect([...(await statuses(lib,edited)).values()]).toEqual(['needs_review','needs_review']);
 const events=await eventView(lib,edited);expect(events.cards.map(c=>c.chain.id)).toContain(event);expect(events.cards[0].blocked).toBe(true);
 await exportLibrary(lib);
});

test('refresh failure reports that the atomic manual confirmation was already saved',async()=>{
 const view=await recovered(1,false), original=view.memories[0];
 ctx.saveMetadata.mockRejectedValueOnce(new Error('synthetic refresh failed'));
 await expect(retainRecoveredSummaries(view,[original.id],guardFor(view))).rejects.toThrow('已保存 1 条人工确认，刷新未完成');
 const current=await capture(lib,view.branch.id);
 expect(current.memories[0].sourceRecovery).toBeUndefined();expect(current.branch.epoch).toBe(view.branch.epoch+1);
 expect(await lib.get('memory_revisions',original.id)).toEqual(original);expect(dailyState.pending).toBe(true);
});
