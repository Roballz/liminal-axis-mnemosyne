import test from 'node:test';
import assert from 'node:assert/strict';
import { Demo } from '../controller.mjs';
import { mountPanel } from '../panel.mjs';
import { IO,input,rows } from '../../workbench/tests/fixture.mjs';
import { PagedCoordinator } from '../../storage/paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../../storage/paged-recovery.mjs';
import { openPagedTestStore } from '../../storage/paged-tt-adapter.mjs';
import { validateRecord,recordKey } from '../../bridge/records.mjs';

async function fixture() {
  const io=new IO(),owner=new PagedCoordinator(io),h=await owner.create();
  const source={value:input(),async capture(){return structuredClone(this.value);},
    async identity(){return {source:this.value.source};},async guard(v){
      assert.equal(v.source,this.value.source);assert.equal(v.generation,this.value.generation);
    }};
  const demo=new Demo(h,source);demo.workbench.limits.milliseconds=10000;
  return {io,owner,h,source,demo};
}
async function create(demo,name='钟楼档案'){await demo.preview(name);return demo.confirm();}
async function all(demo,q,options={}) {
  const out=[];let page=await demo.search(q,options),n=0;
  for(;;){out.push(...page.items);if(!page.cursor)return out;assert.ok(++n<30);page=await demo.next();}
}

test('manual create, exact binding, reopen, second archive and full backup restore',async()=>{
  const f=await fixture(),a=await create(f.demo);assert.equal(a.name,'钟楼档案');
  assert.equal((await f.demo.current()).archive.source,a.source);
  assert.equal((await all(f.demo,'铜钥匙')).length,2);
  await assert.rejects(f.demo.preview('重复'),e=>e.code==='ALREADY_BOUND');
  f.source.value=input('second',[{mes:'第二库独有',is_user:true}],null);
  await assert.rejects(f.demo.preview('',{sync:true}),e=>e.code==='INVALID_SCOPE');
  const b=await create(f.demo,'第二库');assert.notEqual(a.branch,b.branch);
  assert.equal((await all(f.demo,'钟楼')).length,0);
  const exported=await f.demo.export();assert.ok(exported.bytes>0);
  await f.owner.close();const reopened=new PagedCoordinator(f.io),h=await reopened.recover();
  const again=new Demo(h,f.source);assert.equal((await again.catalog()).items.length,2);
  await again.select(a);assert.ok((await all(again,'钟楼')).length>0);
  const restored=await restorePagedIntoEmpty(new IO(),[new Uint8Array(await exported.blob.arrayBuffer())]);
  const restoredDemo=new Demo(restored.handle(),f.source);
  assert.deepEqual((await restoredDemo.catalog()).items.map(a=>a.name).sort(),['第二库','钟楼档案'].sort());
});

test('latest summary selection retains unchanged summaries after append and excludes removed summaries',async()=>{
  const f=await fixture();await create(f.demo);
  f.source.value=input('fixture',[...rows,{mes:'新增正文',is_user:false}]);
  await f.demo.preview('',{sync:true});await f.demo.confirm();
  assert.equal((await all(f.demo,'旧摘要')).length,1,'unchanged summary remains searchable');
  const hit=(await all(f.demo,'旧摘要'))[0],detail=await f.demo.detail(hit);
  assert.match(detail.sourceNotice,/未证明/);
  f.source.value=input('fixture',[...rows.slice(0,1),{mes:'替换后的当前正文',is_user:false}],null);
  await f.demo.preview('',{sync:true});await f.demo.confirm();
  assert.equal((await all(f.demo,'旧摘要')).length,0);
  assert.equal((await all(f.demo,'铜钥匙',{legacy:false})).length,0,'old body is not the current search scope');
  assert.equal((await all(f.demo,'替换后')).length,1);
});

test('Swipe opt-in is scoped, paged, labeled and cannot reuse old results or candidates after sync',async()=>{
  const f=await fixture();await create(f.demo);f.demo.workbench.limits.messages=2;
  assert.equal((await all(f.demo,'旧swipe')).length,0);
  const hits=await all(f.demo,'旧swipe',{swipes:true});assert.equal(hits.length,1);
  assert.equal(hits[0].kind,'swipe');assert.deepEqual(hits[0].slots,[1]);
  assert.equal((await f.demo.detail(hits[0])).candidates[0].content,'旧swipe不可搜');
  await all(f.demo,'旧swipe',{swipes:false});
  await assert.rejects(f.demo.detail(hits[0]),e=>e.code==='STALE_READ');
  f.source.value=input('fixture',rows.map((r,i)=>i===1?{...r,swipes:['新候选'],swipe_id:0}:r));
  await f.demo.preview('',{sync:true});await f.demo.confirm();
  assert.equal((await all(f.demo,'旧swipe',{swipes:true})).length,0);
  assert.equal((await all(f.demo,'新候选',{swipes:true})).length,1);
});

test('preview is invalidated by content change; interrupted catalog publication fails closed and is resumable',async()=>{
  const f=await fixture();await f.demo.preview('测试');
  f.source.value=input('fixture',rows,'修改摘要');
  await assert.rejects(f.demo.confirm(),e=>e.code==='VERSION_CONFLICT');
  assert.equal((await f.demo.catalog()).items.length,0);
  const archive=await create(f.demo);
  f.source.value=input('fixture',rows,'再次修改');
  await f.demo.preview('',{sync:true});
  const transact=f.demo.importer.transact.bind(f.demo.importer);
  f.demo.importer.transact=options=>{
    if(options.records.some(r=>r.value.type==='demoArchive'))throw Error('simulated publication gap');
    return transact(options);
  };
  await assert.rejects(f.demo.confirm(),/publication gap/);
  await assert.rejects(f.demo.select(archive),e=>e.code==='VERSION_CONFLICT');
  f.demo.importer.transact=transact;
  await f.demo.preview(archive.name,{sync:true});const fixed=await f.demo.confirm();
  await f.demo.select(fixed);assert.equal((await all(f.demo,'再次修改')).length,1);
});

