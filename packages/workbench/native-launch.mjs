import { runNative } from './native-demo.mjs';
const once=Symbol.for('mnemosyne.t05.demo.20260922');
if(!globalThis[once]) {
  globalThis[once]=(async()=>{
    const result=await runNative();
    const status=document.createElement('pre');status.textContent=JSON.stringify(result,null,2);
    status.style.cssText='position:fixed;inset:10vh 10vw;z-index:10002;background:#20242d;color:white;padding:12px;overflow:auto';
    const close=document.createElement('button');close.textContent='关闭演示回执';close.onclick=()=>status.remove();status.append(close);document.body.append(status);
    await fetch('http://127.0.0.1:19375/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
    return result;
  })();
}
