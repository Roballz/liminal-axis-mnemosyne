import { styles } from './styles.mjs';

export function mountPanel({host=globalThis,connect,recover,version='demo'}) {
  const doc=host.document,root=doc.createElement('div');root.id='mnemosyne-daily';
  const shadow=root.attachShadow({mode:'open'});doc.body.append(root);
  const el=(tag,text='',cls='')=>{const n=doc.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,cls='action')=>{const n=el('button',text,cls);n.type='button';return n;};
  const dropdowns=[];
  const dropdown=(label)=>{
    const wrap=el('div','','dropdown'),input=el('select'),trigger=button('','dropdown-trigger'),menu=el('div','','dropdown-menu');
    input.hidden=true;menu.hidden=true;menu.id='mnemo-menu-'+dropdowns.length;
    trigger.setAttribute('role','combobox');trigger.setAttribute('aria-label',label);
    trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-controls',menu.id);
    menu.setAttribute('role','listbox');menu.setAttribute('aria-label',label);
    const shut=()=>{menu.hidden=true;trigger.setAttribute('aria-expanded','false');};
    const refresh=()=>{const options=[...input.options];trigger.textContent=(options.find(n=>n.value===input.value)??options[0])?.textContent??'选择档案库';};
    const open=()=>{dropdowns.forEach(d=>d.close());menu.replaceChildren();
      for(const option of input.options){const item=button(option.textContent,'dropdown-option');item.setAttribute('role','option');
        item.setAttribute('aria-selected',String(option.value===input.value));
        item.onclick=()=>{input.value=option.value;refresh();shut();trigger.focus?.();input.onchange?.();};menu.append(item);
      }
      if(!menu.children.length)return;menu.hidden=false;trigger.setAttribute('aria-expanded','true');
    };
    trigger.onclick=()=>{if(menu.hidden)open();else shut();};
    trigger.onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();open();
      const nodes=[...menu.children];(e.key==='ArrowDown'?nodes[0]:nodes.at(-1))?.focus?.();}};
    menu.onkeydown=e=>{const nodes=[...menu.children],index=nodes.indexOf(e.target);
      if(e.key==='Escape'){e.preventDefault();shut();trigger.focus?.();}
      else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();
        const next=e.key==='Home'?0:e.key==='End'?nodes.length-1:(index+(e.key==='ArrowDown'?1:-1)+nodes.length)%nodes.length;nodes[next]?.focus?.();}
    };
    wrap.onkeydown=e=>{if(e.key==='Escape'){shut();trigger.focus?.();}else if(e.key==='Tab')shut();};
    wrap.append(input,trigger,menu);const result={wrap,input,trigger,menu,refresh,close:shut};dropdowns.push(result);shut();refresh();return result;
  };
  const outside=e=>dropdowns.forEach(d=>{if(!e.composedPath().includes(d.wrap))d.close();});
  host.addEventListener('pointerdown',outside);
  const style=el('style',styles);shadow.append(style);
  const bubble=button('◈ Mnemosyne 档案','bubble');bubble.setAttribute('aria-label','打开 Mnemosyne 档案');
  const panel=el('section','','panel');panel.hidden=true;panel.setAttribute('aria-label','Mnemosyne 手动搜索');
  const header=el('header'),brand=el('div','Mnemosyne 档案','brand');brand.append(el('small','LOCAL ARCHIVE · MANUAL SEARCH'));
  const theme=button('◐','icon'),close=button('×','icon');theme.title='切换浅色 / 深色';close.title='收起窗口';
  header.append(brand,theme,close);
  const main=el('main'),footer=el('div',`仅手动同步 · 本机保存 · ${version}`,'footer'),grip=button('◢','grip');
  grip.title='拖动调整大小；聚焦后可用方向键调整';grip.setAttribute('aria-label','调整窗口大小');
  const archiveLabel=el('label','档案库','label'),row=el('div','','row section'),archiveDropdown=dropdown('选择档案库'),archives=archiveDropdown.input;
  archives.setAttribute('aria-label','选择档案库');const current=button('当前聊天'),moreArchives=button('更多档案');
  row.append(archiveDropdown.wrap,current,moreArchives);
  const createRow=el('div','','row section'),name=el('input','','grow');name.placeholder='给当前聊天的库起个名字';name.maxLength=80;name.setAttribute('aria-label','新库名称');
  const create=button('建立库'),sync=button('同步','action primary');createRow.append(name,create,sync);
  const preview=el('div','','preview');preview.hidden=true;const previewText=el('p'),confirm=button('确认写入本机库','action primary'),cancel=button('取消');
  preview.append(previewText,confirm,cancel);
  const status=el('div','打开后读取本机档案目录；正文与摘要只会在手动确认后写入。','notice');status.setAttribute('role','status');
  const searchRow=el('form','','row search'),query=el('input');query.placeholder='搜索正文或已有摘要…';query.setAttribute('aria-label','搜索关键词');
  const search=button('搜索','action primary');search.type='submit';searchRow.append(query,search);
  const filters=el('div','','row filters'),scopeDropdown=dropdown('正文搜索范围'),scope=scopeDropdown.input;scope.setAttribute('aria-label','正文搜索范围');
  for(const [value,label] of [['current','当前正文'],['swipes','当前正文 + Swipe']]){const n=el('option',label);n.value=value;scope.append(n);}
  const summaries=el('input');summaries.type='checkbox';summaries.checked=true;const summaryLabel=el('label','','check');summaryLabel.append(summaries,el('span','包含已有摘要'));
  scopeDropdown.refresh();filters.append(scopeDropdown.wrap,summaryLabel);
  const results=el('div','','results'),detail=el('section','','detail');detail.hidden=true;
  const pager=el('div','','row section'),next=button('继续查找'),backup=button('完整备份'),repair=button('恢复待完成操作');next.disabled=true;
  pager.style.marginTop='14px';pager.append(next,backup,repair);
  const hint=el('div','Swipe 仅含最近同步保存的候选，不是全部历史。备份含旧正文与恢复材料（上限16 MiB）。','muted');
  main.append(archiveLabel,row,createRow,preview,status,searchRow,filters,results,detail,pager,hint);
  panel.append(header,main,footer,grip);shadow.append(bubble,panel);
  let demo=null,epoch=0,locked=false,disposed=false,after=null,items=[],count=0;
  const controls=[archives,current,moreArchives,name,create,sync,confirm,cancel,query,search,scope,summaries,next,backup,repair];
  const say=(text,error=false)=>{status.textContent=text;status.className='notice'+(error?' error':'');};
  const clear=()=>{epoch++;dropdowns.forEach(d=>d.close());demo?.workbench.cancel();results.replaceChildren();detail.replaceChildren();detail.hidden=true;next.disabled=true;count=0;};
  const ready=async()=>demo??=await connect();
  const selectOption=(archive,select=true)=>{let option=[...archives.options].find(n=>n.value===archive.source);
    if(!option){option=el('option',archive.name);option.value=archive.source;archives.append(option);items.push(archive);}
    if(select)archives.value=archive.source;archiveDropdown.refresh();};
  const choose=async archive=>{clear();preview.hidden=true;const token=epoch;
    await demo.select(archive);if(token!==epoch)return;
    selectOption(archive);say(`${archive.name} · 最近同步 ${new Date(archive.updated_at).toLocaleString()}\n搜索本机已同步内容；继续聊天后请手动同步。`);
  };
  const catalog=async(reset=true)=>{
    if(reset){after=null;items=[];archives.replaceChildren();}
    const page=await demo.catalog(after);after=page.done?null:page.next??page.after??page.keys.at(-1);
    for(const archive of page.items)selectOption(archive,false);
    moreArchives.hidden=page.done;
  };
  const followCurrent=async()=>{
    const known=await demo.current();
    if(known.archive){await choose(known.archive);return;}
    clear();demo.selected=null;archives.value='';
    say(known.binding?'当前聊天有未完成的建库记录。保留原聊天，再次建立库可继续；如有待完成操作，先点恢复。':'当前聊天尚未绑定档案：填写库名，点击“建立库”。');
  };
  const run=async(fn)=>{
    if(locked||disposed)return;locked=true;
    dropdowns.forEach(d=>{d.close();d.trigger.disabled=true;});controls.forEach(n=>n.disabled=true);
    try{await fn();}catch(e){
      if(!disposed&&!panel.hidden&&e.code!=='CANCELLED')say(`${e.code??'操作失败'}：${e.message}\n如聊天有变化，请重新选择档案或预览；写入失败时先恢复原操作，勿反复建立新库。`,true);
    }finally{locked=false;if(!disposed){controls.forEach(n=>n.disabled=false);dropdowns.forEach(d=>d.trigger.disabled=false);next.disabled=!demo?.workbench.cursor;}}
  };
  const present=page=>{
    for(const hit of page.items){const card=button('','result');
      const type=hit.kind==='body'?`${hit.role} · 正文 #${hit.index+1}`:hit.kind==='swipe'?`SWIPE 候选 · #${hit.index+1} · ${hit.slots.length}处命中`:'已有摘要 · 生成来源未证明';
      card.append(el('span',type,'meta'),el('span',hit.snippet,'snippet'));
      card.onclick=()=>run(async()=>{const token=epoch;detail.replaceChildren();detail.hidden=true;const value=await demo.detail(hit);if(token!==epoch)return;
        detail.append(el('h3',type));
        if(value.sourceNotice)detail.append(el('p',value.sourceNotice,'muted'));
        if(value.asset)detail.append(el('pre',value.asset.data.text??''));
        if(value.notice)detail.append(el('p',value.notice,'muted'));
        for(const candidate of value.candidates??[]){detail.append(el('h3',`Swipe ${candidate.slot+1}（候选）`),el('pre',candidate.content));}
        for(const r of value.rows??value.context?.rows??[]){detail.append(el('h3',`#${r.index+1} · ${r.role}`),el('pre',r.content));}
        detail.hidden=false;
      });results.append(card);count++;
    }
    next.disabled=!page.cursor;
    say(page.status==='empty-query'?'请输入关键词。':`已显示 ${count} 条结果 · 已检查 ${page.scanned??0}/${page.total??0} 条正文\n${page.status==='exhausted'?'本次搜索完成。':'尚未检查完，可点“继续查找”。'}${page.limitReason?' 本批达到读取预算；若持续停在同一位置，当前对象超过 demo 预算。':''}`);
    if(!count&&page.status==='exhausted')results.append(el('div','没有找到匹配内容。试试更短的关键词，或检查搜索范围。','empty'));
  };
  bubble.onclick=()=>{panel.hidden=!panel.hidden;if(!panel.hidden)run(async()=>{await ready();clear();await catalog();await followCurrent();});};
  close.onclick=()=>{clear();demo?.invalidate();preview.hidden=true;panel.hidden=true;};
  current.onclick=()=>run(async()=>{await ready();await followCurrent();});
  moreArchives.onclick=()=>run(()=>catalog(false));
  archives.onchange=()=>run(()=>choose(items.find(a=>a.source===archives.value)));
  const prepare=syncing=>run(async()=>{await ready();clear();preview.hidden=true;
    const token=epoch,r=await demo.preview(name.value,{sync:syncing});if(token!==epoch)return;
    previewText.textContent=`${r.name}\n${r.originals} 条正文 · ${r.summaries} 条已有摘要\n本次变更 ${r.changed} 条，原范围替换/移除 ${r.removed} 条。${r.sourceReport.available?'':'未检测到柏宝书摘要，仅导入正文。'}\n最新内容作为默认搜索范围；旧正文仅保留为恢复材料。`;
    preview.hidden=false;say('请核对预览后确认。不会改动 TT 或柏宝书。');
  });
  create.onclick=()=>prepare(false);sync.onclick=()=>prepare(true);
  cancel.onclick=()=>{demo?.invalidate();clear();preview.hidden=true;say('已取消预览。');};
  confirm.onclick=()=>run(async()=>{clear();const token=epoch;say('正在同步，请保持当前聊天，等待完成…');preview.hidden=true;
    const archive=await demo.confirm();if(token!==epoch)return;await catalog();await choose(archive);name.value='';
  });
  searchRow.onsubmit=e=>{e.preventDefault();run(async()=>{clear();const token=epoch;
    if(!demo?.selected)throw Error('先选择已完成同步的档案');
    await demo.select(demo.selected);if(token!==epoch)return;
    const page=await demo.search(query.value,{swipes:scope.value==='swipes',legacy:summaries.checked});if(token===epoch)present(page);
  });};
  const changeScope=()=>{clear();say('搜索范围已改变，请重新搜索。');};scope.onchange=changeScope;summaries.onchange=changeScope;
  next.onclick=()=>run(async()=>{const token=epoch,page=await demo.next();if(token===epoch)present(page);});
  backup.onclick=()=>run(async()=>{await ready();const token=epoch,value=await demo.export();if(token!==epoch)return;
    const url=host.URL.createObjectURL(value.blob),a=el('a');a.href=url;a.download=`mnemosyne-backup-${new Date().toISOString().slice(0,10)}.ndjson`;
    shadow.append(a);a.click();a.remove();host.setTimeout(()=>host.URL.revokeObjectURL(url),30000);say('已生成所有档案的完整备份，含旧正文和恢复材料。请妥善保存。');
  });
  repair.onclick=()=>run(async()=>{clear();preview.hidden=true;say('正在恢复原待完成操作…');demo=await recover();await catalog();say('原操作恢复完毕。请回到原聊天，重新预览同步；恢复不会自动读取新的聊天内容。');});
  let pref={};try{pref=JSON.parse(host.localStorage.getItem('mnemosyne-demo-ui-v1')??'{}');}catch{}
  panel.dataset.theme=pref.theme??(host.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light');
  const save=()=>{try{host.localStorage.setItem('mnemosyne-demo-ui-v1',JSON.stringify({theme:panel.dataset.theme}));}catch{}};
  theme.onclick=()=>{panel.dataset.theme=panel.dataset.theme==='dark'?'light':'dark';save();};
  const fit=(x,y,w,h)=>{const width=Math.max(280,Math.min(w,host.innerWidth-16)),height=Math.max(280,Math.min(h,host.innerHeight-16));
    Object.assign(panel.style,{width:`${width}px`,height:`${height}px`,left:`${Math.max(8,Math.min(x,host.innerWidth-width-8))}px`,top:`${Math.max(8,Math.min(y,host.innerHeight-height-8))}px`,right:'auto',bottom:'auto'});};
  const drag=(node,resize)=>{let origin=null;
    node.onpointerdown=e=>{if(e.button!==0||!resize&&e.target.closest('button'))return;const r=panel.getBoundingClientRect();origin={x:e.clientX,y:e.clientY,r};node.setPointerCapture(e.pointerId);e.preventDefault();};
    node.onpointermove=e=>{if(!origin)return;const {x,y,r}=origin,dx=e.clientX-x,dy=e.clientY-y;fit(resize?r.x:r.x+dx,resize?r.y:r.y+dy,r.width+(resize?dx:0),r.height+(resize?dy:0));};
    node.onpointerup=node.onpointercancel=node.onlostpointercapture=()=>{origin=null;};
  };drag(header,false);drag(grip,true);
  grip.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const r=panel.getBoundingClientRect();fit(r.x,r.y,r.width+(e.key==='ArrowRight'?20:e.key==='ArrowLeft'?-20:0),r.height+(e.key==='ArrowDown'?20:e.key==='ArrowUp'?-20:0));};
  const resize=()=>{if(!panel.hidden){const r=panel.getBoundingClientRect();fit(r.x,r.y,r.width,r.height);}};host.addEventListener('resize',resize);
  return {root,controls:{bubble,panel,archives,current,create,sync,name,confirm,query,search,searchRow,scope,scopeDropdown,archiveDropdown,summaries,next,results,detail,status,preview,close},
    invalidate(){clear();preview.hidden=true;if(!panel.hidden)say('聊天或摘要已变化。旧结果已清除；请点击“当前聊天”重新选择，按需手动同步。');},
    dispose(){disposed=true;clear();host.removeEventListener('resize',resize);host.removeEventListener('pointerdown',outside);root.remove();}};
}
