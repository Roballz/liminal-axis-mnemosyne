import { equal, requireThat as check } from '../contracts/primitives.mjs';
import { validate } from '../contracts/schema.mjs';
import { derivedFingerprint } from '../contracts/memory.mjs';
import { MemoryWork } from './memory-work.mjs';
async function span(d,snapshot,coverage,work) {
  work.step();
  if(!coverage.boundary) return [];
  const start=await d.member(snapshot,coverage.boundary.start), end=await d.member(snapshot,coverage.boundary.end);
  if(!start||!end||start.label>end.label) return null;
  const {order}=await d.get('historyIndex',snapshot), actual=[start.entry];
  if(start.label!==end.label) for await(const [key,ref] of d.pages.mapEntries(order,start.label)) {
    work.step();
    if(key>end.label) break;
    actual.push((await d.pages.get(ref)).entry);
    // A mismatch can be rejected without retaining an unbounded span.
    if(actual.length>coverage.observed_span.length) return null;
  }
  return actual;
}
async function fits(d,m,snapshot,work) {
  return work.run('fits',snapshot+':'+m.memory_revision_id,async()=>{
  const basis=await d.get('snapshots',snapshot);
  if(m.origin==='derived_only') {
    const old=await d.get('snapshots',m.basis_snapshot_id);
    if(m.scope_branch_id!==basis.branch_id||old.message_count>basis.message_count) return false;
    work.step(old.message_count);
    return d.samePrefix(old.snapshot_id,snapshot,old.message_count);
  }
  if(!equal(await span(d,snapshot,m.coverage,work),m.coverage.observed_span)) return false;
  for(const ref of m.input_refs) {
    work.step();
    if(ref.type==='source') { const item=await d.member(snapshot,ref.message_id); if(!item||item.entry.revision_id!==ref.revision_id) return false; }
    else if(!await fits(d,await d.get('memories',ref.memory_revision_id),snapshot,work)) return false;
  }
  return true;
  });
}
export async function checkPagedMemory(d,m,work=new MemoryWork()) {
  return work.run('validate',m.memory_revision_id,async()=>{
  validate('memory',m);
  const basis=await d.get('snapshots',m.basis_snapshot_id), coverage=m.coverage;
  check(basis.story_id===m.story_id&&m.input_fingerprint===derivedFingerprint(m),'NEEDS_RESOLUTION','Memory basis/fingerprint');
  let previous=null;
  for(const source of coverage.members) {
    work.step();
    const item=await d.member(basis.snapshot_id,source.message_id);
    check(item&&equal(item.entry,source)&&(previous===null||item.label>previous),'NEEDS_RESOLUTION','Coverage source/order'); previous=item.label;
  }
  check(equal(coverage.boundary,coverage.members.length?{start:coverage.members[0].message_id,end:coverage.members.at(-1).message_id}:null)&&equal(await span(d,basis.snapshot_id,coverage,work),coverage.observed_span)&&
    (coverage.mode!=='interval'||equal(coverage.members,coverage.observed_span)),'NEEDS_RESOLUTION','Coverage does not match basis');
  if(m.origin==='derived_only') {
    check(m.input_refs.length===0&&coverage.members.length===0&&m.source_declaration!==null&&m.scope_branch_id===basis.branch_id,'NEEDS_RESOLUTION','Derived-only declaration/scope'); return;
  }
  check(m.input_refs.length>0&&coverage.members.length>0&&m.source_declaration===null&&m.scope_branch_id===null,'NEEDS_RESOLUTION','Source-derived inputs');
  const evidence=new Set();
  for(const ref of m.input_refs) {
    work.step();
    if(ref.type==='source') {
      const item=await d.member(basis.snapshot_id,ref.message_id);
      check(item&&item.entry.revision_id===ref.revision_id,'NEEDS_RESOLUTION','Input outside basis'); evidence.add(ref.message_id+ref.revision_id);
    } else {
      const child=await d.get('memories',ref.memory_revision_id);
      check(child.story_id===m.story_id&&child.memory_id===ref.memory_id,'NEEDS_RESOLUTION','Memory input owner');
      await checkPagedMemory(d,child,work);
      if(ref.dependency_mode==='checkpoint') check(m.kind==='Record'&&child.memory_id===m.memory_id&&child.origin==='source_derived'&&child.coverage.members.length<coverage.members.length&&equal(child.coverage.members,coverage.members.slice(0,child.coverage.members.length)),'INVALID_TRANSITION','Checkpoint prefix');
      check(await fits(d,child,basis.snapshot_id,work),'NEEDS_RESOLUTION','Dependency not applicable to basis');
      work.step(child.coverage.members.length);
      child.coverage.members.forEach(s=>evidence.add(s.message_id+s.revision_id));
    }
  }
  check(coverage.members.every(s=>evidence.has(s.message_id+s.revision_id)),'NEEDS_RESOLUTION','Unread coverage');
  if(m.kind==='TurnMemory') check(coverage.mode==='interval'&&coverage.members.length===2&&
    (await d.get('revisions',coverage.members[0].revision_id)).role==='user'&&(await d.get('revisions',coverage.members[1].revision_id)).role==='assistant','UNSUPPORTED','Explicit adjacent user/assistant pair required');
  });
}
export async function target(d,branch,ref,work=new MemoryWork()) {
  work.step();
  const key=ref.dependency_mode==='checkpoint'?ref.memory_revision_id:await d.viewValue(branch,'selections',ref.memory_id);
  async function resolve(key) {
    if(!key) return key;
    return work.run('corrections',branch+':'+key,async()=>{
      const next=await d.viewValue(branch,'corrections',key);return next?resolve(next):key;
    });
  }
  return resolve(key);
}
export async function checkPagedGraph(d,branch,work=new MemoryWork()) {
  async function visit(key) {
    return work.run('graph',branch+':'+key,async()=>{
      const m=await d.get('memories',key);
      for(const ref of m.input_refs) { work.step();if(ref.type==='memory') { const next=await target(d,branch,ref,work); if(next) await visit(next); } }
    });
  }
  for await(const [,key] of d.viewEntries(branch,'selections')) {
    work.step();
    check(await target(d,branch,{dependency_mode:'checkpoint',memory_revision_id:key},work)===key,'NEEDS_RESOLUTION','Selected root redirected (R5)');
    await visit(key);
  }
}
export async function pagedMemoryStatus(d,key,branchId,cutoffLength=null,work=new MemoryWork()) {
  const branch=await d.get('branches',branchId), snapshot=branch.head_snapshot_id;
  const size=(await d.get('snapshots',snapshot)).message_count, cutoff=cutoffLength??size;
  check(Number.isSafeInteger(cutoff)&&cutoff>=0&&cutoff<=size,'INVALID_SCHEMA','Invalid recall cutoff');
  const sequence=await d.sequence(snapshot);
  const ceiling=cutoff?(await d.pages.get((await d.pages.range(sequence,cutoff-1,1).next()).value)).label:null;
  const within=async message=>{const item=await d.member(snapshot,message); return item&&ceiling!==null&&item.label<=ceiling?item:null;};
  async function visit(key) {
  return work.run('status',branchId+':'+cutoff+':'+key,async()=>{
  const m=await d.get('memories',key,false);if(!m) return 'needs-resolution';
  if(m.story_id!==branch.story_id) return 'out-of-scope';
  try { await checkPagedMemory(d,m,work); if(await target(d,branchId,{dependency_mode:'checkpoint',memory_revision_id:key},work)!==key) return 'needs-rebuild'; }
  catch(error) { if(error.code==='RESOURCE_LIMIT') throw error;return 'needs-resolution'; }
  if(!m.recall_enabled||m.visibility==='private') return 'excluded';
  if(m.origin==='derived_only') {
    if(m.scope_branch_id!==branchId) return 'out-of-scope';
    return (await d.get('snapshots',m.basis_snapshot_id)).message_count<=cutoff&&await fits(d,m,snapshot,work)?'valid':'needs-review';
  }
  for(const ref of m.input_refs) {
    work.step();
    if(ref.type==='source') { const item=await within(ref.message_id); if(!item||item.entry.revision_id!==ref.revision_id) return 'needs-rebuild'; }
    else {
      if(await target(d,branchId,ref,work)!==ref.memory_revision_id) return 'needs-rebuild';
      const status=await visit(ref.memory_revision_id); if(status!=='valid') return status==='needs-resolution'?status:'needs-rebuild';
    }
  }
  for(const ref of m.coverage.members) { work.step();const item=await within(ref.message_id); if(!item||!equal(item.entry,ref)) return 'needs-rebuild'; }
  if(!equal(await span(d,snapshot,m.coverage,work),m.coverage.observed_span)) return m.coverage.mode==='members'?'needs-review':'needs-rebuild';
  return 'valid';
  });
  }
  try { return await visit(key); }
  catch(error) { if(error.code==='NEEDS_RESOLUTION') return 'needs-resolution';throw error; }
}
export async function compileMemory(d,input,makeId) {
  const p=input.payload,work=new MemoryWork();
  check(p&&equal(Object.keys(p).sort(),['action','archives','branch_id','expected_view','mode','old_revision_id','revision_id'])&&Array.isArray(p.archives)&&['archive','select','correct'].includes(p.action),'INVALID_SCHEMA','Memory request shape');
  for(const m of p.archives) {
    await d.put('memories',m.memory_revision_id,m,true); await checkPagedMemory(d,m,work);
    const family=await d.get('families',m.memory_id,false), value={story_id:m.story_id,kind:m.kind};
    check(family===null||equal(family,value),'NEEDS_RESOLUTION','Memory family owner/kind'); if(!family) await d.put('families',m.memory_id,value,true);
  }
  if(p.action==='archive') {
    check([p.branch_id,p.expected_view,p.mode,p.old_revision_id,p.revision_id].every(x=>x===null),'INVALID_SCHEMA','Archive selection parameters');
    return {archived:p.archives.map(m=>m.memory_revision_id)};
  }
  const branch=await d.get('branches',p.branch_id), memory=await d.get('memories',p.revision_id), version=await d.field('views',p.branch_id,['version']);
  check(version===p.expected_view,'VERSION_CONFLICT','Memory view changed');
  let previous;
  if(p.action==='select') {
    check(p.old_revision_id===null&&['replace','advance'].includes(p.mode),'INVALID_SCHEMA','Selection mode');
    check(branch.story_id===memory.story_id,'VERSION_CONFLICT','Memory selection owner');
    previous=await d.viewValue(p.branch_id,'selections',memory.memory_id);
    if(previous===memory.memory_revision_id) return {branch_id:p.branch_id,version};
    if(p.mode==='advance') check(previous&&memory.input_refs.some(r=>r.type==='memory'&&r.dependency_mode==='checkpoint'&&r.memory_revision_id===previous),'INVALID_TRANSITION','Advance must consume fixed checkpoint');
    await d.viewSet(p.branch_id,'corrections',p.revision_id,null);
    if(previous&&p.mode==='replace') await d.viewSet(p.branch_id,'corrections',previous,p.revision_id);
    await d.viewSet(p.branch_id,'selections',memory.memory_id,p.revision_id);
  } else {
    check(p.mode===null,'INVALID_SCHEMA','Correction has no mode'); const old=await d.get('memories',p.old_revision_id);
    check(p.old_revision_id!==p.revision_id&&old.memory_id===memory.memory_id&&old.story_id===branch.story_id&&equal(old.coverage,memory.coverage),'INVALID_TRANSITION','Correction scope/family');
    await d.viewSet(p.branch_id,'corrections',p.old_revision_id,p.revision_id); await d.viewSet(p.branch_id,'corrections',p.revision_id,null);
    if(await d.viewValue(p.branch_id,'selections',old.memory_id)===p.old_revision_id) await d.viewSet(p.branch_id,'selections',old.memory_id,p.revision_id);
  }
  const next=await d.allocate('memoryView',makeId);
  await d.patch('views',p.branch_id,['version'],await d.json.write(next)); await d.delete('viewIds',version); await d.put('viewIds',next,p.branch_id,true);
  await checkPagedGraph(d,p.branch_id,work);
  if(p.mode==='advance') check(await pagedMemoryStatus(d,p.revision_id,p.branch_id,null,work)==='valid','NOT_READY','Cannot advance invalid checkpoint');
  await d.put('markers',p.branch_id,{head:branch.head_snapshot_id,view:next,index:'behind',rebuild:'evaluate'});
  return {branch_id:p.branch_id,version:next};
}
export async function compileBinding(d,input) {
  const b=input.payload; validate('binding',b);
  check((await d.get('branches',b.branch_id)).story_id===b.story_id,'NEEDS_RESOLUTION','Binding owner');
  check(new Set(b.message_map.map(x=>x.host_key)).size===b.message_map.length&&new Set(b.message_map.map(x=>x.message_id)).size===b.message_map.length,'NEEDS_RESOLUTION','Ambiguous mapping');
  for(const ref of b.message_map) check((await d.get('messages',ref.message_id)).story_id===b.story_id,'NEEDS_RESOLUTION','Binding source owner');
  const old=await d.get('bindings',b.binding_id,false);
  if(old) { check(old.story_id===b.story_id,'NEEDS_RESOLUTION','Cross-story rebinding'); check(b.binding_generation===old.binding_generation+1,'VERSION_CONFLICT','Binding generation'); }
  await d.put('bindings',b.binding_id,b); return {binding_id:b.binding_id,binding_generation:b.binding_generation};
}