test('versioned metadata validates name and bounded summary pointers',async()=>{
  const f=await fixture(),a=await create(f.demo),key=recordKey('demoArchive',a.source);
  assert.doesNotThrow(()=>validateRecord(key,a));
  for(const invalid of [{...a,name:''},{...a,version:2},{...a,assets:['bad']},{...a,assets:Array(513).fill(a.assets[0])}])
    assert.throws(()=>validateRecord(key,invalid),e=>e.code==='INVALID_SCHEMA');
});

test('createIfEmpty shares owner, reopens persisted library, and never replaces nonempty invalid storage',async()=>{
  const nodes=new Map();let writes=0;
  const api={open:async()=>({get:async id=>nodes.get(id)??null,upsert:async(id,v,payload)=>{writes++;nodes.set(id,{payload});},
    flush:async()=>{},stats:async()=>({nodeCount:nodes.size}),close:async()=>{}})};
  const namespace='mnemo-t03-paged-demo-test';
  const [a,b]=await Promise.all([openPagedTestStore(api,namespace,{createIfEmpty:true}),openPagedTestStore(api,namespace,{createIfEmpty:true})]);
  assert.equal(a,b);const count=writes;await a.close();
  const c=await openPagedTestStore(api,namespace,{createIfEmpty:true});assert.equal(writes,count);await c.close();
  nodes.clear();nodes.set(2,{payload:{invalid:true}});
  await assert.rejects(openPagedTestStore(api,namespace,{createIfEmpty:true}));assert.equal(writes,count);
});

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.value='';this.textContent='';this.disabled=false;this.hidden=false;}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}
  attachShadow(){this.shadow=new Element('shadow');return this.shadow;}setAttribute(){}remove(){this.removed=true;}
  focus(){this.focused=true;}get options(){return this.children;}click(){return this.onclick?.();}
}
const hostFixture=()=>({document:{body:new Element('body'),createElement:t=>new Element(t)},
  localStorage:{getItem:()=>null,setItem:()=>{}},addEventListener(){},removeEventListener(){},innerWidth:1000,innerHeight:900});
async function idle(c){const deadline=Date.now()+30000;while(Date.now()<deadline){await new Promise(r=>setTimeout(r,10));if(!c.search.disabled)return;}throw Error('UI did not settle');}

test('actual panel buttons create, search, detail, clear on scope change and reject late detail',async()=>{
  const f=await fixture(),host=hostFixture();const ui=mountPanel({host,connect:async()=>f.demo,recover:async()=>f.demo}),c=ui.controls;
  ui.open();await idle(c);c.name.value='面板库';c.create.click();await idle(c);
  assert.equal(c.preview.hidden,false);c.confirm.click();await idle(c);assert.equal(f.demo.selected.name,'面板库');
  c.query.value='旧swipe';c.scopeDropdown.trigger.onkeydown({key:'ArrowDown',preventDefault(){}});
  assert.equal(c.scopeDropdown.menu.hidden,false);assert.equal(c.scopeDropdown.menu.children[0].focused,true);
  c.scopeDropdown.menu.onkeydown({key:'ArrowDown',target:c.scopeDropdown.menu.children[0],preventDefault(){}});
  assert.equal(c.scopeDropdown.menu.children[1].focused,true);c.scopeDropdown.menu.children[1].click();
  assert.equal(c.scope.value,'swipes');assert.equal(c.scopeDropdown.menu.hidden,true);
  c.searchRow.onsubmit({preventDefault(){}});await idle(c);
  assert.equal(c.results.children.length,1);c.results.children[0].click();await idle(c);assert.equal(c.detail.hidden,false);
  c.scopeDropdown.trigger.click();c.scopeDropdown.menu.children[0].click();assert.equal(c.results.children.length,0);assert.equal(c.detail.hidden,true);assert.equal(c.next.disabled,true);
  c.scope.value='swipes';c.searchRow.onsubmit({preventDefault(){}});await idle(c);
  const original=f.demo.detail.bind(f.demo);let release;
  f.demo.detail=async hit=>{const result=await original(hit);await new Promise(r=>{release=r;});return result;};
  c.results.children[0].click();for(let i=0;i<1000&&!release;i++)await new Promise(r=>setImmediate(r));
  assert.ok(release);ui.invalidate();release();await idle(c);assert.equal(c.detail.hidden,true);assert.equal(c.results.children.length,0);
  ui.dispose();assert.equal(ui.root.removed,true);
});

test('panel sync button changes only bound current chat and clears prior cursor and detail',async()=>{
  const f=await fixture();await create(f.demo);const ui=mountPanel({host:hostFixture(),connect:async()=>f.demo,recover:async()=>f.demo}),c=ui.controls;
  ui.open();await idle(c);c.query.value='钟楼';c.searchRow.onsubmit({preventDefault(){}});await idle(c);
  c.results.children[0].click();await idle(c);assert.equal(c.detail.hidden,false);
  f.source.value=input('fixture',[{mes:'同步后的唯一正文',is_user:true}],null);
  c.sync.click();await idle(c);assert.equal(c.results.children.length,0);assert.equal(c.detail.hidden,true);assert.equal(c.next.disabled,true);
  c.confirm.click();await idle(c);c.query.value='钟楼';c.searchRow.onsubmit({preventDefault(){}});await idle(c);
  assert.match(c.results.children[0].textContent,/没有找到/);ui.dispose();
});
