// The panel and integration tests share this exact subscription/dispatch path.
export class BridgeEvents {
  constructor(source,{show=()=>{},onSwitch=()=>{}}={}) {
    this.source=source;this.show=show;this.onSwitch=onSwitch;this.importer=null;this.active=null;
    this.epoch=0;this.tail=Promise.resolve();this.dirty=new Set();this.hint=null;
    this.unsubscribe=source.subscribe(notice=>this.enqueue(notice));
  }
  bind(importer,source){this.importer=importer;this.active=source;this.epoch++;this.dirty.clear();this.hint=null;}
  settled(){return this.tail;}
  stop(){this.epoch++;this.unsubscribe();return this.tail;}
  enqueue(notice) {
    if(notice.name==='CHAT_CHANGED') {
      this.importer?.cancel();this.epoch++;this.active=null;this.dirty.clear();this.hint=null;this.onSwitch();
      this.show('聊天已切换，请重新核对绑定。');return;
    }
    const epoch=this.epoch,source=this.active,importer=this.importer;
    if(!source||!importer)return;
    if(['MESSAGE_RECEIVED','MESSAGE_UPDATED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','GENERATION_ENDED','GENERATION_STOPPED'].includes(notice.name))this.hint=notice;
    this.tail=this.tail.then(async()=>{
      if(epoch!==this.epoch)return;
      const bound=await importer.record('binding',source);if(!bound?.sync)return;
      if(notice.name==='GENERATION_STARTED') {
        if(bound.status==='complete')await importer.setState(source,'pending','generation-in-progress');
        this.show('生成中，等待稳定结果；不判作永久删除。');return;
      }
      if(notice.generating||this.source.generating||notice.generation!==this.source.generation)return;
      if(bound.status==='paused'||bound.status==='partial'||bound.status==='importing')return;
      try {
        const current=await this.source.identity();
        if(epoch!==this.epoch||await importer.storageSource(current)!==source)return;
        if(notice.name==='LEGACY_CHANGED'&&!this.hint&&bound.status==='complete') {await this.legacy(importer,bound);return;}
        const dispatch=notice.name==='LEGACY_CHANGED'?(this.hint??notice):notice;
        const total=current.ctx.chat.length,ended=['GENERATION_ENDED','GENERATION_STOPPED'].includes(dispatch.name)||bound.status==='pending';
        let start=dispatch.index,kind;
        if(total>bound.count) {
          if(dispatch.name==='MESSAGE_DELETED'||ended&&dispatch.generationKind==='regenerate')throw Object.assign(Error('Ambiguous generation range'),{code:'NOT_READY'});
          kind='append';start=bound.count;
        } else if(total===bound.count&&total>0) {
          if(ended){kind=dispatch.generationKind==='regenerate'?'regenerate':'edit';start=total-1;}
          else if(['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_RECEIVED','MESSAGE_SWIPED'].includes(dispatch.name)) {
            kind=dispatch.name==='MESSAGE_SWIPED'?'swipe':'edit';start=Number.isSafeInteger(start)?start:total-1;
          }
        }
        if(!kind||!Number.isSafeInteger(start)||start<0)throw Object.assign(Error('聊天删除或复杂变化需要核对'),{code:'NOT_READY'});
        const change=await this.source.captureLocal(start,kind==='append'?16:1);
        if(epoch!==this.epoch)return;
        if(ended&&change.messages.some(m=>m.role==='assistant'&&!m.content.trim()))throw Object.assign(Error('Generation has no confirmed output'),{code:'NOT_READY'});
        // End is not proof of a successful replacement. The raw revision,
        // count, mapped neighbors and final generation guard supply the evidence.
        await importer.applyLocal(change,kind);
        this.hint=null;
        for(const m of change.messages)if(m.role==='assistant')this.dirty.add(m.floor);
        if(notice.name==='LEGACY_CHANGED')await this.legacy(importer,await importer.record('binding',source));
        this.show('已核对并保存局部正文变化。');
      }catch(error){
        if(epoch!==this.epoch)return;
        if(notice.generation!==this.source.generation&&error.code==='VERSION_CONFLICT')return;
        await importer.setState(source,'paused',{kind:'source-review',code:error.code??'ERROR'});
        this.show('变化需要人工核对；当前绑定暂停，旧档案保留。');
      }
    }).catch(e=>this.show({code:e.code??'ERROR',message:e.message}));
  }
  async legacy(importer,bound) {
    const session=await importer.record('session',bound.session);
    const change=await this.source.captureLegacy(session.report.sourceReport.legacy_selection,session.categories,[...this.dirty]);
    await importer.applyLegacy(change);this.dirty.clear();this.show('旧资料白名单已核对；无变化不会创建新版本。');
  }
}
