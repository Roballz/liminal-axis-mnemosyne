import { openPagedTestStore } from '../storage/paged-tt-adapter.mjs';
import { Importer } from '../bridge/importer.mjs';
import { snapshot,rawMessage } from '../bridge/source.mjs';
import { equal,requireThat as check } from '../contracts/primitives.mjs';
import { mountWorkbench } from './panel.mjs';

// Explicit one-shot synthetic demo; normal extension entry never imports this file.
export async function runNative(host=globalThis) {
  const run='20260922t05read',namespace='mnemo-t03-paged-t05-20260922a';
  const start=Date.now(),deadline=start+240000;
  const out={run,type:'error',namespace,stages:[],close:{attempted:false,confirmed:false},
    source:'synthetic-only',businessWritesDuringReads:null};
  let owner,panel;
  const budget=()=>check(Date.now()<deadline,'DEMO_BUDGET','停止发起下一动作，等待在途调用排空');
  const stage=name=>{budget();out.stages.push({name,ms:Date.now()-start});const display=host.document.getElementById('mnemosyne-t05-read-status');if(display)display.textContent='当前步骤：'+name;};
  try {
    stage('prior-close');
    const api=host.__TAURITAVERN__.api.db;
    // Exact empty-target assertion. No reuse, deletion, retry or namespace replacement.
    const registry=host[Symbol.for('mnemosyne.t03.paged-test-owners.v1')];
    const prior=await registry?.get(api)?.get(namespace);
    check(prior&&prior.status==='closed','PRIOR_CLOSE_UNKNOWN','Existing synthetic owner must be closed');
    stage('open-existing');owner=await openPagedTestStore(api,namespace);
    const h=owner.handle(),bridge=new Importer(h);
    const rows=[{mes:'虚构钟楼：ＨＥＬＬＯ Straße',is_user:true},
      {mes:'虚构钟楼：铜钥匙',is_user:false,swipes:[null,'虚构旧候选',null],swipe_id:2},
      {mes:'虚构 system 记录',is_system:true},{mes:'虚构末页 <img src=x onerror=alert(1)> 钟楼',is_user:true}];
    const input=snapshot('t05-synthetic',rows.map(rawMessage),{assets:[{category:'summary',source_id:'floor:1:demo',anchor:1,
      data:{text:'虚构旧摘要：钟楼铜钥匙',floor:1,ordinary_pair:true,validity:'legacy-asserted'}}],report:{available:true}});
    const guarded={...h,prepare:async req=>{budget();return h.prepare(req);}};
    const importer=new Importer(guarded);
    stage('existing-receipt');const bound=await bridge.record('binding',input.source);
    check(bound?.status==='complete'&&bound.count===4,'FIXTURE_CHANGED','Existing complete synthetic fixture only');
    out.importCalls=0;out.readViewAvailable=typeof h.readView==='function';
    out.fixture={messages:4,assets:1,status:bound.status};
    stage('shared-owner');const same=await openPagedTestStore(api,namespace);
    check(same===owner,'OWNER_MISMATCH','Work through same native owner');
    const before=await h.diagnostics();
    const reader={...h,readView:async r=>{budget();return h.readView({...r,deadline:Math.min(r.deadline??Infinity,deadline)});},
      exportSnapshot:async()=>{budget();const result=await h.exportSnapshot(),stream=result.stream;
        return {...result,stream:(async function*(){try{while(true){budget();const next=await stream.next();if(next.done)return;yield next.value;}}finally{await stream.return?.();}})()};}};
    let exported;
    panel=mountWorkbench({getHandle:async()=>reader,document:host.document,
      limits:{messages:2,milliseconds:1000},download:async value=>{
        // Real export button, local download; only synthetic content, never collector upload.
        exported=value;const url=URL.createObjectURL(value.blob),a=host.document.createElement('a');
        a.href=url;a.download='mnemosyne-t05-synthetic-complete.jsonl';a.click();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
      }});
    const perform=async label=>{stage(label);const r=await panel.perform(label);check(r.ok,'PAGE_ACTION_FAILED',label+': '+r.code);return r.value;};
    await perform('读取目录');panel.controls['档案分支'].value='0';await perform('选择档案/当前快照');
    panel.controls.query.value='钟楼';let page=await perform('查找'),hits=[...page.items],pages=1;
    while(page.cursor){page=await perform('继续查找');hits.push(...page.items);pages++;check(pages<=10,'NO_PROGRESS','Limited demo pages');}
    check(equal(hits.map(x=>x.index),[0,1,3]),'SEARCH_MISMATCH','Actual native range results');out.search={pages,matches:3,scopeCorrect:true};
    stage('detail');const detail=await panel.results.children[0].actions.show.onclick();
    check(detail.ok&&detail.value.rows.at(-1).content===rows[3].mes,'CONTENT_MISMATCH','Page detail exact content');
    out.detailEqual=true;stage('fallback');const fallback=await panel.results.children[0].actions.locate.onclick();
    check(fallback.ok&&fallback.value.available===false,'LOCATOR_MISMATCH','Explicit archive fallback');out.archiveFallback=true;
    panel.controls.legacy.checked=true;panel.controls.query.value='旧摘要';page=await perform('查找');pages=1;
    while(page.cursor&&!page.items.some(x=>x.kind==='summary')){page=await perform('继续查找');check(++pages<=10,'NO_PROGRESS','Summary pages');}
    const summary=page.items.find(x=>x.kind==='summary');check(summary,'SUMMARY_MISSING','Scoped native summary');
    stage('summary-detail');const source=await panel.results.children[page.items.indexOf(summary)].actions.show.onclick();
    check(source.ok&&source.value.asset.data.text===input.assets[0].data.text,'CONTENT_MISMATCH','Summary equality');out.summaryEqual=true;
    await perform('导出完整库恢复包');check(exported.bytes===exported.blob.size,'EXPORT_MISMATCH','Complete download');out.export={bytes:exported.bytes,checkpoint:exported.checkpoint,scope:exported.scope};
    stage('readonly-checkpoint');const after=await h.diagnostics();check(equal(before.checkpoint,after.checkpoint),'BUSINESS_WRITE','Read actions changed checkpoint');
    out.businessWritesDuringReads=after.operation_count-before.operation_count;
    await perform('关闭工作台');stage('owner-survives');check(owner.status==='ready','OWNER_CLOSED','Workbench closed shared owner');
    check((await bridge.record('binding',input.source)).status==='complete','OWNER_UNUSABLE','Importer remains readable');out.sharedOwnerSurvives=true;
    out.type='done';
  } catch(e) {out.code=e.code??'ERROR';out.message=e.message;out.phase=out.stages.at(-1)?.name;}
  finally {
    panel?.close();
    if(owner){out.close.attempted=true;await owner.settled();try{await owner.close();out.close.confirmed=owner.status==='closed';}catch(e){out.close.code=e.code??'ERROR';out.type='error';}}
    out.elapsedMs=Date.now()-start;out.stoppedBeforeNextAction=Date.now()>=deadline;
  }
  return out;
}
