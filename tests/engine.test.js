import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import * as db from '../lib/db.js';
import { Engine } from '../lib/engine.js';
import { compile,extract } from '../lib/extract.js';
import { blankFolder,digest,identity } from '../lib/model.js';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function idle(e) {for(let i=0;i<1000;i++){if(!e.running&&!e.history&&!e.pending.size)return;await pause(4);}throw Error('index did not settle');}
const msg=(i,marked=true)=>({mes:marked?'<div data-nvwa-ui="测试信箱"><div>private-line-'+i+'</div></div>':'普通正文 '+i,send_date:'D'+i});
function fixture(messages,key=crypto.randomUUID()){
    const calls=[],alerts=[],reads=[],errors=[];
    const host={key,active:()=>true,sync:async()=>messages.length,size:()=>messages.length,
        read:async(a,b)=>{reads.push([a,b]);return messages.slice(a,b);}};
    const parser={run:async(batch,book)=>{calls.push(batch.length);return batch.map(m=>extract(m,compile(book)));},stop(){}};
    const engine=new Engine(host,{zero:()=>true,notice:(...args)=>alerts.push(args),changed(){},error:e=>errors.push(e.message)},parser);
    return {engine,host,reads,calls,alerts,errors,key};
}
test('历史分页最多16楼，重开只校验尾部，空闲不重复读，编辑和 swipe 只替换单楼',async()=>{
    const messages=Array.from({length:1700},(_,i)=>msg(i,i%50===0));
    const f=fixture(messages);await f.engine.init();await db.mutateBook(f.key,b=>b.folders.push({...blankFolder('信箱'),names:['测试信箱']}));
    f.engine.book=await db.getBook(f.key);f.engine.open();await idle(f.engine);
    assert.equal(f.errors.length,0);assert.equal(Math.max(...f.calls),16);assert.equal(f.alerts.length,0);
    assert.equal((await db.list(f.key,'block',{folder:'信箱'})).rows.length,34);
    assert.ok(!JSON.stringify((await db.list(f.key,'block')).rows).includes('private-line'));
    f.engine.dispose();const b=fixture(messages,f.key);await b.engine.init();b.engine.open();await idle(b.engine);
    assert.equal(b.calls.length,0);assert.deepEqual(b.reads,[[1699,1700]]);
    messages.push(msg(1700));b.engine.dirty(1700,true);b.engine.dirty(1700,true);await idle(b.engine);
    assert.deepEqual(b.calls,[1]);assert.equal(b.alerts.length,1);
    b.engine.dirty(1700,true);await idle(b.engine);assert.equal(b.alerts.length,1);assert.deepEqual(b.calls,[1]);
    messages[1700]={...msg(1700,false),swipe_id:1};b.engine.dirty(1700,true);await idle(b.engine);
    assert.equal((await db.list(f.key,'block')).rows.length,34);
    assert.equal(b.alerts.length,1);assert.equal(b.errors.length,0);b.engine.dispose();
});
test('已有标记添加别名，只回读候选楼层',async()=>{
    const messages=Array.from({length:48},(_,i)=>msg(i,i===7||i===29));
    const f=fixture(messages);await f.engine.init();f.engine.open();await idle(f.engine);f.reads.length=0;
    f.engine.book=await db.mutateBook(f.key,b=>b.folders.push({...blankFolder('归档'),names:['测试信箱']}),'existing');
    f.engine.progress=await db.getProgress(f.key);f.engine.open();await idle(f.engine);
    assert.deepEqual(f.reads,[[7,8],[29,30]]);assert.equal((await db.list(f.key,'block',{folder:'归档'})).rows.length,2);
    f.engine.dispose();
});
test('并发切档使旧写入失效，收藏来源移动或删除不会串到同号正文',async()=>{
    const items=[msg(0),msg(1),msg(2)],f=fixture(items);await f.engine.init();
    const row={id:'n',identity:identity(items[1]),hash:digest(items[1].mes),floor:1,note:'手写备注',tags:['词'],people:['人'],folders:['集']};
    await db.saveNote(f.key,row,()=>{});items.shift();
    assert.equal((await f.engine.source(row,true)).floor,0);items.shift();
    await assert.rejects(f.engine.source(row,true),/已移除/);
    assert.equal((await db.list(f.key,'note')).rows[0].note,'手写备注');
    let release;f.engine.parser.run=()=>new Promise(res=>{release=res;});f.engine.open();
    while(!release)await pause(1);f.engine.dispose();release([{rows:[]}]);await pause(5);
    assert.equal((await db.getProgress(f.key)).next,0);
    assert.equal((await db.list('other-chat','note')).rows.length,0);
});
test('多标签交叉筛选、双向分组、翻页及备份往返',async()=>{
    const k=crypto.randomUUID();
    for(let i=0;i<41;i++)await db.saveNote(k,{id:String(i),floor:i,people:i%2?['甲','乙']:[],folders:['A','B'],tags:['线索'],note:String(i)},()=>{});
    assert.deepEqual(await db.groups(k,'note','folder','甲'),['A','B']);
    assert.deepEqual(await db.groups(k,'note','person','B'),['','乙','甲']);
    const filter={tag:'线索',folder:'B',person:'甲'};
    const a=await db.list(k,'note',filter,null,12),b=await db.list(k,'note',filter,a.rows.at(-1).order,12);
    assert.equal(a.more,true);assert.equal(b.more,false);assert.equal(new Set([...a.rows,...b.rows].map(r=>r.id)).size,20);
    const copy=await db.backup(k);assert.equal(copy.notes.length,41);await db.restore(k,copy);
    await assert.rejects(db.restore('other',copy),/不匹配/);assert.equal((await db.list(k,'note')).rows.length,36);
});
test('混合命中不重复弹零命中，取消未完成的旧回复并重新扫描',async()=>{
    const messages=[msg(0)], f=fixture(messages);
    await f.engine.init();
    messages[0].mes='<div>无标记</div>';f.engine.dirty(0,true);await idle(f.engine);
    assert.equal(f.alerts.length,1);assert.equal(f.alerts[0][1].unmarkedDiv,true);
    messages[0].mes='纯叙述';f.engine.dirty(0,true);await idle(f.engine);assert.equal(f.alerts.length,1);
    let release;
    const normal=f.engine.parser.run;
    f.engine.parser.run=(messages,b)=>new Promise(resolve=>{const result=messages.map(m=>extract(m,compile(b)));release=()=>resolve(result);});
    messages[0]=msg(9);f.engine.dirty(0,true);while(!release)await pause(2);
    messages[0]=msg(10,false);f.engine.dirty(0,true);f.engine.parser.run=normal;release();
    await idle(f.engine);assert.equal(f.alerts.length,1);assert.equal((await db.list(f.key,'block')).rows.length,0);f.engine.dispose();
});
test('相同发送时间发生移楼时优先精确正文，取消仅删除该条收藏',async()=>{
    const data=[msg(0),msg(1)];data[1].send_date=data[0].send_date;
    const f=fixture(data);await f.engine.init();
    const n={id:'one',floor:0,identity:identity(data[0]),hash:digest(data[0].mes),people:[],tags:[],folders:[]};
    await db.saveNote(f.key,n,()=>{});data.reverse();assert.equal((await f.engine.source(n,true)).floor,1);
    await db.removeNote(f.key,n.id);assert.equal((await db.list(f.key,'note')).rows.length,0);
    assert.equal(data.length,2);f.engine.dispose();
});
