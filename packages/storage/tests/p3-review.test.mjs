import test from 'node:test';
import assert from 'node:assert/strict';
import { PagedCoordinator } from '../paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../paged-recovery.mjs';
import { FakeIO } from './fake-io.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { commitHistory } from '../../contracts/history.mjs';
import { Pages } from '../pages.mjs';
import { PagedDomain } from '../paged-domain.mjs';
import { compileHistory } from '../paged-history.mjs';
import { checkPagedGraph, checkPagedMemory, pagedMemoryStatus } from '../paged-memory.mjs';
import { MemoryWork, MEMORY_WORK_LIMITS } from '../memory-work.mjs';
import { derivedFingerprint, checkExecutionGraph, archiveMemory, selectMemory, memoryStatus } from '../../contracts/memory.mjs';

function graphModel(levels) {
  const memories=new Map(),selections=new Map();let previous=[];
  for(let layer=0;layer<levels;layer++){
    const next=[];
    for(let side=0;side<2;side++){
      const key=`${layer}-${side}`;
      memories.set(key,{input_refs:previous.map(k=>({type:'memory',memory_id:k,memory_revision_id:k}))});
      selections.set(key,key);next.push(key);
    }
    previous=next;
  }
  let reads=0;
  const d={get:async(table,key)=>{assert.equal(table,'memories');reads++;return memories.get(key);},
    viewValue:async(branch,field,key)=>field==='selections'?selections.get(key):null,
    async *viewEntries(){yield* selections;}};
  return {d,memories,selections,get reads(){return reads;}};
}

test('P3-R2 selected shared DAG visits each distinct memory once',async t=>{
  for(const levels of [4,8,12,16]){
    const model=graphModel(levels);await checkPagedGraph(model.d,'branch');
    const nodes=levels*2,edges=(levels-1)*4;
    assert.equal(model.reads,nodes);t.diagnostic(JSON.stringify({scope:'logical model, not native IO',levels,nodes,edges,memoryReads:model.reads}));
  }
});

