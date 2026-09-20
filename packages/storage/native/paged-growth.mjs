// P3 growth correctness harness, not the P4 device/resource acceptance benchmark.
// Provider maps below are test fixtures; the coordinator/transport cannot enumerate
// them or retain them as its domain state.
import { writeFileSync, createWriteStream, createReadStream } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { PagedCoordinator } from '../paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../paged-recovery.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';
import { canonicalize } from '../../contracts/primitives.mjs';
import assert from 'node:assert/strict';
class CountedIO {
  live=new Map(); durable=new Map(); dirty=new Map(); reads=0; writes=0;
  async get(slot) { this.reads++; return structuredClone(this.live.get(slot)??null); }
  async put(slot,value) { this.writes++; const saved=structuredClone(value); this.live.set(slot,saved); this.dirty.set(slot,saved); }
  async flush() { for(const [key,value] of this.dirty) this.durable.set(key,value); this.dirty.clear(); }
  async close() { await this.flush(); }
  async assertEmpty() { assert.equal(this.live.size,0); }
  crash() { this.live=new Map(this.durable); this.dirty.clear(); }
}
const output=resolve(process.argv[2]??'evals/t03/p3-integration/growth.json');
const backup=resolve('.t03-local/paged-growth.ndjson');
const f=fixture(0), io=new CountedIO(), owner=new PagedCoordinator(io);
let handle=await owner.create(), head=null, count=0, characters=0;
const measurements=[], samples=[];
function resources() { const m=process.memoryUsage(); assert.ok(m.rss<1400*1024*1024,'Synthetic harness RSS safety stop'); return m; }
for(let operation=0;operation<66;operation++) {
  const sources=[0,1].map(n=>f.source(n?'assistant':'user',(`Synthetic P3 ${operation}/${n} `+'x'.repeat(8100)).padEnd(8192,String(operation%10))));
  characters+=sources.reduce((sum,s)=>sum+s.revision.content.length,0);
  const payload={...f.command([], {change_kind:operation?'append':'init',expected_head:head,messages:sources.map(s=>s.message),revisions:sources.map(s=>s.revision)}),splice:{start:count,delete_count:0,entries:sources.map(s=>s.ref)}}; delete payload.entries;
  const input={kind:'history-delta',operation_id:payload.operation_id,payload};
  const before={reads:io.reads,writes:io.writes};
  await handle.prepare(input); head=(await handle.execute(input.operation_id)).snapshot_id;
  measurements.push({operation:operation+1,reads:io.reads-before.reads,writes:io.writes-before.writes});
  samples.push({snapshot:head,last:sources.at(-1).ref,count:count+2,operation:input.operation_id}); count+=2;
  resources(); if(operation%8===0) console.log(JSON.stringify({phase:'append',operations:operation+1,pages:io.live.size}));
}
// A genuinely pending final request is included in the same immutable boundary.
const next=f.source('user','Prepared but not published');
const pendingPayload={...f.command([], {change_kind:'append',expected_head:head,messages:[next.message],revisions:[next.revision]}),splice:{start:count,delete_count:0,entries:[next.ref]}}; delete pendingPayload.entries;
const pendingInput={kind:'history-delta',operation_id:pendingPayload.operation_id,payload:pendingPayload};
const prepared=await handle.prepare(pendingInput);
io.crash(); const beforeOpen=io.reads; handle=await new PagedCoordinator(io).recover(); const reopenReads=io.reads-beforeOpen;
assert.ok(reopenReads<150,'Cold open must not replay 66 operations');
const sink=createWriteStream(backup); let bytes=0,records=0;
for await(const chunk of await handle.export()) { bytes+=chunk.length; records++; if(!sink.write(chunk)) await once(sink,'drain'); }
sink.end(); await once(sink,'finish'); console.log(JSON.stringify({phase:'exported',bytes,records,reopenReads}));
const target=new CountedIO(); const restored=await restorePagedIntoEmpty(target,createReadStream(backup,{highWaterMark:32768}));
const rh=restored.handle(); assert.deepEqual(await rh.pending(),[prepared]);
for(const sample of samples) {
  assert.deepEqual(await rh.range(sample.snapshot,sample.count-1,1),[sample.last]);
  assert.deepEqual((await rh.lookup(sample.operation)).result,(await handle.lookup(sample.operation)).result);
}
assert.deepEqual(await rh.execute(pendingInput.operation_id),prepared.result);
assert.deepEqual(await rh.range(prepared.result.snapshot_id,count,1),[next.ref]);
const report={status:'passed',scope:'P3 growing-library correctness; not P4 benchmark or mobile acceptance',synthetic:true,operations:66,pending:1,messages:count,characters,backupBytes:bytes,backupRecords:records,reopenReads,sourcePhysicalNodes:io.live.size,restoredPhysicalNodes:target.live.size,measurements,memory:resources(),node:process.version,maintenanceGate:'HOST_MAINTENANCE_UNSUPPORTED',allSampledHistoricalLastEntriesPreserved:true,allConfirmedResultsPreserved:true,pendingIdsAndResultPreserved:true};
writeFileSync(output,JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify({phase:'done',output}));
