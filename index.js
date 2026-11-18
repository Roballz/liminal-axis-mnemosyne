import { Engine } from './lib/engine.js';
import { Host, chatKey, centeredFloor, context } from './lib/host.js';
import { button, icon, node } from './lib/dom.js';
import { View } from './lib/view.js';

let started=false;
export function activate() {
    if(started || document.getElementById('mnemosyne-notes') || !document.body || !context()) return;
    started=true;
    const root=node('div','mn-notebook');root.id='mnemosyne-notes';root.dataset.open='no';
    document.body.append(root);
    const prefs={theme:'light',side:'right',position:.54,toast:'edge',zero:false};
    try{Object.assign(prefs,JSON.parse(localStorage.getItem('mnemosyne-notes:appearance')||'{}'));}catch{}
    function apply(patch) {
        Object.assign(prefs,patch);
        root.dataset.theme=prefs.theme;root.dataset.side=prefs.side;root.dataset.toast=prefs.toast;
        root.style.setProperty('--mn-pos',(100*prefs.position)+'%');
        if(patch) localStorage.setItem('mnemosyne-notes:appearance',JSON.stringify(prefs));
    }
    apply();
    const view=new View(root,prefs,apply);
    const head=button('',null,'mn-head');head.append(icon('book'));root.append(head);
    head.title='点按收藏 · 向内滑动打开记事簿 · 长按拖动停靠';
    head.setAttribute('aria-label',head.title);
    const onBookmark=view.guard(()=>view.bookmark(centeredFloor()));
    let gesture=null,suppress=false;
    function end(ev,cancel=false) {
        if(!gesture || ev.pointerId!==gesture.id)return;
        const g=gesture;gesture=null;clearTimeout(g.hold);head.releasePointerCapture?.(ev.pointerId);
        root.classList.remove('mn-pulling','mn-dragging');head.style.transform='';
        view.panel.style.transform='';
        if(cancel){suppress=true;return;}
        if(g.drag){apply({side:ev.clientX<innerWidth/2?'left':'right',position:Math.max(.12,Math.min(.88,ev.clientY/innerHeight))});suppress=true;}
        else if(g.pull){if(g.travel>=36)view.open();suppress=true;}
        else if(Math.hypot(ev.clientX-g.x,ev.clientY-g.y)>10)suppress=true;
    }
    head.onpointerdown=ev=>{
        if(!ev.isPrimary||ev.button!==0)return;
        suppress=false;
        const g={id:ev.pointerId,x:ev.clientX,y:ev.clientY,travel:0};gesture=g;
        g.hold=setTimeout(()=>{if(gesture===g&&!g.pull){g.drag=true;root.classList.add('mn-dragging');}},350);
        head.setPointerCapture(ev.pointerId);
    };
    head.onpointermove=ev=>{
        const g=gesture;if(!g||ev.pointerId!==g.id)return;
        const dx=ev.clientX-g.x,dy=ev.clientY-g.y,d=prefs.side==='left'?dx:-dx;
        if(g.drag){head.style.transform='translate('+dx+'px,calc(-50% + '+dy+'px))';return;}
        if(Math.abs(dx)+Math.abs(dy)>8)clearTimeout(g.hold);
        if(d>8 && Math.abs(dx)>Math.abs(dy) && !g.pull){
            g.pull=true;g.width=view.panel.getBoundingClientRect().width;root.classList.add('mn-pulling');
            // Mount the visible directory during the gesture. Full backfill begins on release.
            view.opened=true;view.render();
        }
        if(g.pull){g.travel=Math.max(0,d);const hidden=Math.max(0,g.width-g.travel);
            view.panel.style.transform='translateX('+(prefs.side==='left'?-hidden:hidden)+'px)';}
    };
    head.onpointerup=ev=>{const pull=gesture?.pull,dist=gesture?.travel;end(ev);
        if(pull&&dist<36)view.close();};
    head.onpointercancel=ev=>{const pull=gesture?.pull;end(ev,true);if(pull)view.close();};
    head.onclick=ev=>{if(suppress&&ev.detail){suppress=false;return;}onBookmark();};
    head.onkeydown=ev=>{if(ev.key==='ArrowLeft'||ev.key==='ArrowRight'){ev.preventDefault();view.open();}};
    document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&view.opened&&!view.modal)view.close();});

    function mount(element) {
        const container=element.querySelector('.mes_block')||element;
        if(container.querySelector(':scope > .mn-floor-action'))return;
        container.classList.add('mn-floor-host');
        const b=button('',view.guard(()=>view.bookmark(Number(element.getAttribute('mesid')))),'mn-floor-action');
        b.title='收藏此楼';b.setAttribute('aria-label',b.title);b.append(icon('mark'));container.append(b);
        return ()=>{b.remove();container.classList.remove('mn-floor-host');};
    }
    const surface=globalThis.__TAURITAVERN__?.api?.chatSurface;
    let observed=null, observer=null;
    const managed=surface?.isManagedOwnershipRequired?.()===true;
    function attach() {
        if(managed)return;
        const chat=document.querySelector('#chat');if(!chat||chat===observed)return;
        observer?.disconnect();observed=chat;
        for(const el of chat.querySelectorAll(':scope > .mes'))mount(el);
        observer=new MutationObserver(entries=>{
            for(const rec of entries)for(const el of rec.addedNodes)if(el.nodeType===1&&el.matches('.mes'))mount(el);
        });observer.observe(chat,{childList:true});
    }
    if(managed)surface.registerParticipant({id:'mnemosyne-notes/bookmark',protocolVersion:1,didMount:({element})=>mount(element)});

    let engine=null,binding=null;
    function menu() {
        const wrapper=document.querySelector('#extensions_settings2')||document.querySelector('#extensions_settings');
        if(wrapper&&!document.getElementById('mn-open-settings')){
            const b=button('打开 Mnemosyne记事簿',()=>view.open(),'menu_button');b.id='mn-open-settings';wrapper.append(b);
        }
    }
    async function bind() {
        attach();menu();
        const key=chatKey();
        if(engine?.key===key)return binding;
        engine?.dispose();engine=null;view.setEngine(null);
        if(!key)return;
        const e=new Engine(new Host(key),{changed:k=>view.changed(k),zero:()=>prefs.zero,
            notice:(floor,scan)=>view.notice(floor,scan),error:err=>view.error(err)});
        engine=e;
        binding=e.init().then(()=>{if(engine!==e||!e.alive())return;
            view.setEngine(e);if(view.opened)e.open();e.kick();}).catch(err=>{
            if(engine===e){e.dispose();engine=null;view.error(err);}
        });
        return binding;
    }
    const ctx=context(), events=ctx.eventSource, types=ctx.eventTypes||ctx.event_types;
    const on=(key,fn)=>{if(types?.[key])events.on(types[key],(...args)=>{view.guard(fn)(...args);});};
    on('CHAT_CHANGED',bind);on('APP_READY',bind);
    for(const type of ['MESSAGE_RECEIVED','MESSAGE_SENT','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','GENERATION_ENDED']){
        on(type,async id=>{
            const key=chatKey();await bind();const e=engine;if(!e||e.key!==key)return;
            const floor=type==='GENERATION_ENDED' || !Number.isInteger(id) ? context().chat.length-1:id;
            if(floor>=0)e.dirty(e.host.offset+floor,true);
        });
    }
    on('MESSAGE_DELETED',async()=>{
        const key=chatKey();await bind();const e=engine;if(!e||e.key!==key)return;
        const prior=e.host.tail;
        const count=await e.host.sync();if(!e.alive())return;
        const last=context().chat.at(-1);
        const onlyTail=prior && count<prior.total && last && prior.messages.get(count-1)===last;
        await e.reset(onlyTail?count:0,true);
    });
    bind();
}
// Some older frontends load the module without manifest hooks.
async function legacyReady() {
    await (globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__);
    activate();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',legacyReady,{once:true});
else queueMicrotask(legacyReady);
