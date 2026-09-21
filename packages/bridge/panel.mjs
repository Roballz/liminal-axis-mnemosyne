import { TTSource } from './source.mjs';
import { Importer } from './importer.mjs';
import { openPagedTestStore } from '../storage/paged-tt-adapter.mjs';

// Isolated-only entry. User content always uses textContent, never HTML.
export function mountPanel(host = globalThis) {
  const root=document.createElement('details');
  root.style.cssText='position:fixed;bottom:12px;right:12px;z-index:9999;background:#20242d;color:#eee;padding:12px;max-width:480px;max-height:80vh;overflow:auto;border:1px solid #899;border-radius:8px';
  const add=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;root.append(e);return e;};
  add('summary','Mnemosyne · 只读导入');
  add('p','独立测试档案。源聊天和柏宝书只读。旧摘要按来源声明保存，不自动转成当前有效记忆。');
  const namespace=add('input');namespace.value='mnemo-t03-paged-t04-archive';namespace.setAttribute('aria-label','独立目标库');
  const create=add('input');create.type='checkbox';create.checked=true;add('span','创建空库（已有库取消）');add('br');
  const restoreFile=add('input');restoreFile.type='file';restoreFile.accept='.jsonl';restoreFile.setAttribute('aria-label','完整分页恢复包');
  const mode=add('select');for(const [v,t] of [['new','新聊天，不继承记忆'],['inherit','继承已有存档']])mode.add(new Option(t,v));
  const intent=add('select');for(const [v,t] of [['continue','接着剧情续聊'],['fork','从截止处开分支'],['mapping','确认已有映射']])intent.add(new Option(t,v));
  const branches=add('select');branches.setAttribute('aria-label','源分支');
  const cutoff=add('input');cutoff.type='number';cutoff.min='0';cutoff.placeholder='含端点消息数（楼层+1）';
  const options={};for(const [k,t] of [['items','物品'],['scenes','地点'],['lifeDetails','生活档案']]){const e=add('input');e.type='checkbox';options[k]=e;add('span',t);}
  const status=add('pre','尚未读取来源。');status.style.whiteSpace='pre-wrap';
  let owner,importer,plan,activeSource=null;
  const source=new TTSource(host), categories=()=>Object.keys(options).filter(k=>options[k].checked);
  const show=v=>{status.textContent=typeof v==='string'?v:JSON.stringify(v,null,2);};
  const button=(text,fn)=>{const b=add('button',text);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){show({code:e.code??'ERROR',message:e.message});}finally{b.disabled=false;}};return b;};
  async function open(){
    if(owner)return;
    owner=await openPagedTestStore(host.__TAURITAVERN__.api.db,namespace.value,{create:create.checked});
    importer=new Importer(owner.handle(),input=>source.guard(input));await importer.recoverPending();
    let after=null;do{const page=await owner.handle().enumerate('branches',after,64);for(const id of page.keys)branches.add(new Option(id,id));after=page.keys.length===64?page.after:null;}while(after);
    namespace.disabled=true;create.disabled=true;
  }
  button('将恢复包导入指定空库',async()=>{
    if(owner)throw Error('请重新打开面板并指定一个新的空库');
    const file=restoreFile.files[0];if(!file)throw Error('先选择完整分页包');
    owner=await openPagedTestStore(host.__TAURITAVERN__.api.db,namespace.value,{restore:file.stream()});
    importer=new Importer(owner.handle(),input=>source.guard(input));await importer.recoverPending();
    namespace.disabled=true;create.disabled=true;show('完整包已校验并恢复到空库，包含导入进度和暂停状态。');
  });
  button('读取来源并预览',async()=>{
    await open();const input=await source.capture(categories());activeSource=input.source;
    const choice=mode.value==='new'?{mode:'new'}:{mode:intent.value,branch_id:branches.value,cutoff:Number(cutoff.value)};
    plan=await importer.preview(input,choice,categories());
    show({目标:plan.target,继承截止:plan.fork?.prefix_length??null,报告:plan.report,
      提醒:plan.report.removed?'确认将采用此删除/局部替换提案；旧版本保留。':'确认后分批保存，可以暂停。'});
  });
  button('确认当前预览',async()=>{
    if(!plan)throw Error('先读取来源并预览');const latest=await source.capture(plan.categories);
    if(latest.fingerprint!==plan.sourceFingerprint)throw Error('来源已变化，请重新预览');
    show(await importer.confirm(plan));plan=null;
  });
  button('暂停后续批次',()=>{importer?.cancel();source.cancel();show('停止后续批次；进行中的批次仍需排空，已提交内容保留。');});
  button('恢复连接/继续',async()=>{
    await open();const h=await owner.recover();importer=new Importer(h,input=>source.guard(input));await importer.recoverPending();
    const input=await source.capture(categories());activeSource=input.source;const b=await importer.record('binding',activeSource);
    if(!b)throw Error('此来源尚无导入会话');
    if(b.status==='paused'){show('需重新核对并确认；关闭警告不会解除暂停。');return;}
    show(b.status==='complete'?b:await importer.resume(b.session,input));
  });
  button('启用本绑定影子同步',async()=>{if(!activeSource)throw Error('先确认绑定');await importer.enableSync(activeSource,true);show('已启用局部同步；漏事件仍需手动重新核对。');});
  button('关闭同步',async()=>{if(activeSource)await importer.enableSync(activeSource,false);show('已关闭同步。');});
  button('导出完整恢复包',async()=>{
    await open();const chunks=[];for await(const chunk of await owner.handle().export())chunks.push(chunk);
    const url=URL.createObjectURL(new Blob(chunks,{type:'application/x-ndjson'})),a=document.createElement('a');a.href=url;a.download='mnemosyne-paged-bridge.jsonl';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);show('已导出原文、旧资料和会话/暂停回执。');
  });
  let notices=Promise.resolve();
  const unsubscribe=source.subscribe(notice=>{
    if(notice.name==='CHAT_CHANGED'){importer?.cancel();plan=null;activeSource=null;show('聊天已切换，请重新核对绑定。');return;}
    if(!importer||!activeSource)return;
    const capturedSource=activeSource;
    notices=notices.then(async()=>{
      const b=await importer.record('binding',capturedSource);if(!b?.sync)return;
      if(notice.generating){await importer.setState(capturedSource,'pending','generation-in-progress');show('生成中：不判作永久删除。');return;}
      if(notice.generation!==source.generation)return; // coalesce duplicate notifications
      let kind=null,start=notice.index;
      if(['MESSAGE_EDITED','MESSAGE_UPDATED'].includes(notice.name))kind='edit';
      if(notice.name==='MESSAGE_SWIPED')kind='swipe';
      if(notice.name==='MESSAGE_RECEIVED'){kind='append';start=b.count;}
      if(notice.name==='GENERATION_ENDED'){kind='regenerate';start=b.count-1;}
      if(kind&&Number.isSafeInteger(start)&&start>=0){
        try{const change=await source.captureLocal(start,kind==='append'?16:1);await importer.applyLocal(change,kind);show('已保存精确局部变化；旧摘要仍按原来源范围保留。');return;}
        catch(e){if(!['VERSION_CONFLICT','NOT_READY'].includes(e.code))throw e;}
      }
      await importer.setState(capturedSource,'paused','source-changed-manual-recheck');
      show('聊天变化需重新核对；当前绑定暂停，旧档案保留，其他故事不受影响。');
    }).catch(e=>show({code:e.code??'ERROR',message:e.message}));
  });
  button('停止桥接',async()=>{importer?.cancel();unsubscribe();await notices;if(owner)await owner.close();root.remove();});
  document.body.append(root);return{root,source};
}
