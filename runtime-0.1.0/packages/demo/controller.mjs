import { Importer } from '../bridge/importer.mjs';
import { recordKey, digest } from '../bridge/records.mjs';
import { requireThat as check } from '../contracts/primitives.mjs';
import { Workbench } from '../workbench/service.mjs';

// Named archives are independent bound stories in one existing B physical library.
// The manifest is recoverable bridge metadata, never a localStorage authority.
export class Demo {
  constructor(handle, source) {
    this.h=handle;this.source=source;this.importer=new Importer(handle,input=>source.guard(input));
    this.workbench=new Workbench(handle);this.plan=null;this.selected=null;this.busy=false;
  }
  invalidate() { this.plan=null;this.importer.cancel();this.workbench.cancel(); }
  async catalog(after=null) {
    const w=this.workbench,b=w.budget(10000),generation=w.generation;
    const state=await w.read({kind:'state'},b,generation),s={stamp:state.stamp,generation};
    const page=await w.read({kind:'list',table:'manifests',prefix:'bridge-v1:demoArchive:',
      after,limit:8,stamp:s.stamp},b,generation);
    const items=[];
    for(const key of page.keys)items.push(await w.record('manifests',key,b,s));
    await w.fence(s);return {...page,items};
  }
  async current() {
    const identity=await this.source.identity();
    const source=await this.importer.storageSource(identity);
    return {source,archive:await this.importer.record('demoArchive',source),
      binding:await this.importer.record('binding',source)};
  }
  async select(archive) {
    this.plan=null;this.selected=archive;
    const selected=await this.workbench.select({branch:archive.branch,bindingSource:archive.source,demo:true});
    this.selected=archive;return selected;
  }
  async preview(name,{sync=false}={}) {
    check(!this.busy,'BUSY','同步仍在排空');this.invalidate();
    check((await this.h.pending()).length===0,'PENDING_OPERATION','有待恢复操作，请先显式恢复');
    const input=await this.source.capture([]);
    check(input.assets.length<=512,'RESOURCE_LIMIT','临时 demo 每次最多读取512条已有摘要；未写入');
    const storageSource=await this.importer.storageSource(input);
    const archive=await this.importer.record('demoArchive',storageSource);
    if(sync)check(this.selected?.source===storageSource,'INVALID_SCOPE','请切回所选档案绑定的原聊天再同步');
    else check(!archive,'ALREADY_BOUND','当前聊天已有档案，请选择它后同步');
    const title=archive?.name??String(name).trim();
    check(title.length>0&&title.length<=80,'INVALID_SCHEMA','库名需要1～80个字符');
    const plan=await this.importer.preview(input,{mode:'new'});
    check(!plan.report.locator_confirmation,'NOT_READY','聊天位置/身份变化，demo 不自动判断重命名或分支');
    this.plan={plan,title,input};return {...plan.report,name:title};
  }
  async confirm() {
    check(!this.busy&&this.plan,'NOT_READY','先预览当前聊天');
    const prepared=this.plan;this.busy=true;this.plan=null;this.workbench.cancel();
    try {
      // Re-read once at the explicit confirm boundary, including source content.
      const latest=await this.source.capture([]);
      check(latest.fingerprint===prepared.input.fingerprint&&latest.generation===prepared.input.generation,
        'VERSION_CONFLICT','聊天或摘要已变化，请重新预览');
      const bound=await this.importer.confirm(prepared.plan);
      check(bound.status==='complete','NOT_READY','同步尚未完整完成，请保留原聊天后重试');
      const assets=[];
      for(const a of prepared.plan.input.assets) {
        const map=await this.importer.record('assetMap',digest({source:bound.source,id:a.source_id}));
        check(map?.fingerprint===digest(a.data),'VERSION_CONFLICT','摘要映射与本次同步不同');
        assets.push(recordKey('asset',map.asset));
      }
      await this.source.guard(prepared.input);
      const value={version:1,type:'demoArchive',source:bound.source,name:prepared.title,branch:bound.target.branch_id,
        head:bound.target.head,session:bound.session,assets,updated_at:new Date().toISOString()};
      await this.importer.transact({target:bound.target,records:[await this.importer.putRecord('demoArchive',bound.source,value)]});
      await this.source.guard(prepared.input);
      await this.select(value);return value;
    } finally {this.busy=false;}
  }
  search(query,options={}) {return this.workbench.search(query,{legacy:true,...options});}
  next() {return this.workbench.next();}
  detail(item) {return this.workbench.detail(item);}
  export() {return this.workbench.export();}
  async recoverPending() {
    check(!this.busy,'BUSY','请等待同步排空');this.invalidate();
    await this.importer.recoverPending();
  }
  close() {this.invalidate();}
}
