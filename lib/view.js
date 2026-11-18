import * as db from './db.js';
import { blankFolder, digest, identity, lines, matchSource, tagPage, touchTags, unique, validToken } from './model.js';
import { parseFilter, validateRule } from './extract.js';
import { button, field, icon, iconButton, input, node, reader, select } from './dom.js';

const dimensions = {person:'人物',folder:'合集',tag:'关键词'};
const section = (title) => node('h3','mn-section',title);
const row = (...children) => { const el=node('div','mn-row');el.append(...children);return el; };
const choice = (label,active,fn) => {
    const b=button(label,fn,'mn-chip');b.setAttribute('aria-pressed',String(active));return b;
};
function dateOf(value) {
    return value?.match(/\d{2,4}(?:年|[-/.])\d{1,2}(?:月|[-/.])\d{1,2}日?/)?.[0] || value?.split(/[ T]/)[0] || '';
}
function day(row) {
    const a=dateOf(row.start), b=dateOf(row.end);
    return a && b && a!==b ? a+' 至 '+b : a || b || '剧情日期未标注';
}
export class View {
    constructor(root,prefs,savePrefs) {
        Object.assign(this,{root,prefs,savePrefs,tab:'note',mode:'all',blockMode:'folder',path:[],filters:{},seq:0});
        this.panel=node('section','mn-panel');this.panel.setAttribute('aria-label','Mnemosyne记事簿');
        this.scrim=button('',()=>this.close(),'mn-scrim');this.scrim.setAttribute('aria-label','关闭记事簿');
        this.panel.inert=true;
        const brand=node('div','mn-brand');brand.append(icon('book'),node('h2','','Mnemosyne记事簿'));
        this.panel.append(row(brand,iconButton('关闭','close',()=>this.close())));
        this.nav=node('nav','mn-nav');
        for(const [id,label,key] of [['note','收藏','mark'],['block','消息','inbox'],['settings','设置','settings']]) {
            const b=button(label,()=>{this.tab=id;this.path=[];this.filters={};this.render();});
            b.prepend(icon(key));b.dataset.tab=id;this.nav.append(b);
        }
        this.content=node('div','mn-content');this.status=node('div','mn-status');
        this.panel.append(this.nav,this.content,this.status);root.append(this.scrim,this.panel);
    }
    setEngine(engine) {
        clearTimeout(this.refreshTimer); this.seq++;this.modal?.remove();this.modal=null;
        this.toastNode?.remove();this.engine=engine;this.filters={};this.path=[];
        if(this.opened) this.render();
    }
    guard(fn) { return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(e=>this.error(e)); }
    open() {
        this.opened=true;this.panel.inert=false;this.root.dataset.open='yes';this.engine?.open();
        this.render(); this.panel.querySelector('button')?.focus({preventScroll:true});
    }
    close() {
        this.modal?.remove();this.modal=null;this.opened=false;this.seq++;
        this.root.dataset.open='no';this.panel.inert=true;this.panel.style.removeProperty('transform');
    }
    error(e) {
        const text=e?.message || String(e);
        if(this.modal?.open) {
            let message=this.modal.querySelector('.mn-error');
            if(!message){message=node('p','mn-error');message.setAttribute('role','alert');this.modal.querySelector('.mn-dialog-body').prepend(message);}
            message.textContent=text;message.scrollIntoView?.({block:'nearest'});
        } else this.toast(text,null,true);
    }
    toast(text,fn,persistent=false) {
        clearTimeout(this.toastTimer); this.toastNode?.remove();
        const el=fn ? button(text,()=>{el.remove();this.guard(fn)();},'mn-toast') : node('div','mn-toast',text);
        el.setAttribute('role','status'); this.root.append(el);this.toastNode=el;
        this.toastTimer=setTimeout(()=>el.remove(),persistent || fn ? 7000 : 2900);
    }
    notice(floor,scan) {
        if (!scan.rows.length) return this.toast('#'+floor+' 检出 div，未匹配外层标记');
        const unknown=scan.rows.filter(r=>!r.folders.length), known=scan.rows.filter(r=>r.folders.length);
        const clauses=[];
        if(known.length) clauses.push(known.length===1 ? known[0].name+' → '+known[0].folders.join('、') : known.length+' 个消息块已归入合集');
        if(unknown.length) clauses.push(unknown[0].name+(unknown.length>1?' 等 '+unknown.length+' 项':'')+'待归类');
        this.toast('#'+floor+' · '+clauses.join('，'),unknown.length ? ()=>this.assign({...unknown[0],floor}) : null);
    }
    changed(kind) {
        if(!this.opened || !this.engine?.book) return;
        const p=this.engine.progress, n=this.engine.host.size();
        this.status.textContent=p.revisit!=null ? '正在更新已有消息的分类' : p.back ? '正在整理历史 · '+(p.next+p.target-p.back)+' / '+n+' 楼' :
            (p.next>=n?'历史已整理':'已整理 '+p.next+' / '+n+' 楼');
        if (kind==='progress' || this.tab==='settings' || this.modal) return;
        clearTimeout(this.refreshTimer);
        this.refreshTimer=setTimeout(()=>{if(this.opened&&!this.modal)this.render();},100);
    }
    async render() {
        const seq=++this.seq, e=this.engine;
        for(const b of this.nav.children) b.setAttribute('aria-current',String(b.dataset.tab===this.tab));
        if(!this.opened) return;
        if(!e?.book) {this.content.replaceChildren(node('p','mn-empty','打开聊天后即可查看记事簿'));this.status.textContent='';return;}
        if(this.tab==='settings'){this.content.replaceChildren(this.settings(e));return;}
        try {
            const page=node('div','mn-page'), kind=this.tab;
            const title=node('h3','mn-title',kind==='note'?'楼层收藏':'消息摘录');
            page.append(row(title,kind==='block'?button('管理合集',()=>this.folders(),'mn-link'):node('span')));
            const modes=node('div','mn-modes');
            const mode=kind==='note'?this.mode:this.blockMode;
            for(const [id,label] of [['all','全部'],['person','按人物'],['folder','按合集']])
                modes.append(choice(label,mode===id,()=>{
                    if(kind==='note')this.mode=id;else this.blockMode=id;
                    this.path=[];this.filters={};this.render();
                }));
            page.append(modes);
            const second=mode==='folder'?'person':'folder';
            const depth=kind==='note'?2:1;
            const active={...this.filters};
            if(this.path.length) active[mode]=this.path[0];
            if(this.path.length>1) active[second]=this.path[1];
            if(this.path.length) page.append(button('‹  '+this.path.map(x=>x||'未分类').join('  /  '),
                ()=>{this.path.pop();this.render();},'mn-back'));
            if(mode!=='all' && this.path.length<depth) {
                const dim=this.path.length?second:mode;
                const names=await db.groups(e.key,kind,dim,this.path[0]);
                const grid=node('div','mn-grid');
                for(const name of names){
                    const b=button('',()=>{this.path.push(name);this.render();},'mn-group');
                    b.append(icon(dim==='person'?'people':'folder'),node('strong','',name||'未分类'),icon('arrow'));grid.append(b);
                }
                page.append(grid);
                if(!names.length) page.append(node('p','mn-empty',kind==='note'?'收藏楼层后，可在这里按标签浏览。':'尚无消息摘录。可先建合集和识别规则。'));
            } else {
                if(kind==='note'){
                    const bar=node('div','mn-filter');
                    const options=await Promise.all(Object.keys(dimensions).map(dim=>db.groups(e.key,kind,dim)));
                    Object.keys(dimensions).forEach((dim,i)=>{
                        if((dim===mode&&this.path.length) || (dim===second&&this.path.length>1)) return;
                        const s=select([['*',dimensions[dim]+' · 全部'],...options[i].map(v=>['='+v,v||'未分类'])],
                            this.filters[dim]==null?'*':'='+this.filters[dim],v=>{
                                if(v==='*')delete this.filters[dim];else this.filters[dim]=v.slice(1);this.render();
                            });s.setAttribute('aria-label',dimensions[dim]+'筛选');bar.append(s);
                    });page.append(bar);
                }
                const entries=node('div','mn-entries');page.append(entries);
                let lastDay='';
                const load=async(before)=>{
                    const result=await db.list(e.key,kind,active,before);
                    if(seq!==this.seq||!this.opened)return;
                    if(!before&&!result.rows.length)entries.append(node('p','mn-empty','这里还没有符合条件的条目'));
                    for(const r of result.rows){
                        if(kind==='block'&&lastDay!==day(r)){lastDay=day(r);entries.append(node('h4','mn-day',lastDay));}
                        const b=button('',this.guard(()=>this.detail(r)),'mn-entry');
                        const label=node('div','mn-entry-main');
                        label.append(node('strong','',kind==='block'?r.name:r.note||'楼层收藏'),
                            node('small','',[...r.people,...r.folders,...(r.tags||[]).map(t=>'#'+t)].join(' · ')||'未分类'));
                        b.append(node('span','mn-floor','#'+r.floor),label,icon('arrow'));entries.append(b);
                    }
                    if(result.more){
                        const more=button('查看更多',this.guard(async()=>{more.disabled=true;await load(result.rows.at(-1).order);more.remove();}),'mn-more');
                        entries.append(more);
                    }
                };
                await load(null);
            }
            if(seq===this.seq&&this.opened){this.content.replaceChildren(page);this.changed('progress');}
        } catch(err){if(seq===this.seq)this.error(err);}
    }
    dialog(title) {
        this.modal?.remove();
        const el=node('dialog','mn-dialog');
        el.setAttribute('aria-label',title);
        const header=row(node('h3','',title),iconButton('关闭','close',()=>el.close()));
        const body=node('div','mn-dialog-body');el.append(header,body);
        el.addEventListener('close',()=>{if(this.modal===el)this.modal=null;el.remove();},{once:true});
        el.addEventListener('click',ev=>{if(ev.target===el){const r=el.getBoundingClientRect();
            if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)el.close();}});
        this.root.append(el);this.modal=el;el.showModal();
        return {el,body};
    }
    async bookmark(localFloor,existing) {
        const e=this.engine;if(!e?.book) return this.toast('请先打开聊天');
        await e.host.sync();
        let floor,msg;
        if(existing) ({floor,msg}=await e.source(existing,true));
        else {
            if(!Number.isInteger(localFloor)) return this.toast('可视区内没有可收藏的楼层');
            floor=localFloor+e.host.offset;[msg]=await e.host.read(floor,floor+1);
            existing=(await db.notesAt(e.key,floor)).find(n=>matchSource(n,msg));
        }
        if(this.engine!==e||!e.alive())return;
        const indexedPeople=await db.groups(e.key,'block','person');
        if(this.engine!==e||!e.alive())return;
        const marker=msg.mes, savedIdentity=identity(msg);
        const {el,body}=this.dialog(existing?'编辑收藏':'收藏楼层');
        const preview=reader(marker.slice(0,2500)).textContent.trim().slice(0,128);
        body.append(node('span','mn-floor','#'+floor),node('p','mn-preview',preview||'（无文字预览）'));
        const note=input(existing?.note||'','写下要记住的线索…',true);body.append(field('备注',note));
        const people=new Set(existing?.people||[]), folders=new Set(existing?.folders||[]), tags=new Set(existing?.tags||[]);
        const addedPeople=[],addedFolders=[];
        function picks(title,names,selected,added){
            const chips=node('div','mn-chips'), editor=node('div','mn-inline');editor.hidden=true;
            const box=input('','输入新'+title+'名称');
            const draw=()=>{
                chips.replaceChildren(...unique([...names,...added,...selected]).map(n=>choice(n,selected.has(n),()=>{
                    if(selected.has(n))selected.delete(n);else selected.add(n);draw();
                })));
            };
            const add=()=>{const n=box.value.trim();if(!n)return;added.push(n);selected.add(n);box.value='';editor.hidden=true;draw();};
            editor.append(box,button('添加',add));
            box.onkeydown=ev=>{if(ev.key==='Enter'){ev.preventDefault();add();}};
            body.append(row(section(title),button('＋ 新建',()=>{editor.hidden=!editor.hidden;if(!editor.hidden)box.focus();},'mn-link')),chips,editor);draw();
        }
        picks('人物',unique([...e.book.people,...indexedPeople]),people,addedPeople);picks('合集',e.book.folders.map(f=>f.name),folders,addedFolders);
        let page=0;
        const chips=node('div','mn-chips'), custom=input('','输入关键词，多个可用逗号分隔');
        const draw=()=>{
            const names=unique([...tags,...tagPage(e.book.tags,page)]);
            chips.replaceChildren(...names.map(t=>choice(t,tags.has(t),()=>{
                if(tags.has(t))tags.delete(t);else tags.add(t);draw();
            })));
        };
        const cycle=button('换一批',()=>{page++;draw();},'mn-link');cycle.disabled=e.book.tags.length<=10;
        body.append(row(section('关键词'),cycle),chips,custom);draw();
        const save=button('确认收藏',this.guard(async()=>{
            if(!e.alive()||this.engine!==e)return;
            save.disabled=true;
            try{
                const [current]=await e.host.read(floor,floor+1);
                if(current.mes!==marker||identity(current)!==savedIdentity)throw Error('来源已变化，请重新打开收藏窗口');
                const words=unique([...tags,...custom.value.split(/[，,、\n]/).map(s=>s.trim())]);
                const record={id:existing?.id||crypto.randomUUID(),floor,note:note.value.trim(),
                    people:[...people],folders:[...folders],tags:words,identity:savedIdentity,hash:digest(marker)};
                e.book=await db.saveNote(e.key,record,b=>{
                    b.people=unique([...b.people,...addedPeople,...people]);
                    for(const name of unique([...addedFolders,...folders]))if(!b.folders.some(f=>f.name===name))b.folders.push(blankFolder(name));
                    b.tags=touchTags(b.tags,words);
                });
                if(!e.alive())return;
                el.close();this.toast('已收藏 #'+floor+(folders.size?' · '+[...folders].join('、'):''));this.changed('live');
            } finally {save.disabled=false;}
        }),'mn-primary');body.append(save);
    }
    async detail(r) {
        const e=this.engine,note=r.key[1]==='note';
        const {body,el}=this.dialog(note?'收藏正文':r.name);
        body.append(node('span','mn-floor','#'+r.floor));
        if(note&&r.note)body.append(node('p','mn-preview',r.note));
        try{
            const {msg,floor}=await e.source(r,note);
            if(!el.open||!e.alive())return;
            body.firstChild.textContent='#'+floor;
            if(!note)body.append(node('p','mn-caption',[r.start,r.end].filter(Boolean).join(' → ')||'剧情日期未标注'));
            body.append(reader(note?msg.mes:msg.mes.slice(r.from,r.to)));
            if(note)body.append(button('编辑备注与标签',this.guard(()=>this.bookmark(null,r)),'mn-primary'));
            else if(!r.folders.length)body.append(button('选择合集并记住此名称',()=>this.assign(r),'mn-primary'));
        }catch(err){if(el.open)body.append(node('p','mn-empty',err.message));}
        if(note && el.open)body.append(button('取消收藏',this.guard(async()=>{
            if(!confirm('取消这条收藏并移除它的备注与标签？'))return;
            await db.removeNote(e.key,r.id);if(e.alive()){el.close();this.toast('已取消收藏');this.render();}
        }),'mn-link'));
    }
    async editRules(e,change, mode = true) {
        e.resetting=true;const epoch=++e.epoch;
        e.parser.stop();e.recent.clear();
        try {
            const book=await db.mutateBook(e.key,change,mode);
            if(!e.alive()||epoch!==e.epoch)return;
            e.book=book;e.progress=await db.getProgress(e.key);e.history=true;
        } finally {if(e.epoch===epoch){e.resetting=false;e.kick();}}
        this.changed('reset');
    }
    assign(r) {
        const e=this.engine;if(!e?.book)return;
        const {el,body}=this.dialog('将消息归入合集');
        const menu=select([['','新建合集'],...e.book.folders.map(f=>[f.name,f.name])],'');
        const name=input(r.name,'合集名称');
        menu.onchange=()=>{name.hidden=!!menu.value;};
        body.append(node('p','mn-preview',r.name),field('目标合集',menu),name);
        const save=button('归类并记住此名称',this.guard(async()=>{
            const dest=menu.value||name.value.trim();if(!dest)throw Error('请填写合集名称');
            save.disabled=true;
            try {await this.editRules(e,b=>{
                let f=b.folders.find(f=>f.name===dest);
                if(!f){f={...blankFolder(dest),tag:r.tag,attr:r.attr};b.folders.push(f);}
                let rule=f;
                if(f.tag!==r.tag||f.attr!==r.attr){
                    f.extra ||= [];
                    rule=f.extra.find(x=>x.tag===r.tag&&x.attr===r.attr);
                    if(!rule){rule={tag:r.tag,attr:r.attr,names:[]};f.extra.push(rule);}
                }
                rule.names=unique([...rule.names,r.name]);
            },'existing');
            if(Number.isInteger(r.floor))e.dirty(r.floor,false);
            if(e.alive()){el.close();this.toast('已记住「'+r.name+'」→ '+dest);}
            }finally{save.disabled=false;}
        }),'mn-primary');body.append(save);
    }
    folders() {
        const e=this.engine,{body}=this.dialog('管理合集');
        body.append(button('＋ 新建合集',()=>this.folderEditor(),'mn-primary'));
        for(const f of e.book.folders){
            const b=button('',()=>this.folderEditor(f),'mn-group');b.append(icon('folder'),node('strong','',f.name),icon('arrow'));body.append(b);
        }
    }
    folderEditor(old) {
        const e=this.engine,f=old||blankFolder(''),{el,body}=this.dialog(old?'编辑合集规则':'新建合集');
        const name=input(f.name,'例如：往来微信'),person=input(f.person,'可选，命中后添加此人物');
        name.readOnly=!!old;
        const tag=input(f.tag), attr=input(f.attr), names=input(f.names.join('\n'),'每行一个完整 UI 名称',true);
        const pattern=input(f.pattern,'例如：^与(.+?)的微信$');
        body.append(field('合集名称',name),field('外层元素',tag),field('名称所在属性',attr),
            field('匹配任一 UI 名称',names),field('人物标签',person));
        const advanced=node('details');advanced.open=!!f.pattern;
        advanced.append(node('summary','','高级匹配'),field('名称正则',pattern),node('p','mn-hint','完整名称和正则任一命中即归类。第一组括号或命名组 person 可提取人物。'));
        body.append(advanced);
        if(f.extra?.length)body.append(node('p','mn-hint','其他已记住的标记：'+f.extra.map(x=>x.attr+' · '+x.names.join('、')).join('；')));
        const save=button('保存合集',this.guard(async()=>{
            const updated={...f,name:name.value.trim(),tag:tag.value.trim().toLowerCase(),attr:attr.value.trim().toLowerCase(),
                names:lines(names.value),pattern:pattern.value.trim(),person:person.value.trim()};
            if(!updated.name)throw Error('请填写合集名称');
            validateRule(updated);
            if(!old&&e.book.folders.some(x=>x.name===updated.name))throw Error('已有同名合集');
            save.disabled=true;
            try{
                const alreadyKnown = updated.tag==='div' && updated.attr==='data-nvwa-ui' ||
                    e.book.folders.some(x=>x.tag===updated.tag && x.attr===updated.attr);
                await this.editRules(e,b=>{
                    const i=b.folders.findIndex(x=>x.name===updated.name);
                    if(i<0)b.folders.push(updated);else b.folders[i]=updated;
                    b.people=unique([...b.people,updated.person]);
                },alreadyKnown && (!old || old.tag===updated.tag && old.attr===updated.attr) ? 'existing' : true);
                if(e.alive()){el.close();this.toast('已保存「'+updated.name+'」');this.render();}
            }finally{save.disabled=false;}
        }),'mn-primary');body.append(save);
    }
    settings(e) {
        const wrap=node('div','mn-page');wrap.append(node('h3','mn-title','记事簿设置'),section('外观'));
        const themes=node('div','mn-themes');
        for(const [key,name] of [['light','白绿 · 浅色'],['dark','深蓝 · 深色'],['neon','墨绿 · 霓虹']]){
            const b=choice(name,this.prefs.theme===key,()=>{this.savePrefs({theme:key});this.render();});
            b.dataset.swatch=key;themes.append(b);
        }
        const toggle=node('input');toggle.type='checkbox';toggle.checked=this.prefs.zero;
        toggle.onchange=()=>this.savePrefs({zero:toggle.checked});
        wrap.append(themes,field('气泡停靠侧',select([['left','左侧'],['right','右侧']],this.prefs.side,v=>this.savePrefs({side:v}))),
            field('通知位置',select([['edge','收藏头旁'],['top','应用顶部']],this.prefs.toast,v=>this.savePrefs({toast:v}))),
            section('识别与通知'),row(node('span','','有 div 但没有匹配外层标记时提醒'),toggle),
            button('管理合集与识别规则',()=>this.folders(),'mn-setting'),
            button('过滤标签与剧情日期',()=>this.filterEditor(),'mn-setting'),
            button('重新扫描当前聊天',this.guard(async()=>{await e.reset(0,true);this.toast('已开始分批整理历史');}),'mn-setting'),
            section('本聊天备份'),button('导出收藏、备注与规则',this.guard(async()=>{
                const data=await db.backup(e.key),blob=new Blob([JSON.stringify(data)],{type:'application/json'});
                const a=node('a');a.href=URL.createObjectURL(blob);a.download='mnemosyne-notes.json';a.click();
                setTimeout(()=>URL.revokeObjectURL(a.href),3000);
            }),'mn-setting'));
        const file=node('input');file.type='file';file.accept='.json';file.hidden=true;
        file.onchange=this.guard(async()=>{
            if(!file.files[0])return;
            const data=JSON.parse(await file.files[0].text());
            if(!e.alive())return;
            if(!confirm('导入本聊天的收藏，并用备份中的合集和规则替换当前配置？'))return;
            for(const folder of data.book?.folders||[])validateRule(folder);
            e.resetting=true;e.epoch++;e.parser.stop();
            try{e.book=await db.restore(e.key,data);e.progress={next:0,revision:e.book.revision};e.history=true;e.recent.clear();}
            finally{e.resetting=false;e.kick();}
            if(e.alive()){this.render();this.toast('备份已导入');}
        });
        wrap.append(file,button('导入本聊天备份',()=>file.click(),'mn-setting'));
        return wrap;
    }
    filterEditor() {
        const e=this.engine,b=e.book,{el,body}=this.dialog('过滤与日期');
        const attrs=input(b.ignoreAttrs.join('\n'),'每行一个，如 data-status 或 div[data-role="status"]',true);
        const names=input(b.ignoreNames.join('\n'),'例如 状态栏，每行一个完整名称',true);
        const start=input(b.startTag),end=input(b.endTag),rs=input(b.startPattern||''), re=input(b.endPattern||'');
        body.append(field('跳过的外层标记',attrs),field('跳过的 UI 名称',names),
            node('p','mn-hint','命中任一过滤项会跳过整个块及其内部内容，也不会弹出提醒。'),
            field('剧情起始时间标签',start),field('剧情结束时间标签',end));
        const advanced=node('details');advanced.open=!!(b.startPattern||b.endPattern);
        advanced.append(node('summary','','自定义日期正则'),field('起始日期正则',rs),field('结束日期正则',re),
            node('p','mn-hint','可选。填写后优先取第一捕获组，未命中时使用时间标签。'));body.append(advanced);
        const save=button('保存',this.guard(async()=>{
            const ignored=lines(attrs.value);ignored.forEach(parseFilter);
            if(![start.value.trim(),end.value.trim()].every(validToken))throw Error('属性或标签名无效');
            for(const value of [rs.value,re.value])if(value){if(value.length>400)throw Error('日期正则过长');new RegExp(value,'u');}
            save.disabled=true;try{await this.editRules(e,book=>Object.assign(book,{
                ignoreAttrs:ignored,ignoreNames:lines(names.value),startTag:start.value.trim(),endTag:end.value.trim(),
                startPattern:rs.value.trim(),endPattern:re.value.trim()}));
                if(e.alive()){el.close();this.toast('识别设置已保存');}
            }finally{save.disabled=false;}
        }),'mn-primary');body.append(save);
    }
}
