import test from 'node:test';
import assert from 'node:assert/strict';
import { PagedCoordinator } from '../../storage/paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../../storage/paged-recovery.mjs';
import { FakeIO } from '../../storage/tests/fake-io.mjs';
import { Importer } from '../importer.mjs';
import { snapshot, rawMessage, TTSource } from '../source.mjs';
import { BridgeEvents } from '../events.mjs';
import { EventEmitter } from 'node:events';
import { digest } from '../records.mjs';

class IO extends FakeIO { async assertEmpty(){assert.equal(this.live.size,0);} }
const input=(source,texts)=>snapshot(source,texts.map((mes,i)=>rawMessage({mes,is_user:i%2===0},i)));
async function setup(){const owner=new PagedCoordinator(new IO()),h=await owner.create();return{owner,h,bridge:new Importer(h)};}
async function bodies(h,b){const s=await h.read('snapshots',b.target.head),refs=await h.range(s.snapshot_id,0,s.message_count);
  return Promise.all(refs.map(async r=>(await h.read('revisions',r.revision_id)).content));}
const save=async(b,s,c)=>b.confirm(await b.preview(s,c));

test('native null swipe slots survive actual source, import and complete restore without inventing text',async()=>{
  const{bridge,h}=await setup(),f=liveFixture(),source=new TTSource(f.host);
  f.chat[1].swipes=[null,'B alternative',null];f.chat[1].swipe_id=2;
  const captured=await source.capture();
  assert.deepEqual(captured.messages[1].candidates,[null,'B alternative',null]);
  assert.equal(captured.messages[1].content,'B');assert.equal(captured.messages[1].selected,2);
  bridge.sourceGuard=x=>source.guard(x);const bound=await save(bridge,captured);
  assert.deepEqual(await bodies(h,bound),['A','B']);
  const mapping=await bridge.record('map',bound.source,1);
  assert.deepEqual(mapping.candidates,{values:[null,'B alternative',null],selected:2});
  assert.equal((await save(bridge,await source.capture())).target.head,bound.target.head);
  const restored=await restorePagedIntoEmpty(new IO(),await h.export());
  const reopened=new Importer(restored.handle());
  assert.deepEqual((await reopened.record('map',bound.source,1)).candidates,mapping.candidates);
  assert.deepEqual(await bodies(restored.handle(),await reopened.record('binding',bound.source)),['A','B']);
  for(const invalid of [42,{},[],undefined])assert.throws(()=>rawMessage({mes:'B',swipes:[invalid]},0),e=>e.code==='INVALID_SCHEMA');
});

test('R1 actual importer: nonempty continuation preserves prefix; copy/overlap require explicit ranges',async()=>{
  const{h,bridge}=await setup();const parent=await save(bridge,input('parent',['A','B','C','D']));
  const branch_id=parent.target.branch_id;
  const empty=await save(bridge,input('empty',[]),{mode:'continue',branch_id});assert.equal(empty.target.head,parent.target.head);
  await assert.rejects(bridge.preview(input('new',['E','F']),{mode:'continue',branch_id}),e=>e.code==='NOT_READY');
  const plan=await bridge.preview(input('new',['E','F']),{mode:'continue',input_mode:'new-segment',branch_id});
  assert.equal(plan.report.removed,0);assert.equal(plan.offset,4);
  const extended=await bridge.confirm(plan);assert.deepEqual(await bodies(h,extended),['A','B','C','D','E','F']);
  const copied=input('copy',['A','B','C','D','E','F']);
  await assert.rejects(bridge.preview(copied,{mode:'continue',branch_id}),e=>e.code==='NOT_READY');
  const full=await save(bridge,copied,{mode:'continue',input_mode:'full-copy',branch_id});assert.equal(full.target.head,extended.target.head);
  const overlapping=input('overlap',['E','F','G','H']);
  await assert.rejects(bridge.preview(overlapping,{mode:'continue',input_mode:'overlap',overlap_count:3,branch_id}),e=>e.code==='NOT_READY');
  const p=await bridge.preview(overlapping,{mode:'continue',input_mode:'overlap',overlap_count:2,branch_id});
  assert.equal(p.report.removed,0);assert.equal(p.report.reused,2);
  const next=await bridge.confirm(p);assert.deepEqual(await bodies(h,next),['A','B','C','D','E','F','G','H']);
  assert.deepEqual(await bodies(h,parent),['A','B','C','D'],'Old immutable Head remains readable');
});

