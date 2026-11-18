import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { parseHTML } from 'linkedom/worker';
import 'fake-indexeddb/auto';
import * as db from '../lib/db.js';
import { reader } from '../lib/dom.js';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) {
    for(let i=0;i<180;i++){const result=await fn();if(result)return result;await delay(10);}
    throw Error('等待界面或事件超时');
}
function setup() {
    const {document,Event,HTMLElement,HTMLSelectElement,MutationObserver}=parseHTML(
        '<html><body><div id="extensions_settings"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_block"></div></div></div></body></html>');
    Object.assign(globalThis,{document,MutationObserver,innerWidth:390,innerHeight:800});
    const store=new Map();
    globalThis.localStorage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
    // Supply browser surfaces missing in the headless DOM implementation.
    HTMLElement.prototype.showModal=function(){this.open=true;};
    HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
    HTMLElement.prototype.setPointerCapture=HTMLElement.prototype.releasePointerCapture=function(){};
    const descriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
    Object.defineProperty(HTMLSelectElement.prototype,'value',{...descriptor,set(v){
        for(const o of this.options){if(o.value===v)o.setAttribute('selected','');else o.removeAttribute('selected');}
    }});
    const floor=document.querySelector('.mes');document.elementsFromPoint=()=>[floor];
    const listeners=new Map();
    const names=['CHAT_CHANGED','APP_READY','MESSAGE_RECEIVED','MESSAGE_UPDATED','MESSAGE_SENT','MESSAGE_DELETED','MESSAGE_EDITED','MESSAGE_SWIPED','GENERATION_ENDED'];
    const ctx={getCurrentChatId:()=>'synthetic',characterId:1,chat:[{mes:'开场线索',send_date:1}],
        eventTypes:Object.fromEntries(names.map(n=>[n,n])),eventSource:{on:(name,fn)=>listeners.set(name,fn)}};
    globalThis.SillyTavern={getContext:()=>ctx};
    // Execute the shipped browser worker module in a real separate Node thread.
    const workers=[];
    globalThis.Worker=class {
        constructor(url){
            const body=`import { parentPort } from 'node:worker_threads';globalThis.self=globalThis;
            self.postMessage=m=>parentPort.postMessage(m);await import(${JSON.stringify(url.href)});
            parentPort.on('message',data=>self.onmessage({data}));`;
            this.worker=new NodeWorker(new URL('data:text/javascript,'+encodeURIComponent(body)),{type:'module'});
            this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',e=>this.onerror?.(e));workers.push(this.worker);
        }
        postMessage(m){this.worker.postMessage(m);} terminate(){this.worker.terminate();}
    };
    return {document,ctx,emit:(name,id)=>listeners.get(name)?.(id),workers};
}
test('正常入口：气泡收藏、当场新建、多选与换批、手势、三主题、后台陌生名称归类',async t=>{
    const {document:d,ctx,emit,workers}=setup();
    t.after(async()=>{for(const w of workers)await w.terminate();});
    const key=JSON.stringify(['character',1,'synthetic']);
    await db.mutateBook(key,b=>{b.tags=Array.from({length:15},(_,i)=>({name:'词'+i,last:Date.now(),score:20-i}));});
    const {activate}=await import('../index.js');activate();
    await until(()=>d.querySelector('.mn-floor-action'));await delay(30);
    assert.equal(d.querySelectorAll('.mn-head').length,1);
    const clickText=(host,text)=>{const el=[...host.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(el,text);el.click();};
    const head=d.querySelector('.mn-head');head.click();
    let dialog=await until(()=>d.querySelector('dialog'));assert.ok(dialog.textContent.includes('开场线索'));
    dialog.querySelector('textarea').value='收藏备注';
    for(const [i,value] of ['人物甲','合集乙'].entries()){
        [...dialog.querySelectorAll('button')].filter(b=>b.textContent==='＋ 新建')[i].click();
        const inline=dialog.querySelectorAll('.mn-inline')[i];inline.querySelector('input').value=value;clickText(inline,'添加');
    }
    clickText(dialog,'换一批');clickText(dialog,'词11');
    dialog.querySelector('input[placeholder*="逗号"]').value='自填';
    clickText(dialog,'确认收藏');await until(()=>!d.querySelector('dialog'));
    const note=(await db.list(key,'note')).rows[0];assert.deepEqual([note.people,note.folders,note.tags],[['人物甲'],['合集乙'],['词11','自填']]);
    d.querySelector('.mn-floor-action').click();dialog=await until(()=>d.querySelector('dialog'));assert.ok(dialog.textContent.includes('编辑收藏'));
    dialog.close();
    head.onpointerdown({isPrimary:true,button:0,pointerId:1,clientX:382,clientY:300});
    head.onpointermove({pointerId:1,clientX:270,clientY:304});
    head.onpointerup({pointerId:1,clientX:270,clientY:304});
    assert.equal(d.querySelector('#mnemosyne-notes').dataset.open,'yes');
    await until(()=>d.querySelector('.mn-entry'));
    clickText(d,'按人物');await until(()=>[...d.querySelectorAll('.mn-group')].some(b=>b.textContent==='人物甲'));
    clickText(d,'人物甲');await until(()=>[...d.querySelectorAll('.mn-group')].some(b=>b.textContent==='合集乙'));
    clickText(d,'设置');for(const [name,theme] of [['深蓝 · 深色','dark'],['墨绿 · 霓虹','neon'],['白绿 · 浅色','light']]){
        clickText(d,name);assert.equal(d.querySelector('#mnemosyne-notes').dataset.theme,theme);
    }
    d.querySelector('.mn-panel [aria-label="关闭"]').click();
    ctx.chat.push({mes:'<div data-nvwa-ui="新信箱"><div>21:08</div>晚安<button>草稿</button></div>',send_date:2});
    emit('MESSAGE_RECEIVED',1);emit('GENERATION_ENDED',1);
    const toast=await until(()=>[...d.querySelectorAll('.mn-toast')].find(x=>x.textContent.includes('待归类')));
    toast.click();dialog=await until(()=>d.querySelector('dialog'));
    dialog.querySelector('select').value='合集乙';clickText(dialog,'归类并记住此名称');
    await until(async()=>(await db.list(key,'block',{folder:'合集乙'})).rows.length===1);
    clickText(d,'打开 Mnemosyne记事簿');clickText(d,'消息');await until(()=>d.querySelector('.mn-group')?.textContent==='合集乙');
    clickText(d,'合集乙');await until(()=>d.querySelector('.mn-entry')?.textContent.includes('新信箱'));
    d.querySelector('.mn-entry').click();await until(()=>d.querySelector('.mn-reading'));
    assert.match(d.querySelector('.mn-reading').textContent,/21:08晚安/);assert.ok(!d.querySelector('.mn-reading').textContent.includes('草稿'));
    const safe=reader('<script>secret</script><img src="x" onerror="noop()"><div onclick="x()">安全</div>');
    assert.equal(safe.textContent,'安全');assert.equal(safe.querySelector('script,img,[onclick]'),null);
});
