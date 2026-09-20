// Reuse the completed synthetic growth package to check the final reader without
// regenerating 66 histories or confusing this with a device benchmark.
import { createReadStream,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { restorePagedIntoEmpty } from '../paged-recovery.mjs';
import { PagedCoordinator } from '../paged-coordinator.mjs';
class IO {
  nodes=new Map(); reads=0;
  async get(key){this.reads++;return structuredClone(this.nodes.get(key)??null);}
  async put(key,value){this.nodes.set(key,structuredClone(value));}
  async flush(){} async close(){} async assertEmpty(){assert.equal(this.nodes.size,0);}
}
const path='.t03-local/paged-growth.ndjson',digest=createHash('sha256');
for await(const chunk of createReadStream(path))digest.update(chunk);
const io=new IO(),restored=await restorePagedIntoEmpty(io,createReadStream(path,{highWaterMark:32768}));
await restored.close();const before=io.reads,owner=new PagedCoordinator(io),h=await owner.recover();const coldReads=io.reads-before;
assert.ok(coldReads<150);const pending=await h.pending();assert.equal(pending.length,1);
let cursor=null,checkpoint=null,count=0;
do{const page=await h.enumerate('operations',cursor,16,checkpoint);checkpoint=page.checkpoint;count+=page.keys.length;cursor=page.keys.length===16?page.after:null;}while(cursor);
assert.equal(count,66);assert.deepEqual(await h.execute(pending[0].input.operation_id),pending[0].result);
assert.deepEqual(await h.execute(pending[0].input.operation_id),pending[0].result);
writeFileSync('evals/t03/p3-integration/growth-final-reader.json',JSON.stringify({status:'passed',sourcePackageSHA256:digest.digest('hex'),coldReads,confirmedHistoryOperations:count,pendingIdsAndResultPreserved:true,targetPhysicalNodes:io.nodes.size,memory:process.memoryUsage(),scope:'Final reader + complete restore of the prior synthetic growth package; in-memory fixture IO, not native/mobile'},null,2)+'\n');
console.log(JSON.stringify({status:'passed',coldReads,confirmedHistoryOperations:count}));
