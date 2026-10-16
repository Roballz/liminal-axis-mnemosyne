import 'fake-indexeddb/auto';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { Library, Transaction, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, invalidateDaily, hostVersion, dailyState, confirmFork } from './bridge';
import { capture, confirmRecoveredSummaries, statuses, keepSummaries, summarySources } from './canonical';
import * as canonical from './canonical';
import * as api from '@/api/client';
import { recoveredSummaryTargets, retainRecoveredSummaries, summaryConfirmationPlan } from './summary-recovery-confirmation';
import { exportLibrary, restoreLibrary } from './migration';
import { memory } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import { normalizeTags } from '@/memory/contextTags';
import { getLeaf } from '@/memory/apply';
import { eventView, editEvent } from './events';
import type { CapturedView } from './model';
import { summarizeFloor } from '@/memory/engine';
import { selectHistoryNodesBefore } from '@/memory/inject';
import * as settings from '@/api/settings';
import * as hostContext from '@/st/context';
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
test('mixed 24 recovered and 131 ordinary L0 reviews confirm together without replacing original proofs',async()=>{
 for(let i=0;i<155;i++) {
  ctx.chat.push(message(true,`synthetic question ${i}`),message(false,`synthetic reply ${i}`));
  ctx.chat.at(-1).extra.bbs_leaf={id:`mixed-${i}`,text:`synthetic summary ${i}`,delta:{},createdAt:i+1,v:1,swipe:0};
 }
 const before=await syncDaily();
 for(let i=0;i<155;i++) {
  const leaf=ctx.chat[i*2+1].extra.bbs_leaf;
  if(i<24) ctx.chat[i*2+1].extra.mnemosyne_summary_evidence_v1={leaf:leaf.id,text:leaf.text,basis:`missing-${i}`,
   inputRefs:[{message:`missing-message-${i}`,revision:`missing-revision-${i}`}],coverage:[],generationKey:i+1};
  else if(i%2===0) ctx.chat[i*2+1].extra.mnemosyne_summary_evidence_v1={leaf:leaf.id,text:leaf.text,basis:before.snapshot.id,
   inputRefs:[before.refs[0],...before.refs.slice(i*2,i*2+2)],coverage:before.refs.slice(i*2,i*2+2),generationKey:i+1};
 }
 ctx.chat[0].mes+=' edited';invalidateDaily();const view=await syncDaily(), originals=view.memories;
 expect(originals.filter(m=>m.sourceRecovery)).toHaveLength(24);
 expect(originals.filter(m=>!m.sourceRecovery)).toHaveLength(131);
 expect([...(await statuses(lib,view)).values()].every(s=>s==='needs_review')).toBe(true);
 expect(recoveredSummaryTargets(view)).toHaveLength(155);
 const host=JSON.stringify(ctx.chat), captureSpy=vi.spyOn(canonical,'capture'), syncSpy=vi.spyOn(canonical,'synchronize');
 const apiCall=vi.spyOn(api,'requestCompletion'), mainApiCall=vi.spyOn(api,'requestViaMainApi');ctx.saveChat.mockClear();
 let next=await retainRecoveredSummaries(view,originals.map(m=>m.id),guardFor(view));
 expect(next.branch.epoch).toBe(view.branch.epoch+1);expect(captureSpy).toHaveBeenCalledTimes(1);expect(syncSpy).toHaveBeenCalledTimes(1);
 expect(ctx.saveChat).not.toHaveBeenCalled();expect(apiCall).not.toHaveBeenCalled();expect(mainApiCall).not.toHaveBeenCalled();expect(JSON.stringify(ctx.chat)).toBe(host);
 expect([...(await statuses(lib,next)).values()].every(s=>s==='valid')).toBe(true);
 for(const original of originals) {
  const confirmed=next.memories.find(m=>m.owner===original.owner)!;
  expect(confirmed.id).not.toBe(original.id);expect(confirmed.basis).toBe(view.snapshot.id);
  expect(confirmed.inputRefs).toEqual([]);expect(confirmed.coverage).toEqual([]);expect(confirmed.anchor).toBe(original.anchor);
  expect(confirmed.content).toBe(original.content);expect(confirmed.fingerprint).toBe(original.fingerprint);
  expect(confirmed.declaration).toContain(original.sourceRecovery?'旧生成来源仍缺失':'原摘要、生成基线与来源声明保留');
  expect(await lib.get('memory_revisions',original.id)).toEqual(original);
 }
 const confirmed=next.memories;
 const pack=await exportLibrary(lib);dispose?.();lib=await restoreLibrary(pack);dispose=bindDaily();next=await syncDaily();
 expect(next.memories).toEqual(confirmed);expect([...(await statuses(lib,next)).values()].every(s=>s==='valid')).toBe(true);
 ctx.chat[0].mes+=' later edit';invalidateDaily();next=await syncDaily();
 expect([...(await statuses(lib,next)).values()].every(s=>s==='needs_review')).toBe(true);
},15000);
test('ordinary L0 reviews keep the same exact-host exclusions as missing-basis recovery',async()=>{
 const view=await recovered(3,false);
 const ordinary={...view,memories:view.memories.map(({sourceRecovery,...m})=>m)};
 expect(recoveredSummaryTargets(ordinary)).toHaveLength(3);
 ctx.chat[3].extra.bbs_omit=true;ctx.chat[5].extra.bbs_leaf.swipe=1;
 expect(recoveredSummaryTargets(ordinary).map(m=>m.hostId)).toEqual(['leaf-0']);
 ctx.chat[1].extra.mnemosyne_message_v1='mismatched-host-key';expect(recoveredSummaryTargets(ordinary)).toEqual([]);
});
test('actual engine-generated L0 dependencies remain historical while explicit confirmation uses current bodies',async()=>{
 const preview=settings.apiSettings.summarySuccessPreviewEnabled;settings.apiSettings.summarySuccessPreviewEnabled=false;
 vi.spyOn(settings,'engineActiveHere').mockReturnValue(true);vi.spyOn(settings,'getChannelForTask').mockReturnValue(null);
 vi.spyOn(api,'mainApiAvailable').mockReturnValue(true);vi.spyOn(hostContext,'getCheckWorldInfo').mockResolvedValue(null);
 const request=vi.spyOn(api,'requestViaMainApi').mockImplementation(async()=>JSON.stringify({summary:`generated summary ${request.mock.calls.length}`}));
 ctx.name1='User';ctx.name2='Character';
 try {
  for(let i=0;i<3;i++)ctx.chat.push(message(true,`engine question ${i}`),message(false,`engine reply ${i}`));
  for(const floor of [1,3,5]){await summarizeFloor(floor);expect(getLeaf(ctx.chat[floor])).toBeDefined();await syncDaily();}
  expect(request).toHaveBeenCalledTimes(3);
  const generated=await syncDaily(), later=generated.memories.find(m=>m.hostId===getLeaf(ctx.chat[5])!.id)!;
  expect(later.dependencies.length).toBeGreaterThan(0);expect(later.inputRefs.length).toBeGreaterThan(0);
  memory.summaries.push({id:'generated-higher',text:'higher generated dependency',level:1,createdAt:4,auto:true,childIds:[later.hostId]});
  invalidateDaily();const withHigher=await syncDaily();
  const event=await editEvent(lib,withHigher,null,{title:'original generated event',status:'open',keywords:[],overview:'original event overview',summarized:[later.id]},{memory:later.id,active:true,kind:'reference'});
  ctx.chat[3].extra.mnemosyne_summary_evidence_v1.basis='missing-engine-basis';
  ctx.chat[0].mes+=' changed';invalidateDaily();const view=await syncDaily();
  expect(view.memories.filter(m=>m.level===0&&m.dependencies.length)).toHaveLength(2);
  expect([...(await statuses(lib,view)).values()].every(s=>s==='needs_review'||s==='needs_rebuild')).toBe(true);
  const host=JSON.stringify(ctx.chat);request.mockClear();ctx.saveChat.mockClear();
  expect(recoveredSummaryTargets(view)).toHaveLength(3);
  const next=await retainRecoveredSummaries(view,[view.memories.find(m=>m.owner===later.owner)!.id],guardFor(view));
  const confirmed=next.memories.find(m=>m.owner===later.owner)!;
  expect(confirmed.dependencies).toEqual([]);expect(confirmed.inputRefs).toEqual([]);expect(confirmed.coverage).toEqual([]);
  expect(confirmed.basis).toBe(view.snapshot.id);expect((await statuses(lib,next)).get(confirmed.id)).toBe('valid');
  expect((await statuses(lib,next)).get(next.memories.find(m=>m.hostId==='generated-higher')!.id)).toBe('needs_rebuild');
  expect((await eventView(lib,next)).cards.find(c=>c.chain.id===event)?.needsReview).toBe(true);
  expect(request).not.toHaveBeenCalled();expect(ctx.saveChat).not.toHaveBeenCalled();expect(JSON.stringify(ctx.chat)).toBe(host);
  for(const old of view.memories) expect(await lib.get('memory_revisions',old.id)).toEqual(old);
  await exportLibrary(lib);
  getLeaf(ctx.chat[1])!.text+=' summary-only change';invalidateDaily();const summaryChanged=await syncDaily();
  expect(summaryChanged.memories.find(m=>m.owner===later.owner)).toEqual(confirmed);
  expect((await statuses(lib,summaryChanged)).get(confirmed.id)).toBe('valid');
  ctx.chat[0].mes+=' later body edit';invalidateDaily();const changed=await syncDaily();
  expect((await statuses(lib,changed)).get(confirmed.id)).toBe('needs_review');
 } finally {settings.apiSettings.summarySuccessPreviewEnabled=preview;}
});
test('155 L0 recovery rows with 131 recorded history dependencies remain one explicit body-confirmation batch',async()=>{
 for(let i=0;i<155;i++) {
  ctx.chat.push(message(true,`dependent question ${i}`),message(false,`dependent reply ${i}`));
  ctx.chat.at(-1).extra.bbs_leaf={id:`dependent-${i}`,text:`dependent summary ${i}`,delta:{},createdAt:i+1,v:1,swipe:0};
 }
 await syncDaily();const history=selectHistoryNodesBefore(memory.summaries,ctx.chat,ctx.chat.length);
 expect(history).toHaveLength(155);
 for(let i=0;i<155;i++) {
  const floor=i*2+1,leaf=getLeaf(ctx.chat[floor])!;
  ctx.chat[floor].extra.mnemosyne_summary_evidence_v1={leaf:leaf.id,text:leaf.text,basis:`missing-dependent-${i}`,
   inputRefs:[],coverage:[],generationKey:i+1,dependencies:i<24?[]:history.filter(n=>n.msgIndex<floor-1).map(n=>n.id)};
 }
 invalidateDaily();const view=await syncDaily();expect(view.memories.filter(m=>m.dependencies.length)).toHaveLength(131);
 expect(view.memories.filter(m=>m.sourceRecovery)).toHaveLength(155);expect(recoveredSummaryTargets(view)).toHaveLength(155);
 const next=await retainRecoveredSummaries(view,view.memories.map(m=>m.id),guardFor(view));
 expect(next.branch.epoch).toBe(view.branch.epoch+1);expect(next.memories.every(m=>!m.dependencies.length)).toBe(true);
 expect([...(await statuses(lib,next)).values()].every(s=>s==='valid')).toBe(true);
 for(const old of view.memories)expect(await lib.get('memory_revisions',old.id)).toEqual(old);
 await exportLibrary(lib);
},15000);
test('read-only exclusion counts distinguish exact blockers without exposing summary or source text',async()=>{
 const view=await recovered(3,true);ctx.chat[3].extra.bbs_omit=true;ctx.chat[5].extra.mnemosyne_message_v1='wrong-host';
 const plan=summaryConfirmationPlan(view);
 expect(plan.targets.map(m=>m.hostId)).toEqual(['leaf-0']);
 expect(Object.fromEntries(plan.exclusions)).toEqual({'宿主楼层已停用':1,'来源消息身份不一致':1,'上层摘要':1});
 const selected=new Set([view.memories.find(m=>m.hostId==='leaf-1')!.id]);
 expect(Object.fromEntries(summaryConfirmationPlan(view,selected).exclusions)).toEqual({'宿主楼层已停用':1});
 expect(JSON.stringify([...plan.exclusions])).not.toContain('synthetic');
});
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
 await expect(exportLibrary(lib)).resolves.toMatchObject({version:14});
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

test('missing historical recovery proofs remain reviewable while proven deleted anchors stay excluded across later syncs', async () => {
 const before=await recovered(2,true);
 expect(before.memories.filter(m=>m.sourceRecovery)).toHaveLength(2);
 const higher=before.memories.find(m=>m.hostId==='higher')!;
 // Delete the unrelated second assistant; missing-basis evidence of the first
 // leaf was never observed locally and must not be mistaken for this deletion.
 ctx.chat.splice(3,1);invalidateDaily();let current=await syncDaily();
 expect(current.memories.map(m=>m.hostId).sort()).toEqual(['higher','leaf-0']);
 expect(recoveredSummaryTargets(current).map(m=>m.hostId)).toEqual(['leaf-0']);
 // Now the first leaf's real mapped anchor is removed. Its higher dependent
 // must disappear even though that leaf also has declared unknown old proofs.
 ctx.chat.splice(1,1);invalidateDaily();current=await syncDaily();
 expect(current.memories).toEqual([]);
 ctx.chat.push(message(true,'unrelated later append'));invalidateDaily();current=await syncDaily();
 expect(current.memories).toEqual([]);
 expect(await lib.get('memory_revisions',higher.id)).toEqual(higher);
 await exportLibrary(lib);
});
