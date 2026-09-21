import { openPagedTestStore } from '../storage/paged-tt-adapter.mjs';
import { digest,recordKey } from './records.mjs';

const namespace='mnemo-t03-paged-t04-live-20260921r1live';
const run='20260922inspect';
const once=Symbol.for('mnemosyne.t04.inspect.20260922');
const tag=value=>value===null?null:digest(value).slice(-16);
const stop=code=>{throw Object.assign(Error(code),{code});};
// Only state queries: no Importer, prepare, execute, create or recovery of pending requests.
async function inspect(host) {
  const out={type:'error',run,namespace,phase:'owner-check',queries:0,prepareCalls:0,executeCalls:0,
    close:{attempted:false,confirmed:false},sessions:[],pending:[]};
  let owner,owned=false;const started=Date.now(),deadline=started+120000;
  const query=async(phase,fn)=>{
    if(Date.now()>deadline)stop('INSPECTION_BUDGET');
    out.phase=phase;out.queries++;return await fn();
  };
  try {
    const api=host.__TAURITAVERN__?.api?.db;
    const prior=host[Symbol.for('mnemosyne.t03.paged-test-owners.v1')]?.get(api)?.get(namespace);
    if(!prior)stop('PRIOR_OWNER_UNKNOWN');
    // Observe settlement only. Timeout never unlocks an owner or cancels native work.
    let facade,settled=false,rejected=false;
    prior.then(x=>{facade=x;return x.settled();}).then(()=>{settled=true;},()=>{rejected=true;});
    await new Promise(resolve=>setTimeout(resolve,100));
    if(rejected||!settled)stop('PRIOR_OWNER_NOT_SETTLED');
    out.priorOwnerStatus=facade.status;
    if(facade.status!=='closed')stop('PRIOR_CLOSE_NOT_CONFIRMED');
    owner=await query('open-existing',()=>openPagedTestStore(api,namespace,{create:false}));owned=true;
    const h=owner.handle(),before=await query('checkpoint',()=>h.diagnostics());
    out.checkpoint=tag(before.checkpoint);out.operationCount=before.operation_count;
    out.storageStatus=before.status;out.maintenanceGate=before.maintenance_gate;
    const pending=await query('pending',()=>h.pending());
    out.pending=pending.map(p=>({operation:tag(p.input.operation_id),status:p.status,
      kind:['bridge','history','history-delta','memory','binding'].includes(p.input.kind)?p.input.kind:'unknown'}));
    const list=await query('bindings',()=>h.enumerate('bindings',null,2,before.checkpoint));
    if(list.keys.length>1)stop('MULTIPLE_BINDINGS_REVIEW');
    for(const id of list.keys){
      const formal=await query('binding',()=>h.read('bindings',id));
      const b=await query('bridge-binding',()=>h.bridgeRead(recordKey('binding',formal.host_scope)));
      if(!b)stop('MISSING_BRIDGE_BINDING');
      const s=await query('session',()=>h.bridgeRead(recordKey('session',b.session)));
      if(!s)stop('MISSING_SESSION');
      const d=await query('published-branch',()=>h.diagnostics(b.target.branch_id));
      const snap=await query('published-snapshot',()=>h.read('snapshots',d.branch.head_snapshot_id));
      const phases=['messages','assets'];
      const reasons=['cancelled-after-confirmed-batches','source-changed-after-durable-batch','generation-in-progress'];
      out.sessions.push({session:tag(s.id),binding:tag(b.binding_id),bindingStatus:b.status,sessionStatus:s.status,
        bodyCursor:s.cursor,bodyTotal:s.total,assetCursor:s.assetCursor,assetTotal:s.assetTotal,
        mappedOriginals:b.count,offset:b.offset,phase:phases.includes(s.reason?.phase)?s.reason.phase:null,
        stopReason:reasons.includes(b.reason)?b.reason:b.reason===null?null:'other-redacted',
        publishedSnapshot:tag(snap.snapshot_id),publishedMessages:snap.message_count,
        targetMatchesPublished:b.target.head===d.branch.head_snapshot_id,
        remainingBody:s.total-s.cursor,remainingAssets:s.assetTotal-s.assetCursor});
    }
    const after=await query('checkpoint-final',()=>h.diagnostics());
    if(digest(before.checkpoint)!==digest(after.checkpoint))stop('CHECKPOINT_CHANGED');
    out.checkpointUnchanged=true;out.type='done';out.phase='state-query-complete';
  }catch(e){out.code=typeof e.code==='string'&&/^[A-Z_]+$/.test(e.code)?e.code:'UNCLASSIFIED_ERROR';}
  finally {
    if(owned){out.close.attempted=true;try{await owner.close();out.close.confirmed=owner.status==='closed';}
      catch(e){out.close.code=typeof e.code==='string'&&/^[A-Z_]+$/.test(e.code)?e.code:'CLOSE_ERROR';out.type='error';}}
    out.elapsedMs=Date.now()-started;
  }
  return out;
}
export function runInspection(host=globalThis){
  return host[once]??=inspect(host).then(async result=>{
    // Counts/fixed states only; pending.input and source data never leave the page.
    console.info('Mnemosyne 原会话核对',result);
    await fetch('http://127.0.0.1:19375/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
    return result;
  });
}
