import test from 'node:test';
import assert from 'node:assert/strict';
import { PagedCoordinator } from '../../storage/paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../../storage/paged-recovery.mjs';
import { FakeIO } from '../../storage/tests/fake-io.mjs';
import { Importer } from '../importer.mjs';
import { rawMessage, snapshot, projectLegacy, parseJSONL, ordinaryPair, TTSource } from '../source.mjs';
import { digest } from '../records.mjs';

class IO extends FakeIO { async assertEmpty() { assert.equal(this.live.size, 0); } }
const raw = (text, user = false) => ({ mes: text, is_user: user, extra: { token: 'EXCLUDED-SECRET' } });
const input = (name = 'fiction-A', texts = ['虚构提问','虚构回答']) => snapshot(name, texts.map((t, i) => rawMessage(raw(t, i % 2 === 0), i)));
async function setup() {
  const io = new IO(), owner = new PagedCoordinator(io), h = await owner.create();
  return { io, owner, h, importer: new Importer(h) };
}
async function entries(h, b) {
  const snap = await h.read('snapshots', b.target.head);
  return h.range(snap.snapshot_id, 0, snap.message_count);
}
function legacy(messages) {
  const chat = {id:'fiction', length:messages.length};
  const state = { revision: 1, chat, coverage:{complete:true,missingAiFloors:[]},
    items:[{id:'i',name:'虚构钥匙',desc:'铜制',credentials:'EXCLUDED-SECRET'}],
    scenes:[{id:'s',name:'虚构塔',path:['塔'],parentId:'',desc:'空塔',npc:'EXCLUDED-SECRET'}],
    lifeDetails:[{id:'d',subject:'虚构甲',text:'不喝甜茶',topics:[],anchors:[],tier:'active',vectors:['EXCLUDED-SECRET']}],
    npcs:[{name:'EXCLUDED-SECRET'}], vars:{key:'EXCLUDED-SECRET'} };
  return {apiVersion:1,pluginVersion:'fixture', getSnapshot:()=>structuredClone(state),
    getHistory:()=>({revision:1,chat,nodes:[{id:'h',kind:'comp',level:1,text:'虚构总结',floorStart:0,floorEnd:1}]}),
    getFloor:floor=>({revision:1,chat,floor,body:'CLEANED-NOT-RAW',memory:{id:`m${floor}`,valid:true,summary:'虚构摘要',delta:{key:'EXCLUDED-SECRET'}}})};
}

test('B01/B02/B07 raw header, strict pairing, public whitelist, no source writes', async () => {
  const rows = [raw('开场'),raw('甲',true),raw('乙',true),raw('答'),{...raw('系统'),is_system:true},raw('待答',true)];
  const before = digest(rows), messages = parseJSONL([JSON.stringify({chat_metadata:{secret:'EXCLUDED-SECRET'}}),...rows.map(JSON.stringify)].join('\n'));
  assert.equal(messages.length,6); assert.equal(messages[0].content,'开场'); assert.equal(ordinaryPair(messages,3),false);
  const api = legacy(messages), projected = projectLegacy(api,messages,['items','scenes','lifeDetails']);
  assert.equal(projected.assets.length,6); assert.ok(!JSON.stringify(projected).includes('EXCLUDED-SECRET'));
  assert.ok(!JSON.stringify(projected).includes('CLEANED-NOT-RAW')); assert.equal(digest(rows),before);
  assert.equal(projectLegacy(null,messages).assets.length,0);
  const { importer,h } = await setup(), s = snapshot('fixture',messages,projected);
  const b = await importer.confirm(await importer.preview(s));
  assert.equal((await entries(h,b)).length,6);
  assert.equal((await h.enumerate('memories')).keys.length,0,'No invented TurnMemory inputs');
  assert.equal((await importer.record('session',b.session)).report.source_unproven,6);
});

test('B03 duplicate, cancel/reopen, lost confirmation and complete empty-target recovery', async () => {
  const { importer,h,owner,io } = await setup();
  const s = input('recover',Array.from({length:18},(_,i)=>`虚构${i}`));
  let calls = 0;
  importer.sourceGuard = async () => { if (++calls === 3) importer.cancel(); };
  const partial = await importer.confirm(await importer.preview(s));
  assert.equal(partial.status,'partial'); assert.ok(partial.count < 18);
  const opened = await owner.recover(), resumed = new Importer(opened);
  const b = await resumed.resume(partial.session,s); assert.equal(b.status,'complete');
  const before = await opened.diagnostics();
  const again = await resumed.confirm(await resumed.preview(s));
  assert.equal(again.target.head,b.target.head); assert.equal((await opened.diagnostics()).operation_count,before.operation_count);
  const restored = await restorePagedIntoEmpty(new IO(),await opened.export());
  const recovered = new Importer(restored.handle());
  assert.deepEqual(await recovered.record('binding',s.source),b);
  await assert.rejects(restored.handle().logical(),e=>e.code==='UNSUPPORTED');
  assert.equal(restored.status,'ready','Expected export refusal is not storage corruption');
  const next = input('lost');
  io.fail = {label:'paged-ack',edge:'after',n:2,durable:true};
  await assert.rejects(resumed.confirm(await resumed.preview(next)),e=>e.code==='RECOVERY_REQUIRED');
  const fresh = new Importer(await owner.recover()); await fresh.recoverPending();
  const receipt = await fresh.record('binding','lost'); assert.ok(receipt);
  assert.equal((await fresh.resume(receipt.session,next)).status,'complete');
});

