import { equal, requireThat as check } from '../contracts/primitives.mjs';
import { recordKey, digest } from '../bridge/records.mjs';
import { normalize, NORMALIZATION } from './normalize.mjs';

export const LIMITS = Object.freeze({ messages:32, results:20, bytes:2097152, reads:2048,
  textBytes:262144, milliseconds:1000, queryBytes:4096, exportBytes:16777216 });
const size = text => new TextEncoder().encode(text).length;
const error = (code, message) => Object.assign(Error(message), {code});
const short = text => text.slice(0,320);

// Every public read uses the existing owner. Closing this object never closes that owner.
export class Workbench {
  constructor(handle, limits = {}) {
    this.h=handle; this.limits={...LIMITS,...limits}; this.generation=0; this.session=null;
    this.hits=new WeakMap(); this.cursor=null; this.busy=false;
  }
  cancel() { this.generation++; this.session=null; this.cursor=null; this.hits=new WeakMap(); }
  close() { this.cancel(); }
  budget(milliseconds=this.limits.milliseconds) { return { bytes:this.limits.bytes, reads:this.limits.reads, text:this.limits.textBytes,
    deadline:Date.now()+milliseconds }; }
  async read(request, budget, generation=this.generation) {
    check(generation===this.generation,'CANCELLED','读取已取消');
    const r=await this.h.readView({...request,maxBytes:budget.bytes,maxReads:Math.min(256,budget.reads),deadline:budget.deadline});
    budget.bytes-=r.bytes+8192; budget.reads-=r.reads+1; // include coordinator's root check
    check(generation===this.generation,'CANCELLED','读取已取消');
    if(r.limited)throw error('READ_LIMIT','本批未检查完；可继续或缩小范围');
    return r.value;
  }
  record(table,key,b,s,optional=false) { return this.read({kind:'record',table,key,optional,stamp:s?.stamp},b,s?.generation); }
  async fence(s) {
    check(s.generation===this.generation,'CANCELLED','读取已取消');
    // Final cheap checkpoint check is outside the scan budget, never a new scan page.
    const r=await this.h.readView({kind:'state',stamp:s.stamp});
    check(s.generation===this.generation,'CANCELLED','读取已取消');
    check(!r.limited,'READ_LIMIT','无法核对档案版本');
  }
  async catalog({after=null,kind='bindings',stamp=null}={}) {
    const generation=this.generation,b=this.budget(10000);
    const state=await this.read({kind:'state',stamp},b,generation);
    const s={stamp:state.stamp,generation};
    const page=await this.read({kind:'list',table:kind==='bindings'?'manifests':'branches',
      prefix:kind==='bindings'?'bridge-v1:binding:':'',after,limit:4,stamp:s.stamp},b,generation);
    const items=[];
    for(const key of page.keys) {
      const v=await this.record(kind==='bindings'?'manifests':'branches',key,b,s);
      const branch=kind==='bindings'?v.target.branch_id:v.branch_id;
      const story=kind==='bindings'?v.target.story_id:v.story_id;
      const identity=kind==='bindings'?await this.record('manifests',recordKey('identity',v.source),b,s,true):null;
      const sourceLabel=identity?.locator?.fileName??v.source?.slice(0,20);
      items.push({branch,story,bindingSource:kind==='bindings'?v.source:null,
        label:`${story.slice(-8)} / ${branch.slice(-8)}${kind==='bindings'?` · ${sourceLabel} · ${v.status}`:''}`});
    }
    await this.fence(s);return {...page,items,stamp:s.stamp};
  }
  async preferredBinding(source) {
    if(!source)return null;
    const b=this.budget(10000),generation=this.generation;
    const state=await this.read({kind:'state'},b,generation),s={stamp:state.stamp,generation};
    const v=await this.record('manifests',recordKey('binding',source),b,s,true);
    await this.fence(s);
    return v?{branch:v.target.branch_id,story:v.target.story_id,bindingSource:source,
      label:'打开工作台时已确认的当前绑定 · '+v.target.branch_id.slice(-8)}:null;
  }
  async select({branch,snapshot=null,bindingSource=null,allowLast=false,demo=false}) {
    this.cancel();const generation=this.generation,b=this.budget(10000);
    const state=await this.read({kind:'state',branch},b,generation);
    check(state.branch?.head_snapshot_id,'NOT_READY','此分支没有已发布档案');
    const s={generation,stamp:state.stamp,branch,story:state.branch.story_id,
      snapshot:snapshot??state.branch.head_snapshot_id,historical:!!snapshot&&snapshot!==state.branch.head_snapshot_id,
      pending:state.pending,bindingSource};
    const snap=await this.record('snapshots',s.snapshot,b,s);
    check(snap.branch_id===branch&&snap.story_id===s.story,'INVALID_SCOPE','快照不属于所选分支');
    s.count=snap.message_count;s.previous=snap.previous_snapshot_id;
    const binding=bindingSource?await this.record('manifests',recordKey('binding',bindingSource),b,s):null;
    check(!binding||binding.target.branch_id===branch&&binding.target.story_id===s.story,'INVALID_SCOPE','绑定与分支不同');
    s.status=binding?.status??'archive-only';s.reason=binding?.reason??null;
    s.progress=binding?{count:binding.count,session:binding.session}:null;
    if(binding) {
      const session=await this.record('manifests',recordKey('session',binding.session),b,s);
      s.progress={count:session.cursor,total:session.total,assets:session.assetCursor,assetTotal:session.assetTotal};
    }
    check(allowLast||!state.pending&&(!binding||binding.status==='complete'),'LAST_ARCHIVE_REQUIRED',
      '导入 pending/partial/paused：请明确选择最后确认的已发布档案；阅读不会解除暂停');
    if(demo) {
      check(binding?.status==='complete'&&!state.pending&&!s.historical,'NOT_READY','先完成手动同步');
      const archive=await this.record('manifests',recordKey('demoArchive',bindingSource),b,s);
      check(archive.branch===branch&&archive.head===s.snapshot&&archive.session===binding.session,
        'VERSION_CONFLICT','档案目录未完成更新，请在原聊天手动同步');
      s.observedAssets=archive.assets;s.offset=binding.offset;
    }
    await this.fence(s);this.session=s;
    return {...s,stamp:structuredClone(s.stamp),notice:s.historical?'历史档案，不是当前剧情':
      state.pending||binding&&binding.status!=='complete'?'最后确认的已发布档案，尚未完整同步':'已发布档案；不保证宿主此刻同步'};
  }
  async previous() {
    const s=this.session;check(s,'NOT_READY','先选择档案');await this.fence(s);
    return s.previous;
  }
  async search(query,{mode='tolerant',legacy=false,legacyHistory=false,browse=false,swipes=false}={}) {
    check(!this.busy,'BUSY','上一读取仍在排空');
    check(this.session,'NOT_READY','先选择档案');
    check(typeof query==='string'&&size(query)<=this.limits.queryBytes,'QUERY_LIMIT','查询过长（上限4096 UTF-8字节）');
    const projection=normalize(query,mode);
    if(!browse&&!projection.length){this.cursor=null;return {status:'empty-query',items:[],scanned:0};}
    const base=this.session;
    this.generation++;this.hits=new WeakMap();
    const s={...base,generation:this.generation,query:projection,mode,legacy,legacyHistory,browse,swipes,normalization:NORMALIZATION};
    this.session=s;this.cursor={session:s,index:0,assetAfter:null,assetIndex:0,phase:'body',scanned:0};
    return this.next(this.cursor);
  }
  async next(cursor=this.cursor) {
    check(!this.busy,'BUSY','上一读取仍在排空');
    check(cursor&&cursor===this.cursor&&cursor.session===this.session,'INVALID_CURSOR','游标已失效');
    this.busy=true;
    const s=this.session,b=this.budget(),c={...cursor},items=[];let count=0,limitReason=null;
    try {
      await this.fence(s);
      while(count<this.limits.messages&&items.length<this.limits.results&&c.phase!=='done') {
        if(Date.now()>=b.deadline){limitReason='time';break;}
        if(c.phase==='body') {
          if(c.index>=s.count){c.phase=s.legacy?'assets':'done';continue;}
          const ref=await this.read({kind:'entry',snapshot:s.snapshot,index:c.index,stamp:s.stamp},b,s.generation);
          check(ref,'NEEDS_RESOLUTION','快照成员缺失');
          const r=await this.record('revisions',ref.revision_id,b,s);
          check(r.message_id===ref.message_id,'NEEDS_RESOLUTION','消息版本引用错误');
          const bytes=size(r.content);if(bytes>b.text){limitReason='text';break;}
          const projected=normalize(r.content,s.mode);
          if(size(projected)>b.text){limitReason='projection';break;}
          b.text-=Math.max(bytes,size(projected));
          if(s.browse||projected.includes(s.query)) {
            const item={kind:'body',...ref,snapshot_id:s.snapshot,story_id:s.story,branch_id:s.branch,
              index:c.index,role:r.role,snippet:short(r.content),mode:s.mode,
              match:s.mode==='tolerant'?'规范化命中（不映射高亮）':'原样精确',historical:s.historical};
            this.hits.set(item,{s,index:c.index,ref});items.push(item);
          }
          if(s.swipes&&! (s.browse||projected.includes(s.query))) {
            check(s.observedAssets,'INVALID_SCOPE','Swipe 搜索仅支持完整同步的当前档案');
            const map=await this.record('manifests',recordKey('map',s.bindingSource+'/'+(c.index-s.offset)),b,s);
            check(equal(map.ref,ref),'NEEDS_RESOLUTION','Swipe 当前正文映射不一致');
            const matches=[];
            for(let slot=0;slot<map.candidates.values.length;slot++) {
              const text=map.candidates.values[slot];if(text===null||text===r.content)continue;
              const projected=normalize(text,s.mode),bytes=Math.max(size(text),size(projected));
              check(bytes<=b.text,'READ_LIMIT','Swipe 候选超过本批文本预算');b.text-=bytes;
              if(s.browse||projected.includes(s.query))matches.push(slot);
            }
            if(matches.length) {
              const item={kind:'swipe',...ref,index:c.index,role:r.role,slots:matches,
                snippet:short(map.candidates.values[matches[0]]),historical:true};
              this.hits.set(item,{s,index:c.index,ref,candidates:matches});items.push(item);
            }
          }
          c.index++;c.scanned++;count++;
        } else {
          const page=s.observedAssets ? {keys:s.observedAssets.slice(c.assetIndex,c.assetIndex+1),
            done:c.assetIndex+1>=s.observedAssets.length} : await this.read({kind:'list',table:'manifests',prefix:'bridge-v1:asset:',
            after:c.assetAfter,limit:1,stamp:s.stamp},b,s.generation);
          if(!page.keys.length){c.phase='done';break;}
          const key=page.keys[0],a=await this.record('manifests',key,b,s);
          const scopeMatches=a.scope?.story_id===s.story&&a.scope?.branch_id===s.branch;
          const pointer=scopeMatches?await this.record('manifests',recordKey('assetMap',digest({source:a.source,id:a.source_id})),b,s):null;
          const current=scopeMatches&&a.scope.snapshot_id===s.snapshot&&pointer.asset===key.slice('bridge-v1:asset:'.length);
          if(['summary','higher'].includes(a.category)&&scopeMatches&&(current||s.legacyHistory||s.observedAssets&&pointer?.asset===key.slice('bridge-v1:asset:'.length))) {
            const text=a.data.text??'',bytes=size(text),projected=normalize(text,s.mode);
            if(Math.max(bytes,size(projected))>b.text){limitReason='text';break;}
            b.text-=Math.max(bytes,size(projected));
            if(s.browse||projected.includes(s.query)) {
              const item={kind:a.category,level:a.category==='summary'?0:(Number.isInteger(a.data.level)?a.data.level:null),key,snippet:short(text),declaration:a.declaration,scope:a.scope,
                historical:!current,mode:s.mode,source_id:a.source_id,anchor:a.anchor};
              this.hits.set(item,{s,key});items.push(item);
            }
          }
          c.assetAfter=key;c.assetIndex++;count++;if(page.done)c.phase='done';
        }
      }
      if(c.phase==='body'&&c.index===s.count&&!s.legacy)c.phase='done';
    } catch(e) {
      if(e.code!=='READ_LIMIT'){this.busy=false;throw e;}
      limitReason='read-or-object-limit';
    }
    try {
    await this.fence(s);
    this.cursor=c.phase==='done'?null:c;
    return {status:c.phase==='done'?'exhausted':'partial',items,cursor:this.cursor,
      scanned:c.scanned,total:s.count,phase:c.phase,limitReason,
      unchecked:limitReason?{index:c.index,assetAfter:c.assetAfter}:null};
    } finally { this.busy=false; }
  }
  async detail(item) {
    const hit=this.hits.get(item);check(hit&&hit.s===this.session,'STALE_READ','结果不属于当前查询');
    const s=hit.s,b=this.budget(10000);await this.fence(s);
    let output;
    if(hit.ref) {
      output=await this.context(s,hit.index,hit.ref,b);
      if(hit.candidates) {
        const map=await this.record('manifests',recordKey('map',s.bindingSource+'/'+(hit.index-s.offset)),b,s);
        check(equal(map.ref,hit.ref),'NEEDS_RESOLUTION','Swipe 映射变化');
        output.candidates=hit.candidates.map(slot=>({slot,content:map.candidates.values[slot]}));
        check(output.candidates.reduce((n,c)=>n+size(c.content),0)<=b.text,'READ_LIMIT','候选详情过大');
        output.notice='已保存的 Swipe 候选，不是当前正文；下面附当前正文上下文';
      }
    }
    else {
      const asset=await this.record('manifests',hit.key,b,s);
      check(asset.scope.story_id===s.story&&asset.scope.branch_id===s.branch,'NEEDS_RESOLUTION','摘要作用域损坏');
      output={asset,sourceNotice:'旧摘要完整生成输入未证明；锚不等于完整 User+Assistant 生成来源',context:null};
      // The recorded anchor is only a floor. Require exact map membership and scope;
      // a current mapping cannot prove an older snapshot's anchor.
      if(asset.scope.snapshot_id===s.snapshot&&Number.isSafeInteger(asset.anchor)) {
        const binding=await this.record('manifests',recordKey('binding',asset.source),b,s,true);
        const map=await this.record('manifests',recordKey('map',`${asset.source}/${asset.anchor}`),b,s,true);
        if(map) {
          const original=await this.record('revisions',map.ref.revision_id,b,s);
          const message=await this.record('messages',map.ref.message_id,b,s);
          check(original.message_id===map.ref.message_id&&message.story_id===s.story&&
            map.fingerprint===digest({role:original.role,content:original.content}), 'NEEDS_RESOLUTION','来源正式映射损坏');
        }
        if(binding?.target.branch_id===s.branch&&binding.target.head===s.snapshot&&map) {
          const index=asset.anchor+binding.offset;
          const ref=await this.read({kind:'entry',snapshot:s.snapshot,index,stamp:s.stamp},b,s.generation);
          if(equal(ref,map.ref))output.context=await this.context(s,index,ref,b);
        }
      }
      if(!output.context)output.sourceNotice+='；来源关系未证明/无可追溯原文';
    }
    await this.fence(s);return output;
  }
  async context(s,index,expected,b) {
    const rows=[];
    for(let i=Math.max(0,index-1);i<Math.min(s.count,index+2);i++) {
      const ref=await this.read({kind:'entry',snapshot:s.snapshot,index:i,stamp:s.stamp},b,s.generation);
      check(ref&& (i!==index||equal(ref,expected)),'NEEDS_RESOLUTION','快照正式引用损坏');
      const revision=await this.record('revisions',ref.revision_id,b,s);
      const message=await this.record('messages',ref.message_id,b,s);
      check(revision.message_id===ref.message_id&&message.story_id===s.story,'NEEDS_RESOLUTION','原文身份损坏');
      b.text-=size(revision.content);check(b.text>=0,'READ_LIMIT','邻接正文超过显示预算');
      rows.push({index:i,...ref,role:revision.role,content:revision.content});
    }
    return {snapshot_id:s.snapshot,rows,notice:'位置为档案序号；不推断当前 TT 楼层'};
  }
  async locate(item) {
    await this.detail(item);
    return {available:false,reason:'当前安装版未接入经过核验的公开定位能力；已回退 Mnemosyne 固定版本原文，未切换宿主聊天。'};
  }
  async export() {
    const generation=this.generation;
    const {diagnostic,stream}=await this.h.exportSnapshot();
    const chunks=[];let bytes=0;
    try {
      for await(const chunk of stream) {
        check(generation===this.generation,'CANCELLED','导出已取消');
        bytes+=typeof chunk==='string'?size(chunk):chunk.byteLength;check(bytes<=this.limits.exportBytes,'EXPORT_LIMIT','超过16 MiB下载上限，未生成完整备份');
        chunks.push(chunk);
      }
      check(generation===this.generation,'CANCELLED','导出已取消');
      return {blob:new Blob(chunks,{type:'application/x-ndjson'}),bytes,checkpoint:diagnostic.checkpoint,
        library:diagnostic.library_id,scope:'完整库恢复包（含桥接资料/回执），固定导出checkpoint'};
    } finally { await stream.return?.(); }
  }
}