function liveFixture() {
  const eventSource=new EventEmitter(),listeners=new Set(),chat=[{mes:'A',is_user:true},{mes:'B',is_user:false}];
  const data={revision:1,summaries:new Map([[1,'AB摘要']]),file:'one',character:'fixture',stable:'stable',unrelated:0,handleWait:null};
  const info=()=>({id:data.file,length:chat.length});
  const api={apiVersion:1,pluginVersion:'fixture-v1',
    getSnapshot:()=>({revision:data.revision,chat:info(),coverage:{complete:true,missingAiFloors:[]},items:[],scenes:[],lifeDetails:[],vars:{value:data.unrelated}}),
    getHistory:()=>({revision:data.revision,chat:info(),nodes:[...data.summaries].map(([floor,text])=>({id:`leaf${floor}`,kind:'leaf',level:0,text,floorStart:floor-1,floorEnd:floor}))}),
    getFloor:floor=>({revision:data.revision,chat:info(),floor,omitted:false,memory:{id:`leaf${floor}`,valid:data.summaries.has(floor),summary:data.summaries.get(floor)??null}}),
    subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
  const names=['CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_RECEIVED','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED'];
  const ctx={chat,eventSource,eventTypes:Object.fromEntries(names.map(n=>[n,n])),getCurrentChatId:()=>data.file};
  const current={
    ref:async()=>({kind:'character',characterId:data.character,fileName:data.file}),
    handle:async()=>{if(data.handleWait)await data.handleWait;return{stableId:async()=>data.stable};}};
  const host={SillyTavern:{getContext:()=>ctx},STBaiBaiBook:api,__TAURITAVERN__:{api:{chat:{current}}}};
  return{host,chat,data,emit:(n,...args)=>eventSource.emit(n,...args),legacy:()=>{data.revision++;for(const fn of listeners)fn({revision:data.revision,chatId:data.file});}};
}

test('R3 actual event subscription: new round, regenerate success/failure, duplicate and legacy/no-op notifications',async()=>{
  const{bridge,h}=await setup(),f=liveFixture(),source=new TTSource(f.host);
  const events=new BridgeEvents(source);bridge.sourceGuard=c=>source.guard(c);
  const captured=await source.capture(),bound=await save(bridge,captured);events.bind(bridge,bound.source);await bridge.enableSync(bound.source,true);
  f.emit('GENERATION_STARTED','normal');await events.settled();
  assert.equal((await bridge.record('binding',bound.source)).status,'pending');
  f.chat.push({mes:'C',is_user:true},{mes:'D',is_user:false});f.emit('MESSAGE_RECEIVED',3);f.emit('GENERATION_ENDED');f.emit('MESSAGE_RECEIVED',3);
  await events.settled();let b=await bridge.record('binding',bound.source);
  assert.equal(b.status,'complete');assert.deepEqual(await bodies(h,b),['A','B','C','D']);
  const afterAppend=b.target.head;
  f.emit('MESSAGE_RECEIVED',3);await events.settled();assert.equal((await bridge.record('binding',b.source)).target.head,afterAppend);
  f.data.summaries.set(3,'CD实际摘要');f.legacy();await events.settled();
  const mapId=digest({source:b.source,id:'floor:3:leaf3'}),map=await bridge.record('assetMap',mapId);
  assert.equal((await bridge.record('asset',map.asset)).data.text,'CD实际摘要');
  const operations=(await h.diagnostics()).operation_count;f.data.unrelated++;f.legacy();await events.settled();
  assert.equal((await h.diagnostics()).operation_count,operations,'Excluded-category notice is a true no-op');
  f.data.summaries.set(3,'CD修订摘要');f.legacy();await events.settled();
  const revised=await bridge.record('assetMap',mapId);assert.notEqual(revised.asset,map.asset);
  assert.equal((await bridge.record('asset',revised.asset)).previous,map.asset);
  f.emit('GENERATION_STARTED','regenerate');f.chat[3].mes='D2';f.emit('GENERATION_ENDED');await events.settled();
  b=await bridge.record('binding',b.source);assert.deepEqual(await bodies(h,b),['A','B','C','D2']);
  const head=b.target.head;
  f.emit('GENERATION_STARTED','regenerate');f.emit('GENERATION_STOPPED');await events.settled();
  b=await bridge.record('binding',b.source);assert.equal(b.status,'complete');assert.equal(b.target.head,head,'Failed unchanged regenerate creates no Head');
  f.emit('GENERATION_STARTED','regenerate');f.chat.pop();f.emit('GENERATION_ENDED');await events.settled();
  assert.equal((await bridge.record('binding',b.source)).status,'paused','Missing result is not permanent automatic deletion');
  await events.stop();
});

test('R3 subscription drops old queued reads after chat switch without touching either branch',async()=>{
  const{bridge,h}=await setup(),f=liveFixture(),source=new TTSource(f.host),events=new BridgeEvents(source);
  bridge.sourceGuard=c=>source.guard(c);const b=await save(bridge,await source.capture());events.bind(bridge,b.source);await bridge.enableSync(b.source,true);
  let release;f.data.handleWait=new Promise(resolve=>{release=resolve;});
  f.chat[1].mes='late';f.emit('MESSAGE_EDITED',1);await new Promise(resolve=>setImmediate(resolve));
  f.data.stable='different';f.data.file='other';f.emit('CHAT_CHANGED');release();await events.settled();
  assert.equal((await bridge.record('binding',b.source)).target.head,b.target.head);assert.deepEqual(await bodies(h,b),['A','B']);
  await events.stop();
});

test('R2 actual adapter/importer: rename retains archive after confirmation, scope/copy conflicts never auto-merge',async()=>{
  const{bridge,h}=await setup(),f=liveFixture(),source=new TTSource(f.host);bridge.sourceGuard=x=>source.guard(x);
  const first=await source.capture(),b=await save(bridge,first),before=(await h.diagnostics()).operation_count;
  f.data.file='renamed';const renamed=await source.capture();assert.equal(renamed.source,first.source);
  const pending=await bridge.preview(renamed);assert.equal(pending.report.locator_confirmation,true);
  await assert.rejects(bridge.confirm(pending),e=>e.code==='NOT_READY');
  assert.equal((await h.diagnostics()).operation_count,before);
  const kept=await save(bridge,renamed,{mode:'new',confirm_locator:true});
  assert.equal(kept.binding_id,b.binding_id);assert.deepEqual(kept.target,b.target);
  assert.equal((await bridge.record('identity',renamed.source)).locator.fileName,'renamed');
  assert.equal((await h.enumerate('stories')).keys.length,1);assert.deepEqual(await bodies(h,kept),['A','B']);
  f.data.file='copy-with-same-stable-id';await assert.rejects(bridge.confirm(await bridge.preview(await source.capture())),e=>e.code==='NOT_READY');
  f.data.character='different-owner';
  await assert.rejects(bridge.preview(await source.capture(),{mode:'new',legacy_source:b.source,confirm_locator:true}),e=>e.code==='NOT_READY');
  const independent=await save(bridge,await source.capture());
  assert.notEqual(independent.target.story_id,b.target.story_id);
});

test('R2 old v1 receipt gets a durable scoped alias without duplicate originals or assets',async()=>{
  const{bridge,h}=await setup(),f=liveFixture(),source=new TTSource(f.host),captured=await source.capture();
  const oldInput=snapshot(captured.identity.legacy_source,captured.messages,{assets:captured.assets,report:captured.report});
  const old=await save(bridge,oldInput);bridge.sourceGuard=x=>source.guard(x);
  const current=await save(bridge,await source.capture());
  assert.equal(current.source,old.source);assert.deepEqual(current.target,old.target);assert.equal(current.binding_id,old.binding_id);
  assert.equal(await bridge.storageSource(await source.identity()),old.source);
  const alias=await bridge.record('identity',captured.source);assert.equal(alias.binding_source,old.source);
  f.data.file='old-renamed';const again=await save(bridge,await source.capture(),{mode:'new',confirm_locator:true});
  assert.equal(again.target.head,old.target.head);assert.equal((await h.enumerate('stories')).keys.length,1);
});

test('R1 actual fork: child E/F survives; parent C/D and its future summary excluded; reopen/restore',async()=>{
  const{owner,h,bridge}=await setup();const parent=await save(bridge,input('parent',['A','B','C','D']));
  const base={mode:'fork',branch_id:parent.target.branch_id,snapshot_id:parent.target.head,cutoff:2};
  const childInput=input('child',['A','B','E','F']);
  await assert.rejects(bridge.preview(childInput,base),e=>e.code==='NOT_READY');
  const child=await save(bridge,childInput,{...base,input_mode:'existing-child'});
  assert.deepEqual(await bodies(h,child),['A','B','E','F']);
  const parentInput=input('cut',['A','B','C','D']);parentInput.assets=[{category:'summary',source_id:'future',anchor:3,data:{text:'C/D'}}];
  const p=await bridge.preview(parentInput,{...base,input_mode:'parent-cutoff'});
  assert.equal(p.input.messages.length,2);assert.equal(p.input.assets.length,0);
  const cut=await bridge.confirm(p);assert.deepEqual(await bodies(h,cut),['A','B']);
  await assert.rejects(bridge.enableSync(cut.source,true),e=>e.code==='NOT_READY');
  const cancelled=await bridge.preview(input('cancel',['X']),{mode:'continue',input_mode:'new-segment',branch_id:parent.target.branch_id});
  bridge.cancel();await assert.rejects(bridge.confirm(cancelled),e=>e.code==='VERSION_CONFLICT');
  assert.deepEqual(await bodies(h,parent),['A','B','C','D']);
  const fresh=await owner.recover();assert.deepEqual(await bodies(fresh,child),['A','B','E','F']);
  const restored=await restorePagedIntoEmpty(new IO(),await fresh.export());
  assert.deepEqual(await bodies(restored.handle(),child),['A','B','E','F']);
  assert.deepEqual(await new Importer(restored.handle()).record('binding','child'),child);
});
