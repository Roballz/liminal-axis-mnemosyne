import { digest } from './records.mjs';
import { requireThat as check } from '../contracts/primitives.mjs';

// Real current TT chat + real BaiBai API + the panel's actual button handlers.
// Only small user-approved isolated input; no fixture API or source mutations.
export async function runLiveRead(panel,host,run) {
  check(/^[a-z0-9]+$/.test(run),'INVALID_SCHEMA','Run ID');
  const rows=host.SillyTavern?.getContext?.().chat,api=host.STBaiBaiBook;
  check(Array.isArray(rows)&&rows.length>0&&rows.length<=16,'SAMPLE_REQUIRED','Open a small isolated chat (1–16 messages) with an existing BaiBai summary');
  check(api?.apiVersion===1,'SAMPLE_REQUIRED','Actual BaiBai API v1 required');
  const sourceHash=digest(rows.map(m=>({mes:m.mes,is_user:m.is_user??null,is_system:m.is_system??null})));
  const namespace=`mnemo-t03-paged-t04-live-${run}`,deadline=Date.now()+240000;
  const budget=()=>check(Date.now()<deadline,'RESOURCE_LIMIT','Short demo budget reached; drain before any retry');
  const native=await host.__TAURITAVERN__.api.db.open(namespace,{dim:2,syncMode:'full',autoBuildQuiver:false});
  let nodes;try{await native.flush();nodes=(await native.stats()).nodeCount;}finally{await native.close();}
  panel.controls.namespace.value=namespace;panel.controls.create.checked=nodes===0;
  const perform=async label=>{budget();const result=await panel.perform(label);check(result.ok,result.code??'ERROR',result.message??'Panel action failed');return result.value;};
  try {
    const plan=await perform('读取来源并预览');
    const summaries=plan.input.assets.filter(a=>a.category==='summary');
    check(summaries.length>0,'SAMPLE_REQUIRED','Actual getFloor returned no valid stored summary; do not generate one');
    const bound=await perform('确认当前预览'),bridge=panel.events.importer,h=bridge.h;
    budget();const refs=await h.range(bound.target.head,0,bound.count);
    check(refs.length===plan.input.messages.length,'NEEDS_RESOLUTION','Original count differs');
    for(let i=0;i<refs.length;i++)check((await h.read('revisions',refs[i].revision_id)).content===plan.input.messages[i].content,
      'NEEDS_RESOLUTION','Actual original content differs');
    for(const asset of summaries){
      const mapped=await bridge.record('assetMap',digest({source:bound.source,id:asset.source_id}));
      check(mapped,'NEEDS_RESOLUTION','Actual legacy summary not archived');
      check((await bridge.record('asset',mapped.asset)).data.text===asset.data.text,'NEEDS_RESOLUTION','Actual summary content differs');
    }
    budget();const after=await panel.source.capture(plan.categories);
    const current=host.SillyTavern.getContext().chat;
    check(sourceHash===digest(current.map(m=>({mes:m.mes,is_user:m.is_user??null,is_system:m.is_system??null})))&&after.fingerprint===plan.sourceFingerprint,
      'VERSION_CONFLICT','Source changed during demonstration');
    return{type:'done',run,namespace,apiVersion:api.apiVersion,pluginVersion:api.pluginVersion,
      actualTTSourceCapture:true,actualBaiBaiReads:true,panelPreviewAndConfirm:true,originals:refs.length,
      actualSummaryCount:summaries.length,originalContentEqual:true,summaryContentEqual:true,sourceUnchanged:true,
      reusedExistingTarget:nodes>0,sourceWrites:0,modelRequests:0,injections:0,privateContentInEvidence:false};
  }finally{await panel.perform('停止桥接');}
}
