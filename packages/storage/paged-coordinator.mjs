import { Pages } from './pages.mjs';
import { BufferedDirectory } from './paged-directory.mjs';
import { PagedJSON } from './paged-json.mjs';
import { PagedDomain, DOMAIN_TABLES } from './paged-domain.mjs';
import { compileHistory } from './paged-history.mjs';
import { compileBridge } from './paged-bridge.mjs';
import { compileMemory, compileBinding, pagedMemoryStatus } from './paged-memory.mjs';
import { canonicalize, equal, fingerprint, newId, id, requireThat as check } from '../contracts/primitives.mjs';
import { exportLogical } from '../contracts/transfer.mjs';
import { exportPageDirectory } from './paged-transport.mjs';
export const PAGED_FORMAT='mnemosyne-paged-storage-v1';
export const ROOT_SLOT=0;
const hash=value=>fingerprint('write-payload',value);
const copy=value=>structuredClone(value);
const fail=cause=>Object.assign(new Error('Paged operation outcome unknown; recover before retry',{cause}),{code:'RECOVERY_REQUIRED'});
export function sealRoot(body) { return {...body,checksum:hash(body)}; }
export function checkRoot(root) {
  check(root&&equal(Object.keys(root).sort(),['checksum','control','directory','format','library_id','status'])&&root.format===PAGED_FORMAT&&['active','staging'].includes(root.status),'NEEDS_RESOLUTION','Invalid paged root');
  const {checksum,...body}=root; check(checksum===hash(body),'NEEDS_RESOLUTION','Root checksum'); id('operation',root.library_id);
  const pointer=r=>r&&equal(Object.keys(r).sort(),['hash','slot'])&&/^[0-9a-f]{64}$/.test(r.hash)&&Number.isSafeInteger(r.slot)&&r.slot>=65536&&r.slot<2**48+65536;
  check(root.status==='staging'&&root.control===null&&root.directory===null||pointer(root.control)&&pointer(root.directory),'NEEDS_RESOLUTION','Missing checkpoint/directory pointer');
  return root;
}
export class TrackedPages extends Pages {
  constructor(io,directory=null) { super(io); this.directory=directory; this.catalog=new BufferedDirectory(io); this.registrations=new Map(); this.registered=new Map(); }
  async finishDirectory() {
    if(this.registrations.size) {
      this.directory=await this.catalog.mapSetMany(this.directory,[...this.registrations]);
      await this.catalog.finish(this.directory);
      for(const [key,value] of this.registrations) {
        this.registered.delete(key); this.registered.set(key,value);
        if(this.registered.size>512) this.registered.delete(this.registered.keys().next().value);
      }
      this.registrations.clear();
    }
  }
  async put(body) {
    const ref=await super.put(body);
    if(this.registered.has(ref.hash)) return ref;
    this.registrations.set(ref.hash,ref);
    if(this.registrations.size===1024) await this.finishDirectory();
    return ref;
  }
}
export async function compilePaged(pages,root,input,replay=null) {
  check(input&&equal(Object.keys(input).sort(),['kind','operation_id','payload']),'INVALID_SCHEMA','Durable request fields'); id('operation',input.operation_id);
  check(new TextEncoder().encode(canonicalize(input)).length<=1048576,'RESOURCE_LIMIT','Request exceeds 1MiB');
  const generated=[];
  const makeId=kind=>{
    const saved=replay?.[generated.length]; check(replay===null||saved?.kind===kind,'NEEDS_RESOLUTION','Generated ID sequence');
    const value=replay===null?newId(kind):id(kind,saved.value); generated.push({kind,value}); return value;
  };
  const d=new PagedDomain(pages,root); let result;
  if(['history','history-delta'].includes(input.kind)) result=await compileHistory(d,input,makeId);
  else if(input.kind==='memory') result=await compileMemory(d,input,makeId);
  else if(input.kind==='binding') result=await compileBinding(d,input);
  else if(input.kind==='bridge') result=await compileBridge(d,input,makeId);
  else check(false,'INVALID_SCHEMA','Unknown operation kind');
  check(replay===null||equal(replay,generated),'NEEDS_RESOLUTION','Unused generated IDs');
  return {domain:d.root,result,generated};
}
export async function readControl(pages,ref) {
  const c=await pages.get(ref);
  check(c.kind==='checkpoint'&&equal(Object.keys(c).sort(),['count','domain','journal','kind','ledger','pending','requests'])&&Number.isSafeInteger(c.count)&&c.count>=0&&(c.pending===null||typeof c.pending==='string'),'NEEDS_RESOLUTION','Malformed checkpoint');
  if(c.pending!==null) id('operation',c.pending);
  check(await pages.length(c.journal)===c.count,'NEEDS_RESOLUTION','Checkpoint journal count');
  // Verify the roots needed for direct recovery; full domain audit is explicit.
  await pages.get(c.domain); for(const r of [c.requests,c.ledger]) if(r) await pages.get(r);
  return c;
}
export async function readRequest(pages,ref) {
  const r=await pages.get(ref);
  check(r.kind==='request'&&equal(Object.keys(r).sort(),['after','base','generated','input','input_fingerprint','kind','operation_id','result']),'NEEDS_RESOLUTION','Malformed request'); id('operation',r.operation_id); return r;
}
export class PagedCoordinator {
  #io; #pages; #root=null; #control=null; #tail=Promise.resolve(); #status='recovery-required'; #epoch=0; #closed=false; #ticket=null;
  constructor(io) { this.#io=io; }
  get status() { return this.#status; }
  settled() { return this.#tail; }
  #queue(fn) { const work=this.#tail.then(fn); this.#tail=work.catch(()=>{}); return work; }
  #alive() { check(!this.#closed,'OWNER_CLOSED','Coordinator permanently closed'); }
  async #point(label,fn) { await this.#io.point?.(label,'before'); const r=await fn(); await this.#io.point?.(label,'after'); return r; }
  #measure(label,fn) { return this.#io.measure ? this.#io.measure(label,fn) : fn(); }
  async #publish(control,label='paged-publish') {
    const ref=await this.#pages.put(control);
    await this.#measure('publish.directory',()=>this.#pages.finishDirectory());
    const root=sealRoot({format:PAGED_FORMAT,library_id:this.#root.library_id,status:'active',control:ref,directory:this.#pages.directory});
    await this.#pages.catalog.finish(this.#pages.directory);
    await this.#point('paged-materials',()=>this.#io.flush());
    await this.#point(label,()=>this.#io.put(ROOT_SLOT,root));
    await this.#point('paged-flush',()=>this.#io.flush());
    await this.#point('paged-ack',async()=>{});
    this.#root=root; this.#control=control;
  }
  create() { return this.#queue(async()=>{
    this.#alive(); check(this.#root===null,'INVALID_TRANSITION','Already initialized');
    await this.#io.reopen?.(); check(typeof this.#io.assertEmpty==='function','UNSUPPORTED','Exact empty target proof required'); await this.#io.assertEmpty();
    this.#pages=new TrackedPages(this.#io); const d=await PagedDomain.empty(this.#pages);
    this.#root={library_id:newId('operation')};
    try { await this.#publish({kind:'checkpoint',domain:d.root,requests:null,ledger:null,journal:null,pending:null,count:0},'paged-create'); this.#status='ready'; return this.handle(); }
    catch(cause) { this.#status='recovery-required'; throw fail(cause); }
  }); }
  async #recover() {
    this.#alive(); this.#status='recovery-required'; this.#epoch++;
    await this.#io.reopen?.(); await this.#io.flush();
    const root=checkRoot(await this.#io.get(ROOT_SLOT)); check(root.status==='active','STAGING_IMPORT','Paged target has not activated');
    check(this.#root===null||root.library_id===this.#root.library_id,'LIBRARY_CHANGED','Different library');
    if(this.#ticket) check(equal(root,this.#ticket),'LIBRARY_CHANGED','Maintenance changed checkpoint');
    const pages=new TrackedPages(this.#io,root.directory);
    await pages.get(root.directory);
    check(equal(await pages.mapGet(root.directory,root.control.hash),root.control),'NEEDS_RESOLUTION','Checkpoint is absent from directory');
    const control=await readControl(pages,root.control);
    if(control.pending!==null) {
      const ref=await pages.mapGet(control.requests,control.pending); check(ref,'NEEDS_RESOLUTION','Missing pending request');
      const r=await readRequest(pages,ref); check(r.operation_id===control.pending&&equal(r.base,control.domain)&&await pages.mapGet(control.ledger,control.pending)===null,'NEEDS_RESOLUTION','Pending checkpoint mismatch');
      const j=new PagedJSON(pages), input=await j.read(r.input);
      check(input.operation_id===r.operation_id&&hash(input)===r.input_fingerprint,'NEEDS_RESOLUTION','Pending request fingerprint');
    }
    this.#pages=pages; this.#root=root; this.#control=control; this.#status='ready'; return this.handle();
  }
  recover() { return this.#queue(()=>{ check(!this.#ticket,'MAINTENANCE_REQUIRED','Use resume'); return this.#recover(); }); }
  async #lookup(operation) {
    id('operation',operation); const ref=await this.#pages.mapGet(this.#control.requests,operation); if(!ref) return null;
    const r=await readRequest(this.#pages,ref), j=new PagedJSON(this.#pages), input=await j.read(r.input);
    check(r.operation_id===operation&&input.operation_id===operation&&hash(input)===r.input_fingerprint,'NEEDS_RESOLUTION','Indexed request mismatch');
    const published=await this.#pages.mapGet(this.#control.ledger,operation);
    check(published===null||equal(published,ref),'NEEDS_RESOLUTION','Ledger request mismatch');
    return {status:published?'published':'prepared',input,input_fingerprint:r.input_fingerprint,generated:await j.read(r.generated),result:await j.read(r.result)};
  }
  async #prepare(input) {
    const existing=await this.#lookup(input.operation_id);
    if(existing) { check(equal(existing.input,input),'OPERATION_CONFLICT','Operation payload changed'); return existing; }
    check(this.#control.pending===null,'PENDING_OPERATION','Resolve prepared request first');
    let compiled;
    try { compiled=await this.#measure('prepare.compile',()=>compilePaged(this.#pages,this.#control.domain,input)); }
    catch(cause) {
      if(['HEAD_CONFLICT','VERSION_CONFLICT','INVALID_SCHEMA','INVALID_TRANSITION','NOT_READY','UNSUPPORTED','ID_COLLISION','RESOURCE_LIMIT'].includes(cause.code)) {
        // Compilation only wrote immutable, unpublished candidates. Discard its
        // transient directory and preserve the active checkpoint after rejection.
        this.#pages=new TrackedPages(this.#io,this.#root.directory);
        cause.pureRejection=true; throw cause;
      }
      this.#status='recovery-required'; throw cause.code?cause:fail(cause);
    }
    try {
      const j=new PagedJSON(this.#pages);
      const record=await this.#pages.put({kind:'request',operation_id:input.operation_id,input_fingerprint:hash(input),input:await j.write(input),base:this.#control.domain,after:compiled.domain,generated:await j.write(compiled.generated),result:await j.write(compiled.result)});
      const requests=await this.#pages.mapSet(this.#control.requests,input.operation_id,record);
      await this.#publish({...this.#control,requests,pending:input.operation_id},'paged-prepare');
      return this.#lookup(input.operation_id);
    } catch(cause) {
      // Rejected pure compilation can leave unreachable pages, never a new Head.
      // Unknown native outcomes still fence the owner and require recovery.
      this.#status='recovery-required';
      if(cause.code&&['HEAD_CONFLICT','VERSION_CONFLICT','INVALID_SCHEMA','INVALID_TRANSITION','NEEDS_RESOLUTION','NOT_READY','UNSUPPORTED','ID_COLLISION','RESOURCE_LIMIT'].includes(cause.code)) throw cause;
      throw fail(cause);
    }
  }
  async #execute(operation) {
    const old=await this.#lookup(operation); check(old,'UNKNOWN_OPERATION','Prepare before execution'); if(old.status==='published') return old.result;
    check(this.#control.pending===operation,'NEEDS_RESOLUTION','Not the pending request');
    const ref=await this.#pages.mapGet(this.#control.requests,operation), r=await readRequest(this.#pages,ref);
    check(equal(r.base,this.#control.domain),'HEAD_CONFLICT','Prepared base changed');
    try {
      const ledger=await this.#pages.mapSet(this.#control.ledger,operation,ref), journal=await this.#pages.concat(this.#control.journal,await this.#pages.sequence([ref]));
      await this.#publish({...this.#control,domain:r.after,ledger,journal,pending:null,count:this.#control.count+1}); return old.result;
    } catch(cause) { this.#status='recovery-required'; throw fail(cause); }
  }
  handle() {
    const epoch=this.#epoch;
    const run=fn=>{
      if(epoch!==this.#epoch) return Promise.reject(Object.assign(Error('Stale handle'),{code:'STALE_HANDLE'}));
      return this.#queue(async()=>{
        this.#alive(); check(epoch===this.#epoch,'STALE_HANDLE','Coordinator epoch changed'); check(this.#status==='ready','RECOVERY_REQUIRED','Recover native outcome');
        try {
          const root=checkRoot(await this.#io.get(ROOT_SLOT));
          check(equal(root,this.#root),'LIBRARY_CHANGED','Unexpected checkpoint change'); return await fn();
        } catch(error) { if(!error.pureRejection&&!['OPERATION_CONFLICT','PENDING_OPERATION','UNKNOWN_OPERATION'].includes(error.code)) this.#status='recovery-required'; throw error; }
      });
    };
    return Object.freeze({
      prepare:input=>{ const captured=copy(input); return run(()=>this.#prepare(captured)); },
      execute:operation=>run(()=>this.#execute(operation)), lookup:operation=>run(()=>this.#lookup(operation)),
      pending:()=>run(async()=>this.#control.pending?[await this.#lookup(this.#control.pending)]:[]),
      enumerate:(table,after=null,limit=64,checkpoint=null)=>run(async()=>{
        check(Number.isSafeInteger(limit)&&limit>0&&limit<=256,'RESOURCE_LIMIT','Enumeration page limit');
        check(checkpoint===null||equal(checkpoint,this.#root.control),'VERSION_CONFLICT','Enumeration checkpoint changed');
        const d=new PagedDomain(this.#pages,this.#control.domain), keys=[];
        for await(const [key] of this.#pages.mapEntries(await d.table(table),after)) { keys.push(key); if(keys.length===limit) break; }
        return {keys,after:keys.at(-1)??null,checkpoint:copy(this.#root.control)};
      }),
      memoryStatus:(key,branch,cutoff=null)=>run(()=>pagedMemoryStatus(new PagedDomain(this.#pages,this.#control.domain),key,branch,cutoff)),
      diagnostics:(branch=null)=>run(()=>this.#diagnostics(branch)),
      read:(table,key)=>run(()=>new PagedDomain(this.#pages,this.#control.domain).logical(table,key)),
      bridgeRead:key=>run(async()=>{
        check(typeof key==='string'&&key.startsWith('bridge-v1:'),'INVALID_SCHEMA','Bridge key required');
        return new PagedDomain(this.#pages,this.#control.domain).get('manifests',key,false);
      }),
      range:(snapshot,start=0,count=16)=>run(async()=>{check(Number.isSafeInteger(count)&&count>=0&&count<=1024,'RESOURCE_LIMIT','Read page limit');const output=[]; for await(const ref of new PagedDomain(this.#pages,this.#control.domain).entries(snapshot,start,count)) output.push(ref); return output;}),
      export:()=>run(()=>exportPageDirectory(this.#pages.catalog,this.#root.directory,{format:PAGED_FORMAT,library_id:this.#root.library_id,control:this.#root.control})),
      exportSnapshot:(branch=null)=>run(async()=>({
        diagnostic:await this.#diagnostics(branch),
        stream:exportPageDirectory(this.#pages.catalog,this.#root.directory,
          {format:PAGED_FORMAT,library_id:this.#root.library_id,control:copy(this.#root.control)}),
      })),
      logical:()=>run(()=>this.#logical()),
      audit:()=>run(async()=>{const {auditPaged}=await import('./paged-recovery.mjs');return auditPaged(new Pages(this.#io),this.#root.directory,this.#root.control);}),
    });
  }
  async #diagnostics(branchId) {
    const output={format:PAGED_FORMAT,library_id:this.#root.library_id,status:this.#status,
      checkpoint:copy(this.#root.control),operation_count:this.#control.count,
      pending_operation_id:this.#control.pending,physical_nodes:null,error:null,
      maintenance_gate:'HOST_MAINTENANCE_UNSUPPORTED',branch:null};
    if(typeof this.#io.stats==='function') output.physical_nodes=(await this.#io.stats()).nodeCount;
    if(branchId!==null) {
      const d=new PagedDomain(this.#pages,this.#control.domain), branch=await d.get('branches',branchId),
        view=await d.get('views',branchId), marker=await d.get('markers',branchId);
      output.branch={story_id:branch.story_id,branch_id:branch.branch_id,
        head_snapshot_id:branch.head_snapshot_id,view_version:view.version,marker};
    }
    return output;
  }
  async #logical() {
    const d=new PagedDomain(this.#pages,this.#control.domain), state={schema_version:1}; let objects=0,bytes=0;
    if(await d.get('manifests','bridge-v1:format',false)) throw Object.assign(new Error('Bridge materials require complete paged export; v2 would omit receipts'),{code:'UNSUPPORTED',pureRejection:true});
    for(const table of DOMAIN_TABLES) {
      state[table]={}; for await(const [key] of d.records(table)) {
        check(++objects<=4096,'RESOURCE_LIMIT','Explicit v2 materialization count'); const value=await d.logical(table,key); bytes+=new TextEncoder().encode(canonicalize(value)).length;
        check(bytes<=8*1024*1024,'RESOURCE_LIMIT','Explicit v2 materialization bytes'); state[table][key]=value;
      }
    }
    return exportLogical(state);
  }
  suspend() {
    this.#epoch++; return this.#queue(async()=>{
      this.#alive(); check(!this.#ticket,'MAINTENANCE_REQUIRED','Already suspended'); await this.#recover();
      this.#ticket=copy(this.#root); this.#status='maintenance';
      try { await this.#io.close(); return copy(this.#ticket); }
      catch(error) { this.#ticket=null; this.#status='recovery-required'; throw error; }
    });
  }
  resume(ticket) { const captured=copy(ticket); return this.#queue(async()=>{ this.#alive(); check(this.#ticket&&equal(captured,this.#ticket),'MAINTENANCE_REQUIRED','Wrong ticket'); const handle=await this.#recover(); this.#ticket=null; return handle; }); }
  close() { this.#epoch++; return this.#queue(async()=>{if(this.#closed)return;this.#status='recovery-required';await this.#io.close();this.#closed=true;this.#status='closed';}); }
}