test('B04 distinct same-text stories, stale preview, continuation and fixed fork cutoff', async () => {
  const {importer,h} = await setup();
  const a = await importer.confirm(await importer.preview(input('A')));
  const b = await importer.confirm(await importer.preview(input('B')));
  assert.notEqual(a.target.story_id,b.target.story_id);
  const c = await importer.confirm(await importer.preview(input('C',[]),{mode:'continue',branch_id:a.target.branch_id}));
  assert.equal(c.target.head,a.target.head);
  const continued = await importer.confirm(await importer.preview(input('C',['续接User'])));
  assert.equal((await entries(h,continued)).length,3);
  const cleared = await importer.confirm(await importer.preview(input('C',[])));
  assert.equal((await entries(h,cleared)).length,2,'Removing new window text must preserve inherited prefix');
  const f = await importer.confirm(await importer.preview(input('F'),{mode:'fork',input_mode:'parent-cutoff',branch_id:a.target.branch_id,snapshot_id:a.target.head,cutoff:1}));
  assert.equal((await entries(h,f)).length,1); assert.deepEqual((await entries(h,f))[0],(await entries(h,a))[0]);
  const old = await importer.preview(input('stale')); importer.cancel();
  await assert.rejects(importer.confirm(old),e=>e.code==='VERSION_CONFLICT');
});

test('B05 bounded source read and event-correlated edit/append; generation pending and duplicate notifications', async()=>{
  const {importer,h}=await setup();
  const chat=[raw('虚构提问',true),raw('虚构回答')], ref={kind:'character',characterId:'synthetic',fileName:'fiction'};
  const context={chat,getCurrentChatId:()=> 'fiction'};
  let switchChat=false;
  const source=new TTSource({SillyTavern:{getContext:()=>context},__TAURITAVERN__:{api:{chat:{current:{
    ref:async()=>switchChat?{...ref,fileName:'other'}:ref,handle:async()=>({stableId:async()=> 'stable'})}}}}});
  const original=await source.capture(); importer.sourceGuard=x=>source.guard(x);
  let b=await importer.confirm(await importer.preview(original));await importer.enableSync(b.source,true);
  chat[1].mes='改文';source.generation++;
  const local=await source.captureLocal(1);assert.equal(local.messages.length,1);
  b=await importer.applyLocal(local,'edit');const head=b.target.head;
  b=await importer.applyLocal(local,'edit');assert.equal(b.target.head,head);
  await importer.setState(b.source,'pending','generation-in-progress');
  chat[1].mes='再生成';source.generation++;
  b=await importer.applyLocal(await source.captureLocal(1),'regenerate');assert.equal(b.status,'complete');
  chat.push(raw('追加问题',true));source.generation++;
  b=await importer.applyLocal(await source.captureLocal(2,16),'append');assert.equal((await entries(h,b)).length,3);
  const late=await source.captureLocal(1);switchChat=true;
  await assert.rejects(importer.applyLocal(late,'edit'),e=>e.code==='VERSION_CONFLICT');
  let calls=0;switchChat=false;
  source.host.__TAURITAVERN__.api.chat.current.handle=async()=>{
    if(++calls===2)chat[1].mes='changed during read';
    return{stableId:async()=> 'stable'};
  };
  await assert.rejects(source.capture(),e=>e.code==='VERSION_CONFLICT');
});

test('B05 local edit/swipe/regenerate preserve ID; repeated notices and late results rejected', async () => {
  const {importer,h} = await setup();
  let b = await importer.confirm(await importer.preview(input())); await importer.enableSync(b.source,true);
  const original = await entries(h,b);
  for (const kind of ['edit','swipe','regenerate']) {
    const changed = input('fiction-A',['虚构提问',kind]);
    b = await importer.localEdit(changed,1,kind);
    const refs = await entries(h,b); assert.equal(refs[1].message_id,original[1].message_id); assert.notEqual(refs[1].revision_id,original[1].revision_id);
    await assert.rejects(importer.localEdit(changed,1,kind),e=>e.code==='VERSION_CONFLICT');
  }
  const changed = input('fiction-A',['虚构提问','迟到']);
  importer.sourceGuard = async()=>{ const e = Error('changed while reading'); e.code='VERSION_CONFLICT'; throw e; };
  await assert.rejects(importer.localEdit(changed,1),e=>e.code==='VERSION_CONFLICT');
});

test('B06 deletion persists pause, ignore does not release, confirmation retains child and old versions', async () => {
  const {importer,h,owner} = await setup();
  const a = await importer.confirm(await importer.preview(input()));
  const f = await importer.confirm(await importer.preview(input('child'),{mode:'fork',input_mode:'existing-child',branch_id:a.target.branch_id,cutoff:2}));
  const old = await entries(h,a); await importer.enableSync(a.source,true);
  const cut = input('fiction-A',['虚构提问']);
  const warning = await importer.reconcile(cut); assert.equal(warning.status,'paused');
  const reopened = new Importer(await owner.recover());
  assert.equal((await reopened.record('binding',a.source)).status,'paused');
  const b = await reopened.confirm(await reopened.preview(cut)); assert.equal(b.status,'complete');
  const handle = owner.handle(); assert.equal((await entries(handle,b)).length,1);
  assert.deepEqual(await entries(handle,f),old); assert.ok(await handle.read('revisions',old[1].revision_id));
});
