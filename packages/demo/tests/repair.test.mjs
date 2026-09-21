import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLegacy,rawMessage} from '../../bridge/source.mjs';
import {Pages,PAGE_LIMITS} from '../../storage/pages.mjs';
import {mountPanel} from '../panel.mjs';

test('hidden 500-floor chat imports every valid L0 through public semantic role, not only visible tail',()=>{
  const raw=Array.from({length:500},(_,i)=>({mes:'虚构正文'+i,is_user:i%2===0,is_system:i<480}));
  const before=JSON.stringify(raw),messages=raw.map(rawMessage),chat={id:'fiction',length:500};
  const state={revision:1,chat,coverage:{complete:false,missingAiFloors:[3,5]}};
  let calls=0;
  const api={apiVersion:1,getSnapshot:()=>state,getHistory:()=>({revision:1,chat,nodes:[
    {id:'l1',kind:'comp',level:1,text:'一级',floorStart:0,floorEnd:21},
    {id:'l4',kind:'comp',level:4,text:'四级',floorStart:0,floorEnd:479}]}),
    getFloor:floor=>{calls++;return{revision:1,chat,floor,role:floor%2?'assistant':'user',omitted:floor===1,
      memory:{stored:floor!==5,valid:![1,3,5].includes(floor),id:'leaf'+floor,summary:'原始摘要'+floor,delta:{secret:'DO-NOT-COPY'}}};}};
  const result=projectLegacy(api,messages);
  assert.equal(calls,500);assert.equal(result.assets.filter(a=>a.category==='summary').length,247);
  assert.deepEqual(result.report.summaryCounts,{floors:500,assistant:250,stored:249,l0:247,omitted:1,invalid:1,missing:1,hiddenL0:237,higherSelected:2});
  assert.deepEqual(result.assets.filter(a=>a.category==='higher').map(a=>a.data.level),[1,4]);
  assert.equal(JSON.stringify(raw),before);assert.ok(!JSON.stringify(result).includes('DO-NOT-COPY'));
  assert.equal(messages[7].role,'system','raw role is not silently rewritten');
});

test('immutable put cache avoids repeat IO, remains bounded, and cold path checks corruption',async()=>{
  const nodes=new Map();let reads=0,writes=0;
  const io={get:async slot=>{reads++;return nodes.get(slot)??null;},put:async(slot,p)=>{writes++;nodes.set(slot,p);}};
  const p=new Pages(io),body={kind:'scalar',value:'same'},ref=await p.put(body);
  const initial={reads,writes};assert.deepEqual(await p.put(body),ref);assert.deepEqual({reads,writes},initial);
  for(let i=0;i<PAGE_LIMITS.cache+1;i++)await p.put({i});assert.ok(p.cacheSize<=PAGE_LIMITS.cache);
  const prior=reads;await p.put(body);assert.equal(reads,prior+1,'evicted value checks physical storage');
  p.clearCache();nodes.set(ref.slot,{bad:true});
  await assert.rejects(p.put(body),e=>e.code==='ID_COLLISION');
});

class Element {
  constructor(){this.children=[];this.style={};this.dataset={};this.hidden=false;this.value='';}
  setAttribute(){}append(...n){this.children.push(...n);}attachShadow(){return new Element();}
  replaceChildren(...n){this.children=n;}get options(){return this.children;}remove(){this.removed=true;}
  getBoundingClientRect(){return{x:50,y:80,width:44,height:44};}setPointerCapture(){}
}
test('bubble is out of host flow, dragging stays in viewport and does not open panel',()=>{
  const host={document:{body:new Element(),createElement:()=>new Element()},localStorage:{getItem:()=>null},
    innerWidth:800,innerHeight:600,addEventListener(){},removeEventListener(){}};
  let connections=0;const ui=mountPanel({host,connect:async()=>{connections++;}}),b=ui.controls.bubble;
  assert.match(ui.root.style.cssText,/position:fixed!important/);assert.equal(b.textContent,'M');
  b.onpointerdown({button:0,clientX:50,clientY:80,pointerId:1});
  b.onpointermove({clientX:1000,clientY:900});b.onpointerup();b.onclick();
  assert.equal(b.style.left,'752px');assert.equal(b.style.top,'552px');assert.equal(connections,0);
  assert.equal(ui.controls.panel.hidden,true);ui.dispose();assert.equal(ui.root.removed,true);
});
