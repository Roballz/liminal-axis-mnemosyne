import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench } from '../service.mjs';
import { normalize } from '../normalize.mjs';
import { mountWorkbench } from '../panel.mjs';
import { restorePagedIntoEmpty } from '../../storage/paged-recovery.mjs';
import { Importer } from '../../bridge/importer.mjs';
import { digest,recordKey } from '../../bridge/records.mjs';
import { newId } from '../../contracts/primitives.mjs';
import { fixture,scope,input,rows,commit,IO,documentFixture } from './fixture.mjs';
const options={milliseconds:10000};
async function all(w,q,o={}){const out=[];let page=await w.search(q,o),pages=0;
  do{out.push(...page.items);if(!page.cursor)break;assert.ok(++pages<40,'bounded fixture made no progress');page=await w.next(page.cursor);}while(true);return out;}

test('S02 full default fold, explicit whitespace, exact mode and length changes preserve literal boundaries',()=>{
  assert.equal(normalize(' ＨＥＬＬＯ\u0085Straße\tΣςσ İ ﬃ '),'hello strasse σσσ i\u0307 ffi');
  assert.equal(normalize('\u13a0\uab70'),'\u13a0\u13a0','Cherokee folds to uppercase, unlike lowercasing');
  assert.equal(normalize('A\u200bB'),'a\u200bb');assert.notEqual(normalize('ab'),normalize('a b'));
  assert.notEqual(normalize('繁體'),normalize('繁体'));assert.notEqual(normalize('，'),normalize('、'));
  assert.equal(normalize('Ａ ß','exact'),'Ａ ß');assert.equal(normalize('\u0085\u3000'),'');
});

test('S01/S03 scoped snapshot members, stable pagination, roles, old swipe and explicit history',async()=>{
  const f=await fixture(),w=new Workbench(f.h,{...options,messages:2,results:1});
  const other=await commit(f.bridge,input('other'));
  const child=await commit(f.bridge,input('child',rows.slice(0,2)),{mode:'fork',input_mode:'parent-cutoff',branch_id:f.bound.target.branch_id,cutoff:2});
  await w.select(scope(child));assert.equal((await all(w,'终点')).length,0);
  await w.select(scope(f.bound));const hits=await all(w,'钟楼');
  assert.deepEqual(hits.map(x=>x.index),[0,1,2,4]);assert.deepEqual(hits.map(x=>x.role),['user','assistant','system','assistant']);
  assert.ok(hits.every(x=>x.story_id!==other.target.story_id));assert.equal((await all(w,'旧swipe')).length,0);
  const changed=rows.map(x=>({...x}));changed[4].mes='已修改的结尾';
  const updated=await commit(f.bridge,input('fixture',changed));
  await w.select(scope(updated));assert.equal((await all(w,'终点')).length,0);
  const historical=await w.select({...scope(updated),snapshot:f.bound.target.head});assert.equal(historical.historical,true);
  assert.equal((await all(w,'终点')).length,1);
  assert.equal((await f.h.diagnostics(updated.target.branch_id)).branch.head_snapshot_id,updated.target.head);
  const deleted=await commit(f.bridge,input('fixture',changed.slice(0,2)));
  await w.select(scope(deleted));assert.equal((await all(w,'system')).length,0);
  await f.bridge.setState(deleted.source,'paused','manual-review');
  await assert.rejects(w.select(scope(deleted)),{code:'LAST_ARCHIVE_REQUIRED'});
  assert.equal((await w.select({...scope(deleted),allowLast:true})).status,'paused');
  assert.equal((await f.bridge.record('binding',deleted.source)).status,'paused');
  const pendingBridge=new Importer({...f.h,execute:async()=>{throw Error('prepared-only');}});
  await assert.rejects(pendingBridge.setState(deleted.source,'pending','synthetic-prepared'));
  const checkpoint=(await f.h.diagnostics()).checkpoint;
  const last=await w.select({...scope(deleted),allowLast:true});assert.ok(last.pending);
  await all(w,'钟楼');assert.deepEqual((await f.h.diagnostics()).checkpoint,checkpoint);
  assert.equal((await f.h.pending()).length,1,'Workbench never executes pending');
});

