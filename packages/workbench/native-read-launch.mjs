import {runNative} from './native-read-existing.mjs';
import {PagedCoordinator as Cached} from '/packages/storage/paged-coordinator.mjs';
import {PagedCoordinator as Fresh} from '../storage/paged-coordinator.mjs';
const once=Symbol.for('mnemosyne.t05.read-existing.20260922');
if(!globalThis[once])globalThis[once]=(async()=>{
  const status=document.getElementById('mnemosyne-t05-read-status');
  const result=await runNative();
  result.runtime={oldURLReadView:typeof new Cached({}).handle().readView==='function',
    versionedURLReadView:typeof new Fresh({}).handle().readView==='function'};
  if(status)status.textContent=JSON.stringify(result,null,2);
  globalThis[Symbol.for('mnemosyne.t05.read-receipt.20260922')]=result;
  try{await fetch('http://127.0.0.1:19375/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});}
  catch{if(status)status.textContent+='\n本地回执传送失败，结果已留在页面；不要重复运行。';}
  return result;
})();
