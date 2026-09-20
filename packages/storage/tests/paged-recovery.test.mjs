import test from 'node:test';
import assert from 'node:assert/strict';
import { PagedCoordinator, TrackedPages, sealRoot } from '../paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../paged-recovery.mjs';
import { PagedDomain } from '../paged-domain.mjs';
import { exportPageDirectory } from '../paged-transport.mjs';
import { Pages } from '../pages.mjs';
import { FakeIO } from './fake-io.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { derivedFingerprint } from '../../contracts/memory.mjs';
import { canonicalize } from '../../contracts/primitives.mjs';
import { SHA256Stream,sha256 } from '../../contracts/runtime.mjs';
class IO extends FakeIO { async assertEmpty(){assert.equal(this.live.size,0);} }
const collect=async stream=>{const chunks=[];for await(const chunk of stream)chunks.push(chunk);return chunks;};
const reject=(promise,code)=>assert.rejects(promise,error=>error.code===code);
const commit=async(h,input)=>{await h.prepare(input);return h.execute(input.operation_id);};
let empty;
async function emptyBackup(){if(!empty){const io=new IO(),h=await new PagedCoordinator(io).create();empty={chunks:await collect(await h.export()),logical:await h.logical()};}return empty;}

test('streamed canonical hash agrees with the original runtime across padding and UTF-8 boundaries',()=>{
  for(const n of [0,1,55,56,63,64,65,127,8192]){
    const text='中文😀'.repeat(n),h=new SHA256Stream();for(const part of text)h.update(part);
    assert.equal(h.digest(),sha256(text));
  }
});
for(const label of ['paged-restore-stage','paged-restore-materials','paged-restore-audit','paged-restore-activate'])for(const edge of ['before','after']){
  test(`paged restore ${label}/${edge} never activates a partial target`,async()=>{
    const source=await emptyBackup(),io=new IO();io.fail={label,edge,n:1,code:'ENOSPC'};
    await reject(restorePagedIntoEmpty(io,source.chunks),'ENOSPC');io.fail=null;io.crash();
    if(label==='paged-restore-activate'&&edge==='after'){
      const h=await new PagedCoordinator(io).recover();assert.deepEqual(await h.logical(),source.logical);
    }else await assert.rejects(new PagedCoordinator(io).recover(),error=>['STAGING_IMPORT','NEEDS_RESOLUTION'].includes(error.code));
  });
}

test('paged restore rejects checksum-valid R5 and compiled-result contradictions, preserves staging',async()=>{
  const f=fixture(2),io=new IO(),h=await new PagedCoordinator(io).create();
  const initial=Object.values(f.state.operations)[0].command;
  const init=await commit(h,{kind:'history',operation_id:initial.operation_id,payload:initial});
  const memory={...f.memory(f.entries),basis_snapshot_id:init.snapshot_id};memory.input_fingerprint=derivedFingerprint(memory);
  const selected=await commit(h,{kind:'memory',operation_id:f.ids('operation'),payload:{archives:[memory],action:'select',branch_id:f.branch,revision_id:memory.memory_revision_id,old_revision_id:null,expected_view:(await h.read('views',f.branch)).version,mode:'replace'}});
  const replacement={...memory,memory_revision_id:f.ids('memoryRevision'),content:'synthetic correction'};
  await commit(h,{kind:'memory',operation_id:f.ids('operation'),payload:{archives:[replacement],action:'correct',branch_id:f.branch,revision_id:replacement.memory_revision_id,old_revision_id:memory.memory_revision_id,expected_view:selected.version,mode:null}});
  const original=await h.logical();
  // Tamper with valid content-addressed pages and a correctly sealed outer root;
  // transport checksums alone cannot notice the domain/operation disagreement.
  const root=await io.get(0),pages=new TrackedPages(io,root.directory),control=await pages.get(root.control),d=new PagedDomain(pages,control.domain);
  await d.viewSet(f.branch,'selections',memory.memory_id,memory.memory_revision_id);
  const badControl=await pages.put({...control,domain:d.root});await pages.catalog.finish(pages.directory);
  const bytes=exportPageDirectory(pages.catalog,pages.directory,{format:root.format,library_id:root.library_id,control:badControl});
  const target=new IO();await reject(restorePagedIntoEmpty(target,bytes),'NEEDS_RESOLUTION');
  assert.equal((await target.get(0)).status,'staging');assert.deepEqual(await h.logical(),original);
});

test('missing referenced page is rejected before semantic replay can recreate it',async()=>{
  const source=await emptyBackup(),io=new IO();
  const records=source.chunks.map(c=>JSON.parse(new TextDecoder().decode(c)));
  const metadata=records[0].metadata;
  const kept=records.filter(r=>r.type!=='page'||r.ref.hash!==metadata.control.hash);
  kept.at(-1).count--;
  let previous=null;
  const chunks=kept.map(({checksum,...body})=>{
    body.previous=previous;const value={...body,checksum:'sha256:page-graph:v1:'+sha256(canonicalize(body))};previous=value.checksum;
    return new TextEncoder().encode(JSON.stringify(value)+'\n');
  });
  await reject(restorePagedIntoEmpty(io,chunks),'NEEDS_RESOLUTION');assert.equal((await io.get(0)).status,'staging');
});

test('restore refuses an occupied target and old intent readers reject the new paged identity',async()=>{
  const source=await emptyBackup(),io=new IO();await io.put(999,{keep:'fixture'});
  await assert.rejects(restorePagedIntoEmpty(io,source.chunks));assert.equal(io.live.size,1);
  const fresh=new IO(),owner=await restorePagedIntoEmpty(fresh,source.chunks);await owner.close();
  const {IntentCoordinator}=await import('../intent-prototype.mjs');await reject(new IntentCoordinator(fresh).recover(),'NEEDS_RESOLUTION');
});

test('normal paged recovery rejects a missing exact directory and never guesses an empty library',async()=>{
  const io=new IO(),owner=new PagedCoordinator(io);await owner.create();
  const root=await io.get(0);await io.put(0,sealRoot({...Object.fromEntries(Object.entries(root).filter(([k])=>k!=='checksum')),directory:null}));await io.flush();
  await reject(new PagedCoordinator(io).recover(),'NEEDS_RESOLUTION');
});