test('S03 partial zero is not exhausted, opaque cursor, empty/long queries and oversized text stay unchecked',async()=>{
  const f=await fixture(),w=new Workbench(f.h,{...options,messages:1});await w.select(scope(f.bound));
  const first=await w.search('终点');assert.equal(first.status,'partial');assert.equal(first.items.length,0);
  const stale=first.cursor;const second=await w.next(stale);assert.equal(second.scanned,2);
  await assert.rejects(w.next(stale),{code:'INVALID_CURSOR'});
  assert.equal((await all(w,'终点')).length,1);
  assert.equal((await w.search(' \u0085')).status,'empty-query');
  await assert.rejects(w.search('x'.repeat(4097)),{code:'QUERY_LIMIT'});
  const tiny=new Workbench(f.h,{...options,textBytes:4});await tiny.select(scope(f.bound));
  const limited=await tiny.search('钟楼');assert.equal(limited.status,'partial');assert.equal(limited.scanned,0);assert.equal(limited.unchecked.index,0);
  const recordLimit=await f.h.readView({kind:'record',table:'revisions',key:(await f.h.range(f.bound.target.head,0,1))[0].revision_id,objectBytes:4});
  assert.equal(recordLimit.limited,true);assert.equal(f.owner.status,'ready','read limit does not quarantine owner');
});

test('S04 append BETWEEN entry and revision read fences scan; stable control and cancel reject late return',async()=>{
  const f=await fixture();let triggered=false;
  const h={...f.h,readView:async request=>{const value=await f.h.readView(request);
    if(request.kind==='entry'&&!triggered){triggered=true;await commit(f.bridge,input('fixture',[...rows,{mes:'追加',is_user:false}]));}return value;}};
  const w=new Workbench(h,options);await w.select(scope(f.bound));await assert.rejects(w.search('钟楼'),{code:'STALE_READ'});
  assert.equal(f.owner.status,'ready');const fresh=new Workbench(f.h,options);await fresh.select(scope(f.bound));assert.equal((await all(fresh,'追加')).length,1);
  let entered,release;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const delayed=new Workbench({...f.h,readView:async r=>{const value=await f.h.readView(r);if(r.kind==='entry'){entered();await gate;}return value;}},options);
  await delayed.select(scope(f.bound));const pending=delayed.search('钟楼');await waiting;delayed.cancel();release();await assert.rejects(pending,{code:'CANCELLED'});
});

test('S04 binding-only changes and details fence stale results, without changing business state',async()=>{
  const f=await fixture(),w=new Workbench(f.h,options);await w.select(scope(f.bound));
  const result=await w.search('钟楼');const before=await f.h.diagnostics();
  await w.detail(result.items[0]);assert.deepEqual((await f.h.diagnostics()).checkpoint,before.checkpoint);
  await f.bridge.setState(f.bound.source,'paused','changed-binding');
  await assert.rejects(w.detail(result.items[0]),{code:'STALE_READ'});
  assert.equal((await f.bridge.record('binding',f.bound.source)).status,'paused');
});

test('S05/S06 summary scopes and exact anchors; older summary versions remain visibly historical',async()=>{
  const f=await fixture(),w=new Workbench(f.h,options);await w.select(scope(f.bound));
  const summaries=(await all(w,'旧摘要',{legacy:true})).filter(x=>x.kind==='summary');assert.equal(summaries.length,1);
  const detail=await w.detail(summaries[0]);assert.equal(detail.context.rows[1].content,rows[1].mes);
  assert.match(detail.sourceNotice,/未证明/);assert.equal(detail.asset.declaration,'legacy-inputs-unproven');
  const oldKey=summaries[0].key;
  await commit(f.bridge,input('fixture',rows,'第二版旧摘要'));
  await w.select(scope(f.bound));const current=await all(w,'旧摘要',{legacy:true});assert.equal(current.length,1);assert.notEqual(current[0].key,oldKey);
  const histories=await all(w,'旧摘要',{legacy:true,legacyHistory:true});assert.equal(histories.length,2);assert.equal(histories.filter(x=>x.historical).length,1);
  const extension=await commit(f.bridge,input('fixture',[...rows,{mes:'未来',is_user:false}],'未来摘要'));
  await w.select({...scope(extension),snapshot:f.bound.target.head});
  assert.equal((await all(w,'未来摘要',{legacy:true})).length,0);
  const continued=await commit(f.bridge,input('continuation',[{mes:'新User',is_user:true},{mes:'新Assistant',is_user:false}]),
    {mode:'continue',input_mode:'new-segment',branch_id:f.bound.target.branch_id});
  await w.select(scope(continued));const assets=await all(w,'旧摘要',{legacy:true});assert.equal(assets.length,1);
  const offset=await w.detail(assets[0]);assert.equal(offset.context.rows.at(-1).index,8);assert.equal(offset.context.rows.at(-1).content,'新Assistant');
  const fallback=await w.locate(assets[0]);assert.equal(fallback.available,false);
});