test('P3-R2 real paged validation, basis fits and status reuse shared DAGs',async t=>{
  const f=fixture(2),d=await PagedDomain.empty(new Pages(new IO()));
  const head=(await compileHistory(d,full(Object.values(f.state.operations)[0].command),f.ids)).snapshot_id;
  const all=[];let previous=[];
  for(let layer=0;layer<16;layer++){
    const next=[];
    for(let side=0;side<2;side++){
      const m=f.memory(f.entries,'Summary',{basis_snapshot_id:head,...(previous.length?{input_refs:previous.map(m=>({type:'memory',memory_id:m.memory_id,memory_revision_id:m.memory_revision_id}))}:{})});
      await d.put('memories',m.memory_revision_id,m,true);await d.viewSet(f.branch,'selections',m.memory_id,m.memory_revision_id);all.push(m);next.push(m);
    }
    previous=next;
  }
  const get=d.get.bind(d);let reads=0;
  d.get=async(...args)=>{if(args[0]==='memories')reads++;return get(...args);};
  for(const [name,run] of [
    ['graph',()=>checkPagedGraph(d,f.branch)],
    ['validation-and-fits',()=>checkPagedMemory(d,all.at(-1))],
    ['status',async()=>assert.equal(await pagedMemoryStatus(d,all.at(-1).memory_revision_id,f.branch),'valid')],
  ]){
    reads=0;await run();assert.ok(reads<=4*(32+60),`${name} expanded ${reads} memory reads`);
    t.diagnostic(JSON.stringify({scope:'real PagedDomain logical reads, not physical/native IO',name,nodes:32,edges:60,memoryReads:reads}));
  }
  assert.equal(await pagedMemoryStatus(d,all.at(-1).memory_revision_id,f.branch,1),'needs-rebuild');
  const exhausted=new MemoryWork();exhausted.step(MEMORY_WORK_LIMITS.steps-3);
  await rejects(pagedMemoryStatus(d,all.at(-1).memory_revision_id,f.branch,null,exhausted),'RESOURCE_LIMIT');
  const child=f.ids('branch');await compileHistory(d,full(f.command(f.entries,{branch_id:child,expected_head:null,change_kind:'fork',fork:{parent_branch_id:f.branch,source_snapshot_id:head,prefix_length:2,anchor:f.entries[1]}})),f.ids);
  await d.viewSet(child,'corrections',all[0].memory_revision_id,all[1].memory_revision_id);
  assert.equal(await pagedMemoryStatus(d,all.at(-1).memory_revision_id,child),'needs-rebuild');
  assert.equal(await pagedMemoryStatus(d,all.at(-1).memory_revision_id,f.branch),'valid');
  // Neither a changed basis nor a later view may reuse a previous call's result.
  const edit=f.source('user','changed source',f.entries[0].message_id);
  const changed=(await compileHistory(d,full(f.command([edit.ref,f.entries[1]],{expected_head:head,change_kind:'edit',revisions:[edit.revision]})),f.ids)).snapshot_id;
  const wrapper=f.memory([edit.ref,f.entries[1]],'Summary',{basis_snapshot_id:changed,coverage:{...all[0].coverage,members:[edit.ref,f.entries[1]],observed_span:[edit.ref,f.entries[1]]},input_refs:[{type:'memory',memory_id:all.at(-1).memory_id,memory_revision_id:all.at(-1).memory_revision_id}]});
  const sharedBasisWork=new MemoryWork();await checkPagedMemory(d,all.at(-1),sharedBasisWork);
  await rejects(checkPagedMemory(d,wrapper,sharedBasisWork),'NEEDS_RESOLUTION');
  assert.equal(await pagedMemoryStatus(d,all.at(-1).memory_revision_id,f.branch),'needs-rebuild');
  // Explicitly corrupt only the isolated in-memory candidate to exercise both cycle types.
  const cyclic={...all[0],input_refs:[{type:'memory',memory_id:all.at(-1).memory_id,memory_revision_id:all.at(-1).memory_revision_id}]};cyclic.input_fingerprint=derivedFingerprint(cyclic);
  await d.put('memories',cyclic.memory_revision_id,cyclic);
  await rejects(checkPagedGraph(d,f.branch),'NEEDS_RESOLUTION');await rejects(checkPagedMemory(d,all.at(-1)),'NEEDS_RESOLUTION');
  await d.put('memories',all[0].memory_revision_id,all[0]);
  await d.viewSet(f.branch,'corrections',all[0].memory_revision_id,all[1].memory_revision_id);
  await d.viewSet(f.branch,'corrections',all[1].memory_revision_id,all[0].memory_revision_id);
  await rejects(checkPagedGraph(d,f.branch),'NEEDS_RESOLUTION');
  assert.equal(await pagedMemoryStatus(d,all[0].memory_revision_id,f.branch),'needs-resolution');
});

test('P3-R2 state, edge and cached-depth budgets reject incomplete traversals',async()=>{
  const model=graphModel(MEMORY_WORK_LIMITS.states/2+1);
  // Remove edges so only state accounting, not depth, determines this outcome.
  for(const m of model.memories.values())m.input_refs=[];
  await rejects(checkPagedGraph(model.d,'branch'),'RESOURCE_LIMIT');
  assert.ok(model.reads<=MEMORY_WORK_LIMITS.states/2);
  const dense=graphModel(1);dense.memories.values().next().value.input_refs=Array.from({length:MEMORY_WORK_LIMITS.steps+1},()=>({type:'source'}));
  await rejects(checkPagedGraph(dense.d,'branch'),'RESOURCE_LIMIT');
  const work=new MemoryWork();
  async function chain(key,n){return work.run('depth',key+':'+n,async()=>n?chain(key,n-1):true);}
  await chain('shared',126);
  await rejects(work.run('depth','extra1',()=>work.run('depth','extra2',()=>chain('shared',126))),'NEEDS_RESOLUTION');
});

