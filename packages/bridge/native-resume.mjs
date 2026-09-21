import {openPagedTestStore} from '../storage/paged-tt-adapter.mjs';
import {Importer} from './importer.mjs';
import {TTSource} from './source.mjs';
import {digest,recordKey} from './records.mjs';
import {equal,requireThat as check} from '../contracts/primitives.mjs';

const namespace='mnemo-t03-paged-t04-live-20260921r1live',run='20260922resume';
const once=Symbol.for('mnemosyne.t04.resume.20260922');
const tag=x=>digest(x).slice(-16);
async function resume(host){
  const start=Date.now(),deadline=start+240000;
  const out={type:'error',run,namespace,stages:[],prepareCalls:0,executeCalls:0,close:{attempted:false,confirmed:false}};
  let owner,unsubscribe;const stage=name=>{out.phase=name;out.stages.push({phase:name,ms:Date.now()-start});
    const display=host.document.getElementById('mnemosyne-resume-status');if(display)display.textContent=JSON.stringify(out,null,2);};
  const budget=()=>check(Date.now()<deadline,'RESUME_BUDGET','No next batch after deadline');
  try{
    stage('prior-owner');const api=host.__TAURITAVERN__.api.db;
    const prior=host[Symbol.for('mnemosyne.t03.paged-test-owners.v1')]?.get(api)?.get(namespace);
    check(prior,'PRIOR_OWNER_UNKNOWN','Keep original page');
    let facade,settled=false;prior.then(x=>{facade=x;return x.settled();}).then(()=>{settled=true;},()=>{});
    await new Promise(r=>setTimeout(r,100));
    check(settled&&facade.status==='closed','PRIOR_CLOSE_NOT_CONFIRMED','Do not create competing owner');
    budget();stage('open-original');owner=await openPagedTestStore(api,namespace,{create:false});
    const h=owner.handle(),before=await h.diagnostics(),pending=await h.pending();
    check(pending.length===0,'PENDING_OPERATION','Report original request; do not retry');
    const list=await h.enumerate('bindings',null,2,before.checkpoint);
    check(list.keys.length===1,'BINDING_REVIEW','Exactly original binding required');
    const formal=await h.read('bindings',list.keys[0]);
    const b=await h.bridgeRead(recordKey('binding',formal.host_scope));
    const s=await h.bridgeRead(recordKey('session',b.session));
    check(tag(s.id)==='0635b6496310a2ca'&&tag(b.binding_id)==='3f6bc3d0c9d77871',
      'SESSION_CHANGED','Original inspected session only');
    check(b.status==='partial'&&s.status==='partial'&&s.reason.phase==='assets'&&s.cursor===25&&s.total===25&&
      s.assetCursor===0&&s.assetTotal===2&&b.count===25,'PROGRESS_CHANGED','Reinspect changed progress');
    const branch=await h.diagnostics(b.target.branch_id);
    check(branch.branch.head_snapshot_id===b.target.head&&tag(b.target.head)==='0968de7a6530a509','TARGET_CHANGED','Original published snapshot required');
    out.before={body:25,assets:0,assetTotal:2,status:s.status,pending:0};
    stage('fixed-source');const source=new TTSource(host);unsubscribe=source.subscribe(()=>{});
    const input=await source.capture(s.categories);
    check(input.source===s.source&&input.fingerprint===s.fingerprint,'FIXED_INPUT_CHANGED','Do not replace original session');
    check(input.messages.length===25&&input.assets.length===2&&input.assets.every(a=>a.category==='summary'),
      'SOURCE_SCOPE_CHANGED','Only two original summaries');
    // Exactly one remaining asset batch. No body batch or retry path is available here.
    let guardCalls=0;
    const guarded={...h,prepare:async p=>{budget();out.prepareCalls++;stage('asset-prepare');return h.prepare(p);},
      execute:async id=>{out.executeCalls++;stage('asset-execute');return h.execute(id);}};
    const importer=new Importer(guarded,async captured=>{if(++guardCalls===1)budget();await source.guard(captured);});
    budget();stage('resume-original');const done=await importer.resume(s.id,input);
    stage('batch-returned');const saved=await importer.record('session',s.id);
    out.after={body:saved.cursor,bodyTotal:saved.total,assets:saved.assetCursor,assetTotal:saved.assetTotal,status:saved.status};
    check(done.status==='complete'&&saved.status==='complete'&&saved.assetCursor===2,'INCOMPLETE','Preserve existing progress');
    check(done.target.head===b.target.head,'TARGET_CHANGED','Summary-only resume must preserve original Head');
    out.originalHeadUnchanged=true;
    // Budget controls starting further verification; an in-flight native call is always awaited.
    budget();stage('verify-originals');const refs=await h.range(done.target.head,0,25);
    check(refs.length===25,'CONTENT_MISMATCH','Original count');
    for(let i=0;i<refs.length;i++){
      budget();const revision=await h.read('revisions',refs[i].revision_id),m=input.messages[i];
      check(revision.content===m.content&&revision.role===m.role,'CONTENT_MISMATCH','Original data differs');
      const map=await importer.record('map',s.source,i);
      check(equal(map.candidates,{values:m.candidates,selected:m.selected}),'CONTENT_MISMATCH','Candidate slots differ');
    }
    out.originalContentEqual=true;out.candidateSlotsEqual=true;
    stage('verify-summaries');
    for(const a of input.assets){
      budget();const map=await importer.record('assetMap',digest({source:s.source,id:a.source_id}));
      check(map,'CONTENT_MISMATCH','Summary map missing');
      const asset=await importer.record('asset',map.asset);
      check(equal(asset.data,a.data)&&asset.category===a.category&&asset.scope.snapshot_id===done.target.head,
        'CONTENT_MISMATCH','Summary data/scope differs');
    }
    out.summaryContentEqual=true;
    budget();stage('verify-final');const finalInput=await source.capture(s.categories);
    check(finalInput.fingerprint===input.fingerprint,'SOURCE_CHANGED','Source changed during resume');
    out.sourceUnchanged=true;out.pendingAfter=(await h.pending()).length;
    check(out.pendingAfter===0,'PENDING_OPERATION','Final request pending');
    out.operationDelta=(await h.diagnostics()).operation_count-before.operation_count;
    out.sourceWrites=0;out.modelRequests=0;out.injections=0;out.type='done';
  }catch(e){out.code=typeof e.code==='string'&&/^[A-Z_]+$/.test(e.code)?e.code:'UNCLASSIFIED_ERROR';}
  finally{
    unsubscribe?.();
    if(owner){stage('close');out.close.attempted=true;try{await owner.close();out.close.confirmed=owner.status==='closed';}
      catch(e){out.close.code=typeof e.code==='string'&&/^[A-Z_]+$/.test(e.code)?e.code:'CLOSE_ERROR';out.type='error';}}
    out.elapsedMs=Date.now()-start;
  }
  return out;
}
export function runResume(host=globalThis){return host[once]??=resume(host).then(async result=>{
  await fetch('http://127.0.0.1:19375/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
  return result;
});}
