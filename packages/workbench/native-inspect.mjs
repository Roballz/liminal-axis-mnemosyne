import {openPagedTestStore} from '../storage/paged-tt-adapter.mjs';
import {Workbench} from './service.mjs';
import {mountWorkbench} from './panel.mjs';
const run='20260922t05inspect',namespace='mnemo-t03-paged-t05-20260922a';
const once=Symbol.for('mnemosyne.t05.inspect.20260922');
if(!globalThis[once])globalThis[once]=(async()=>{
  const out={run,type:'error',phase:'prior-close',close:false},start=Date.now();let owner,panel;
  try{
    const prior=await globalThis[Symbol.for('mnemosyne.t05.demo.20260922')];
    if(!prior?.close.confirmed)throw Error('Prior close not confirmed');
    out.phase='open-existing';owner=await openPagedTestStore(globalThis.__TAURITAVERN__.api.db,namespace);
    const h=owner.handle(),before=await h.diagnostics();
    out.phase='catalog-service';const w=new Workbench(h);const catalog=await w.catalog();out.catalogCount=catalog.items.length;
    out.phase='catalog-page';panel=mountWorkbench({getHandle:async()=>h});const result=await panel.perform('读取目录');
    out.pageOK=result.ok;out.pageCode=result.code??null;if(!result.ok)out.pageMessage=panel.status.textContent;
    const after=await h.diagnostics();out.checkpointUnchanged=before.checkpoint.hash===after.checkpoint.hash;
    out.type=result.ok?'done':'error';
  }catch(e){out.code=e.code??e.name;out.message=e.message;}
  finally{panel?.close();if(owner){await owner.settled();await owner.close();out.close=owner.status==='closed';}out.elapsedMs=Date.now()-start;}
  await fetch('http://127.0.0.1:19375/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(out)});
  return out;
})();
