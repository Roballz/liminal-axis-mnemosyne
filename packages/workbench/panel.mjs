import { Workbench } from './service.mjs';

export function mountWorkbench({getHandle,document=globalThis.document,download=downloadBlob,limits={},preferredSource=null}) {
  const root=document.createElement('section');root.setAttribute('aria-label','Mnemosyne 手动搜索工作台');
  root.style.cssText='position:fixed;inset:5vh 4vw;z-index:10001;background:#20242d;color:#eee;padding:16px;overflow:auto;border:1px solid #899;border-radius:8px;max-width:900px;box-sizing:border-box';
  const add=(tag,text,parent=root)=>{const e=document.createElement(tag);if(text)e.textContent=text;parent.append(e);return e;};
  add('h2','Mnemosyne · 手动搜索');
  add('p','本机档案只读。明确选择档案后搜索；取消/关闭不停止导入。');
  const controls={},buttons=new Map();
  const select=(name,entries)=>{const e=controls[name]=add('select');e.setAttribute('aria-label',name);
    for(const [value,label] of entries){const o=add('option',label,e);o.value=value;}e.value=entries[0]?.[0]??'';return e;};
  const catalogKind=select('目录类型',[['bindings','已绑定档案（含导入状态）'],['branches','所有分支（不声明宿主同步）']]);
  const archive=select('档案分支',[['','请读取目录后选择']]);
  const last=controls.last=add('input');last.type='checkbox';add('span','明确查看最后确认的已发布档案（pending/paused不解除）');
  add('br');
  const query=controls.query=add('input');query.type='search';query.maxLength=4096;query.setAttribute('aria-label','一句原文或名称');
  query.style.cssText='width:min(100%,32em);max-width:100%;';
  const mode=select('匹配模式',[['tolerant','容错：NFKC / 大小写折叠 / 空白'],['exact','原样精确子串']]);
  const legacy=controls.legacy=add('input');legacy.type='checkbox';add('span','旧摘要辅助');
  const legacyHistory=controls.legacyHistory=add('input');legacyHistory.type='checkbox';add('span','另看同分支其他快照的历史旧摘要');
  const status=add('pre','尚未打开档案。'),results=add('div'),detail=add('pre');
  for(const e of [status,detail])e.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';
  let prefer=preferredSource,service,opening,closed=false,generation=0,catalogAfter=null,catalogStamp=null,choices=[],snapshot=null,selected=null,lastPage=null;
  const get=async()=>service??await (opening??=getHandle().then(h=>service=new Workbench(h,limits)).catch(e=>{opening=null;throw e;}));
  const invalidate=()=>{generation++;service?.cancel();selected=null;lastPage=null;results.replaceChildren();detail.textContent='';status.textContent='条件已改变，请手动重新查找。';};
  const showState=s=>{status.textContent=JSON.stringify({说明:s.notice,状态:s.status,原因:s.reason,进度:s.progress,
    snapshot:s.snapshot,待处理操作:!!s.pending},null,2);};
  async function choose(token=generation) {
    const choice=archive.value===''?null:choices[Number(archive.value)];if(!choice)throw Error('请先选择一个档案/分支');
    const active=await get();if(token!==generation||closed)throw Object.assign(Error('页面读取已取消'),{code:'CANCELLED'});
    const s=await active.select({...choice,snapshot,allowLast:last.checked});
    if(token!==generation||closed)throw Object.assign(Error('页面读取已取消'),{code:'CANCELLED'});selected=s;return s;
  }
  const button=(label,fn,parent=root)=>{
    const e=add('button',label,parent);e.type='button';buttons.set(label,e);
    e.onclick=async()=>{const token=['查找','分页浏览正文','选择档案/当前快照','更早的历史快照'].includes(label)?++generation:generation;e.disabled=true;
      try{const value=await fn(token);return{ok:true,value};}
      catch(error){if(token===generation&&!closed){status.textContent=`${error.code??'ERROR'}: ${error.message}`;
        if(['STALE_READ','STALE_HANDLE','CANCELLED','LIBRARY_CHANGED'].includes(error.code)){results.replaceChildren();detail.textContent='旧结果已撤销，请重新查找';}}
        return{ok:false,code:error.code??'ERROR'};}
      finally{e.disabled=false;}};return e;
  };
  async function render(page,token) {
    if(token!==generation||closed)return;
    lastPage=page;results.replaceChildren();detail.textContent='';
    status.textContent=`${selected?.notice??''}\n${page.status==='partial'?'本批未搜完，可继续查找':page.status==='empty-query'?'空查询：未扫描':page.items.length?'所选范围已穷尽':'所选范围已穷尽，本批无命中（此前分页结果不计入本批）'}\n正文进度 ${page.scanned}/${page.total??0}；本批 ${page.items.length} 项；${page.limitReason??''}`;
    for(const item of page.items) {
      const row=add('article',null,results);row.style.cssText='border-top:1px solid #667;padding:8px 0;overflow-wrap:anywhere';
      add('p',item.kind==='body'?`${item.role} · 档案序号 ${item.index+1} · ${item.match} · ${item.revision_id}`:
        `${item.kind} · 旧资料 ${item.historical?'其他快照/历史':'所选scope'} · ${item.declaration}`,row);
      add('p',item.snippet,row);
      const show=add('button','查看原文/来源',row);show.type='button';show.onclick=async()=>{
        try{const data=await service.detail(item);if(token===generation&&!closed)detail.textContent=JSON.stringify(data,null,2);return{ok:true,value:data};}
        catch(e){if(token===generation)detail.textContent=`${e.code??'ERROR'}：${e.message}`;return{ok:false,code:e.code};}};
      const locate=add('button','来源跳转/档案回退',row);locate.type='button';locate.onclick=async()=>{
        try{const value=await service.locate(item);if(token===generation&&!closed)detail.textContent=value.reason;return{ok:true,value};}
        catch(e){if(token===generation)detail.textContent=`${e.code??'ERROR'}：${e.message}`;return{ok:false,code:e.code};}};
      row.actions={show,locate};
    }
  }
  button('读取目录',async token=>{
    const page=await(await get()).catalog({kind:catalogKind.value,after:catalogAfter,stamp:catalogStamp});
    if(token!==generation||closed)return;
    const preferred=prefer?await service.preferredBinding(prefer):null;prefer=null;
    if(token!==generation||closed)return;
    choices=preferred?[preferred,...page.items.filter(c=>c.bindingSource!==preferred.bindingSource)]:page.items;archive.replaceChildren();const empty=add('option','请选择本页档案',archive);empty.value='';
    choices.forEach((c,i)=>{const o=add('option',c.label,archive);o.value=String(i);});archive.value=preferred?'0':'';
    catalogAfter=page.done?null:page.after;catalogStamp=page.done?null:page.stamp;
    status.textContent=page.done?'目录本轮已穷尽；再次读取从头开始':'目录未完；再次读取下一页（每页最多4项）';return page;
  });
  button('选择档案/当前快照',async token=>{snapshot=null;const s=await choose();if(token===generation)showState(s);return s;});
  button('更早的历史快照',async token=>{
    if(!selected)await choose();const previous=await service.previous();
    if(!previous)throw Error('没有更早的本分支快照');snapshot=previous;
    const s=await choose();if(token===generation){results.replaceChildren();detail.textContent='';showState(s);}return s;
  });
  const start=async(token,browse)=>{
    // A new search invalidates every earlier UI request before any asynchronous read.
    const own=token;results.replaceChildren();detail.textContent='';
    await choose();const page=await service.search(query.value,{mode:mode.value,legacy:legacy.checked,
      legacyHistory:legacyHistory.checked,browse});await render(page,own);return page;
  };
  button('查找',token=>start(token,false));button('分页浏览正文',token=>start(token,true));
  button('继续查找',async token=>{const page=await service.next(lastPage?.cursor);await render(page,token);return page;});
  button('取消',()=>{invalidate();status.textContent='已取消后续读取；在途调用沿原队列排空。';});
  button('导出完整库恢复包',async token=>{
    const value=await(await get()).export();if(token!==generation||closed)return;
    await download(value);status.textContent=`完整库恢复包已生成：${value.bytes} 字节；固定checkpoint ${value.checkpoint.hash}`;
    return value;
  });
  const close=()=>{closed=true;generation++;service?.close();root.remove();};
  button('关闭工作台',close);
  query.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();buttons.get('查找').onclick();}};
  for(const e of [archive,last,mode,legacy,legacyHistory,query])e.oninput=()=>{if(e===archive)snapshot=null;invalidate();};
  catalogKind.onchange=()=>{catalogAfter=null;catalogStamp=null;choices=[];archive.replaceChildren();snapshot=null;invalidate();};
  document.body.append(root);
  return {root,controls,buttons,results,status,detail,close,perform:label=>buttons.get(label).onclick(),
    get service(){return service;},get page(){return lastPage;}};
}
function downloadBlob(value) {
  const url=URL.createObjectURL(value.blob),a=document.createElement('a');
  a.href=url;a.download='mnemosyne-complete-library.jsonl';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
