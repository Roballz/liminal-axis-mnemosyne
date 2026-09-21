import { TTSource } from '../bridge/source.mjs';
import { openPagedTestStore } from '../storage/paged-tt-adapter.mjs';
import { Demo } from './controller.mjs';
import { mountPanel } from './panel.mjs';

export const VERSION='0.1.1';
export const NAMESPACE='mnemo-t03-paged-manual-demo-v1';
export async function start(host=globalThis) {
  await host.__TAURITAVERN__?.ready;
  await host.__mnemosyneDaily?.dispose();
  const source=new TTSource(host);let owner=null,demo=null,opening=null,disposed=false;
  const connect=()=>opening??=(async()=>{
    const api=host.__TAURITAVERN__?.api?.db;
    if(!api)throw Error('此 demo 需要支持本机 B 数据库 API 的 TauriTavern');
    owner=await openPagedTestStore(api,NAMESPACE,{createIfEmpty:true});
    demo=new Demo(owner.handle(),source);
    if(disposed){await owner.close();throw Error('入口已关闭');}
    return demo;
  })().catch(e=>{opening=null;throw e;});
  const recover=async()=>{
    if(!owner)await connect();
    if(owner.status!=='ready')await owner.recover();
    demo=new Demo(owner.handle(),source);opening=Promise.resolve(demo);
    await demo.recoverPending();return demo;
  };
  const panel=mountPanel({host,connect,recover,version:VERSION});
  const unsubscribe=source.subscribe(()=>{demo?.invalidate();panel.invalidate();});
  const dispose=async()=>{
    if(disposed)return;disposed=true;unsubscribe();demo?.close();panel.dispose();
    host.removeEventListener('pagehide',dispose);host.removeEventListener('unload',dispose);
    if(owner){await owner.settled();await owner.close();}
  };
  host.addEventListener('pagehide',dispose);host.addEventListener('unload',dispose);
  host.__mnemosyneDaily={dispose};return host.__mnemosyneDaily;
}
