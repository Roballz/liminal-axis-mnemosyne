import { Importer } from './importer.mjs';
import { rawMessage, snapshot, projectLegacy } from './source.mjs';
import { digest } from './records.mjs';
import { openPagedTestStore } from '../storage/paged-tt-adapter.mjs';
import { requireThat as check } from '../contracts/primitives.mjs';

// No model, injection, chat save or plugin mutation API. Only synthetic target stores.
export async function runNativeDemo(api, run, host = globalThis) {
  check(/^[a-z0-9]+$/.test(run),'INVALID_SCHEMA','Synthetic run ID');
  const sourceNamespace=`mnemo-t03-paged-t04-${run}-source`, targetNamespace=`mnemo-t03-paged-t04-${run}-restored`;
  const actual = host.STBaiBaiBook;
  const capability = {apiVersion:actual?.apiVersion??null,pluginVersion:actual?.pluginVersion??null,
    getFloor:typeof actual?.getFloor==='function',getSnapshot:typeof actual?.getSnapshot==='function',
    getHistory:typeof actual?.getHistory==='function',subscribe:typeof actual?.subscribe==='function'};
  const rows=[{mes:'虚构测试：钟楼的门开了吗？',is_user:true},{mes:'虚构测试：铜钥匙打开了钟楼。',is_user:false}];
  const messages=rows.map(rawMessage), chat={id:'fictional-native',length:2};
  const bbs={apiVersion:1,pluginVersion:'synthetic-v1',
    getSnapshot:()=>({revision:1,chat,coverage:{complete:true,missingAiFloors:[]},items:[],scenes:[],lifeDetails:[]}),
    getHistory:()=>({revision:1,chat,nodes:[]}),
    getFloor:floor=>({revision:1,chat,floor,omitted:false,memory:{id:'fixture-memory',valid:true,summary:'虚构测试：钥匙打开钟楼。'}})};
  const before=digest(rows), input=snapshot('synthetic-native',messages,projectLegacy(bbs,messages));
  // Refresh can interrupt JS after a native commit but before its receipt reaches
  // the collector. Inspect the exact namespace and recover the original session.
  const inspect=async namespace=>{const native=await api.open(namespace,{dim:2,syncMode:'full',autoBuildQuiver:false});
    try{await native.flush();return(await native.stats()).nodeCount;}finally{await native.close();}};
  const sourceNodes=await inspect(sourceNamespace);
  const owner=await openPagedTestStore(api,sourceNamespace,{create:sourceNodes===0});
  let restored;
  try{
    const importer=new Importer(owner.handle());
    await importer.recoverPending();
    const report=(await importer.preview(input)).report;
    const bound=await importer.confirm(await importer.preview(input));
    const again=await importer.confirm(await importer.preview(input));
    check(bound.target.head===again.target.head,'NEEDS_RESOLUTION','Duplicate import advanced Head');
    const h=await owner.recover(),reopened=new Importer(h);
    check((await reopened.record('binding',input.source)).status==='complete','NEEDS_RESOLUTION','Cold-open receipt');
    const targetNodes=await inspect(targetNamespace);
    restored=await openPagedTestStore(api,targetNamespace,targetNodes===0?{restore:await h.export()}:{});
    await restored.handle().audit();
    const receipt=await new Importer(restored.handle()).record('binding',input.source);
    check(receipt.target.head===bound.target.head,'NEEDS_RESOLUTION','Restore mapping differs');
    const refs=await restored.handle().range(receipt.target.head,0,2);
    for(let i=0;i<2;i++)check((await restored.handle().read('revisions',refs[i].revision_id)).content===rows[i].mes,'NEEDS_RESOLUTION','Raw body differs');
    check(digest(rows)===before,'NEEDS_RESOLUTION','Source changed');
    return{type:'done',run,sourceNamespace,targetNamespace,capability,report,sourceReadOnly:true,sourceHash:before,
      originals:2,summaries:1,reopened:true,restored:true,resumedExistingSource:sourceNodes>0,
      resumedExistingTarget:targetNodes>0,modelRequests:0,injections:0,sourceWrites:0};
  }finally{if(restored)await restored.close();await owner.close();}
}