test('P3-R2 coordinator keeps diamond selections, checkpoints and rejected cycles across restore',async()=>{
  const f=fixture(4),io=new IO();let owner=new PagedCoordinator(io),h=await owner.create();
  const head=(await commit(h,full(Object.values(f.state.operations)[0].command))).snapshot_id;
  const nodes=[];
  for(const parents of [[],[0],[0],[1,2]]){
    const m=f.memory(f.entries,'Summary',{basis_snapshot_id:head,...(parents.length?{input_refs:parents.map(i=>({type:'memory',memory_id:nodes[i].memory_id,memory_revision_id:nodes[i].memory_revision_id}))}:{})});nodes.push(m);
  }
  async function memory(m,mode='replace',action='select',old=null){
    const payload={archives:[m],action,branch_id:f.branch,revision_id:m.memory_revision_id,old_revision_id:old,expected_view:(await h.read('views',f.branch)).version,mode};
    const input={operation_id:f.ids('operation'),kind:'memory',payload};return commit(h,input);
  }
  for(const m of nodes)await memory(m);
  assert.equal(await h.memoryStatus(nodes.at(-1).memory_revision_id,f.branch),'valid');
  const before=await h.logical();assert.equal(memoryStatus(before.state,nodes.at(-1).memory_revision_id,f.branch),'valid');checkExecutionGraph(before.state,f.branch);
  const cycle=f.memory(f.entries,'Summary',{basis_snapshot_id:head,memory_id:nodes[0].memory_id,input_refs:[{type:'memory',memory_id:nodes.at(-1).memory_id,memory_revision_id:nodes.at(-1).memory_revision_id}]});
  assert.throws(()=>selectMemory(archiveMemory(before.state,cycle),f.branch,cycle.memory_revision_id,before.state.views[f.branch].version,f.ids),e=>e.code==='NEEDS_RESOLUTION');
  await rejects(memory(cycle),'NEEDS_RESOLUTION');h=await owner.recover();assert.deepEqual(await h.logical(),before);
  const first=f.memory(f.entries.slice(0,2),'Record',{basis_snapshot_id:head});await memory(first);
  const next=f.memory(f.entries,'Record',{basis_snapshot_id:head,memory_id:first.memory_id,input_refs:[{type:'memory',memory_id:first.memory_id,memory_revision_id:first.memory_revision_id,dependency_mode:'checkpoint'},...f.entries.slice(2).map(ref=>({type:'source',...ref}))]});await memory(next,'advance');
  assert.equal(await h.memoryStatus(next.memory_revision_id,f.branch),'valid');
  const saved=await h.logical();
  const redirected=f.memory(f.entries.slice(0,2),'Record',{basis_snapshot_id:head,memory_id:first.memory_id,input_refs:[{type:'memory',memory_id:next.memory_id,memory_revision_id:next.memory_revision_id}]});
  await rejects(memory(redirected,null,'correct',first.memory_revision_id),'NEEDS_RESOLUTION');h=await owner.recover();assert.deepEqual(await h.logical(),saved);
  const dst=new IO();await restorePagedIntoEmpty(dst,await collect(await h.export()));h=await new PagedCoordinator(dst).recover();
  assert.deepEqual(await h.logical(),saved);assert.equal(await h.memoryStatus(next.memory_revision_id,f.branch),'valid');assert.equal(await h.memoryStatus(nodes.at(-1).memory_revision_id,f.branch),'valid');
});

class IO extends FakeIO { async assertEmpty() { assert.equal(this.live.size,0); } }
const collect=async stream=>{const chunks=[];for await(const chunk of stream)chunks.push(chunk);return chunks;};
const commit=async(h,input)=>{await h.prepare(input);return h.execute(input.operation_id);};
const full=c=>({operation_id:c.operation_id,kind:'history',payload:c});
const delta=(c,start,count,entries)=>{const payload={...c,splice:{start,delete_count:count,entries}};delete payload.entries;return {operation_id:c.operation_id,kind:'history-delta',payload};};
const rejects=(p,code)=>assert.rejects(p,e=>e.code===code);