test('S05 missing formal anchor reference is data error, unproven higher summary is retained',async()=>{
  const f=await fixture(),w=new Workbench(f.h,options);
  const extended=input();extended.assets.push({category:'higher',source_id:'higher:unproven',anchor:null,data:{text:'无原文高层摘要'}});
  // Rebuild source fingerprint through snapshot's own constructor, not mutation.
  const {snapshot}=await import('../../bridge/source.mjs');
  await commit(f.bridge,snapshot('fixture',extended.messages,{assets:extended.assets,report:extended.report}));
  await w.select(scope(f.bound));const higher=await all(w,'无原文',{legacy:true});assert.equal(higher.length,1);
  assert.equal((await w.detail(higher[0])).context,null);
  const broken={...f.h,readView:async r=>{const value=structuredClone(await f.h.readView(r));
    if(r.kind==='record'&&r.key===recordKey('map','fixture/1'))value.value.ref.revision_id=newId('revision');return value;}};
  const wb=new Workbench(broken,options);await wb.select(scope(f.bound));const summary=(await all(wb,'旧摘要',{legacy:true}))[0];
  await assert.rejects(wb.detail(summary),{code:'NEEDS_RESOLUTION'});
});

test('S07 complete export through workbench restores raw/candidates/assets/receipts at fixed checkpoint during append',async()=>{
  const f=await fixture();const before=await f.h.diagnostics();let appended=false;
  const wrapped={...f.h,exportSnapshot:async()=>{const value=await f.h.exportSnapshot(),stream=value.stream;
    return {...value,stream:(async function*(){for await(const part of stream){if(!appended){appended=true;await commit(f.bridge,input('fixture',[...rows,{mes:'导出之后',is_user:false}]));}yield part;}})()};}};
  const w=new Workbench(wrapped,options);const exported=await w.export();assert.deepEqual(exported.checkpoint,before.checkpoint);
  assert.equal(exported.blob.size,exported.bytes);
  const restored=await restorePagedIntoEmpty(new IO(),exported.blob.stream()),h=restored.handle(),bridge=new Importer(h);
  const b=await bridge.record('binding','fixture');assert.equal(b.target.head,f.bound.target.head);
  assert.deepEqual((await bridge.record('map','fixture',1)).candidates,{values:[null,'旧swipe不可搜',null],selected:2});
  const view=new Workbench(h,options);await view.select(scope(b));assert.equal((await all(view,'钟楼')).length,4);
  assert.equal((await all(view,'导出之后')).length,0);assert.equal((await all(view,'旧摘要',{legacy:true})).length,1);
  const tiny=new Workbench(f.h,{exportBytes:100});await assert.rejects(tiny.export(),{code:'EXPORT_LIMIT'});
  await restored.close();
});

test('S06/S07 product page handlers render untrusted text, paginate, detail, fallback, export and preserve shared owner',async()=>{
  const f=await fixture();let downloaded;
  const panel=mountWorkbench({getHandle:async()=>f.h,document:documentFixture(),limits:{...options,messages:2},download:async v=>downloaded=v});
  assert.equal((await panel.perform('读取目录')).ok,true);panel.controls['档案分支'].value='0';
  assert.equal((await panel.perform('选择档案/当前快照')).ok,true);panel.controls.query.value='<img';
  const before=await f.h.diagnostics();const searched=await panel.perform('查找');assert.equal(searched.ok,true,panel.status.textContent);assert.equal(searched.value.status,'partial');
  assert.equal((await panel.perform('继续查找')).ok,true);assert.equal(panel.page.items.length,1);
  const row=panel.results.children[0];assert.equal(row.children[1].textContent,rows[3].mes);assert.equal(row.children[1].innerHTML,undefined);
  assert.equal((await row.actions.show.onclick()).ok,true);assert.match(panel.detail.textContent,/<img/);
  assert.equal((await row.actions.locate.onclick()).value.available,false);
  assert.equal((await panel.perform('导出完整库恢复包')).ok,true);assert.ok(downloaded.bytes>0);
  assert.deepEqual((await f.h.diagnostics()).checkpoint,before.checkpoint);
  await panel.perform('关闭工作台');assert.equal(f.owner.status,'ready');await commit(f.bridge,input('fixture',[...rows,{mes:'仍可导入',is_user:false}]));
});
