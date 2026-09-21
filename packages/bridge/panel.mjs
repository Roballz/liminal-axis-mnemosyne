import { TTSource } from './source.mjs';
import { Importer } from './importer.mjs';
import { openPagedTestStore } from '../storage/paged-tt-adapter.mjs';
import { BridgeEvents } from './events.mjs';

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
  const inputMode=add('select');for(const [v,t] of [['','确认输入范围'],['new-segment','续聊：此文件仅为新段'],['full-copy','续聊：含完整旧历史副本'],['overlap','续聊：开头为旧尾段副本'],['existing-child','分叉：已存在子聊天，保留其尾部'],['parent-cutoff','分叉：截取父聊天，排除截止之后']])inputMode.add(new Option(t,v));
  const overlap=add('input');overlap.type='number';overlap.min='1';overlap.placeholder='已确认重叠消息数';
  const confirmLocator=add('input');confirmLocator.type='checkbox';add('span','确认是同一聊天改名/位置变化，不是另一副本');
  const legacyBinding=add('select');legacyBinding.add(new Option('旧版档案重绑（仅在原定位已改变时选择）',''));
  const branches=add('select');branches.setAttribute('aria-label','源分支');
  const cutoff=add('input');cutoff.type='number';cutoff.min='0';cutoff.placeholder='含端点消息数（楼层+1）';
  const options={};for(const [k,t] of [['items','物品'],['scenes','地点'],['lifeDetails','生活档案']]){const e=add('input');e.type='checkbox';options[k]=e;add('span',t);}
  const status=add('pre','尚未读取来源。');status.style.whiteSpace='pre-wrap';
  let owner,importer,plan,activeSource=null;
  const source=new TTSource(host), categories=()=>Object.keys(options).filter(k=>options[k].checked);
  const show=v=>{status.textContent=typeof v==='string'?v:JSON.stringify(v,null,2);};
  const events=new BridgeEvents(source,{show,onSwitch:()=>{plan=null;activeSource=null;}});
  const buttons=new Map();
  const button=(text,fn)=>{const b=add('button',text);buttons.set(text,b);b.type='button';b.onclick=async()=>{b.disabled=true;
    try{return{ok:true,value:await fn()};}catch(e){show({code:e.code??'ERROR',message:e.message});return{ok:false,code:e.code??'ERROR',message:e.message};}
    finally{b.disabled=false;}};return b;};
  async function open(){
    if(owner)return;
    owner=await openPagedTestStore(host.__TAURITAVERN__.api.db,namespace.value,{create:create.checked});
    importer=new Importer(owner.handle(),input=>source.guard(input));await importer.recoverPending();
    let after=null;do{const page=await owner.handle().enumerate('branches',after,64);for(const id of page.keys)branches.add(new Option(id,id));after=page.keys.length===64?page.after:null;}while(after);
    after=null;do{const page=await owner.handle().enumerate('bindings',after,64);for(const id of page.keys){const b=await owner.handle().read('bindings',id);legacyBinding.add(new Option(`已有分支 ${b.branch_id}`,b.host_scope));}after=page.keys.length===64?page.after:null;}while(after);
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
    const choice=mode.value==='new'?{mode:'new'}:{mode:intent.value,input_mode:inputMode.value||undefined,overlap_count:Number(overlap.value),branch_id:branches.value,cutoff:Number(cutoff.value)};
    if(choice.input_mode===undefined)delete choice.input_mode;
    choice.confirm_locator=confirmLocator.checked;if(legacyBinding.value)choice.legacy_source=legacyBinding.value;
    plan=await importer.preview(input,choice,categories());
    activeSource=plan.input.source;events.bind(importer,activeSource);
    show({目标:plan.target,继承截止:plan.fork?.prefix_length??null,报告:plan.report,
      提醒:plan.report.removed?'确认将采用此删除/局部替换提案；旧版本保留。':'确认后分批保存，可以暂停。'});
    return plan;
  });
  button('确认当前预览',async()=>{
    if(!plan)throw Error('先读取来源并预览');const latest=await source.capture(plan.categories);
    if(latest.fingerprint!==plan.sourceFingerprint)throw Error('来源已变化，请重新预览');
    const result=await importer.confirm(plan);show(result);plan=null;return result;
  });
  button('暂停后续批次',()=>{importer?.cancel();source.cancel();show('停止后续批次；进行中的批次仍需排空，已提交内容保留。');});
  button('恢复连接/继续',async()=>{
    await open();const h=await owner.recover();importer=new Importer(h,input=>source.guard(input));await importer.recoverPending();
    const input=await source.capture(categories());activeSource=await importer.storageSource(input);events.bind(importer,activeSource);const b=await importer.record('binding',activeSource);
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
  button('停止桥接',async()=>{importer?.cancel();await events.stop();if(owner)await owner.close();root.remove();});
  document.body.append(root);return{root,source,events,controls:{namespace,create},
    // Uses the same handler as a user click; no separate testing import path.
    perform:label=>buttons.get(label).onclick()};
}