test('P3-R1 exact fork membership survives label reuse, reopen and complete restore',async()=>{
  const f=fixture(4),io=new IO();let owner=new PagedCoordinator(io),h=await owner.create();
  const init=Object.values(f.state.operations)[0].command;
  const parent=(await commit(h,full(init))).snapshot_id,child=f.ids('branch');
  const fork=f.command(f.entries.slice(0,2),{branch_id:child,expected_head:null,change_kind:'fork',fork:{parent_branch_id:f.branch,source_snapshot_id:parent,prefix_length:2,anchor:f.entries[1]}});
  let head=(await commit(h,full(fork))).snapshot_id;
  const e=f.source('user','E'),g=f.source('assistant','F'),abef=[...f.entries.slice(0,2),e.ref,g.ref];
  const append=f.command(abef,{branch_id:child,expected_head:head,change_kind:'append',messages:[e.message,g.message],revisions:[e.revision,g.revision]});
  head=(await commit(h,delta(append,2,0,[e.ref,g.ref]))).snapshot_id;
  async function guards(){
    const before=await h.logical(),root=structuredClone(io.live.get(0));
    for(const shape of ['history','history-delta']){
      const bad=f.command(f.entries,{branch_id:child,expected_head:head,change_kind:'reorder'});
      assert.throws(()=>commitHistory(before.state,bad,f.ids),err=>err.code==='INVALID_TRANSITION');
      await rejects(h.prepare(shape==='history'?full(bad):delta(bad,2,2,f.entries.slice(2))),'INVALID_TRANSITION');
      assert.equal(await h.lookup(bad.operation_id),null);
      assert.deepEqual(io.live.get(0),root,'rejection must not publish domain, view or ledger');
      assert.deepEqual(await h.logical(),before);
    }
    const duplicate=f.command([...abef,e.ref],{branch_id:child,expected_head:head,change_kind:'import'});
    assert.throws(()=>commitHistory(before.state,duplicate,f.ids),err=>err.code==='NEEDS_RESOLUTION');
    await rejects(h.prepare(delta(duplicate,4,0,[e.ref])),'NEEDS_RESOLUTION');
    h=await owner.recover();
    assert.deepEqual(await h.logical(),before);
    assert.deepEqual(await h.execute(append.operation_id),{snapshot_id:head});
    assert.deepEqual(await h.range(parent,0,4),f.entries,'parent remains fixed');
  }
  await guards();
  await owner.close();io.crash();owner=new PagedCoordinator(io);h=await owner.recover();await guards();
  const target=new IO();await restorePagedIntoEmpty(target,await collect(await h.export()));
  owner=new PagedCoordinator(target);h=await owner.recover();
  // Assertions for the restored library use its own mutable root below.
  const restoredBefore=await h.logical();
  const bad=f.command(f.entries,{branch_id:child,expected_head:head,change_kind:'reorder'});
  await rejects(h.prepare(full(bad)),'INVALID_TRANSITION');assert.deepEqual(await h.logical(),restoredBefore);
  assert.deepEqual(await h.execute(append.operation_id),{snapshot_id:head});
  async function accepted(kind,entries,start,count,insert){
    const cmd=f.command(entries,{branch_id:child,expected_head:head,change_kind:kind});
    const oracle=commitHistory((await h.logical()).state,cmd,f.ids);
    head=(await commit(h,delta(cmd,start,count,insert))).snapshot_id;
    assert.deepEqual(await h.range(head,0,entries.length),entries);
    assert.equal(oracle.state.snapshots[oracle.snapshot_id].message_count,entries.length);
  }
  await accepted('reorder',[...abef.slice(0,2),g.ref,e.ref],2,2,[g.ref,e.ref]);
  // Explicit import may adopt an old parent source even while its stale label is occupied.
  await accepted('import',[...abef.slice(0,2),g.ref,e.ref,f.entries[2]],4,0,[f.entries[2]]);
  const duplicate=f.command([...abef.slice(0,2),g.ref,e.ref,f.entries[2],f.entries[2]],{branch_id:child,expected_head:head,change_kind:'import'});
  await rejects(h.prepare(delta(duplicate,5,0,[f.entries[2]])),'NEEDS_RESOLUTION');h=await owner.recover();
  await accepted('import',f.entries,0,5,f.entries);
  assert.deepEqual(await h.range(parent,0,4),f.entries);
});
