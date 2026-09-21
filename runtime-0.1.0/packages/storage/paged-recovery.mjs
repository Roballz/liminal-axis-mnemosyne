import { Pages } from './pages.mjs';
import { BufferedDirectory } from './paged-directory.mjs';
import { PagedJSON } from './paged-json.mjs';
import { PagedDomain } from './paged-domain.mjs';
import { PagedCoordinator, PAGED_FORMAT, ROOT_SLOT, sealRoot, compilePaged, readControl, readRequest } from './paged-coordinator.mjs';
import { importPageDirectory } from './paged-transport.mjs';
import { equal, requireThat as check, fingerprint, newId, id } from '../contracts/primitives.mjs';
// Explicit full audit. Normal open reads a fixed checkpoint and the one pending
// operation; only restore/audit replays all operations using their durable IDs.
export async function auditPaged(pages,directory,controlRef) {
  check(equal(await pages.mapGet(directory,controlRef.hash),controlRef),'NEEDS_RESOLUTION','Control missing from directory');
  let physicalPages=0;
  const inspect=async(value,depth=0)=>{
    check(depth<64,'RESOURCE_LIMIT','Reference nesting limit');
    if(value===null||typeof value!=='object') return;
    if(equal(Object.keys(value).sort(),['hash','slot'])) {
      check(equal(await pages.mapGet(directory,value.hash),value),'NEEDS_RESOLUTION','Reference absent from exact directory');
      await pages.get(value); return;
    }
    for(const child of Object.values(value)) await inspect(child,depth+1);
  };
  for await(const [key,ref] of pages.mapEntries(directory)) {
    check(key===ref.hash,'NEEDS_RESOLUTION','Directory key mismatch'); await inspect(await pages.get(ref)); physicalPages++;
  }
  // Discard transport/read caches before semantic verification of persisted data.
  pages.clearCache(); const control=await readControl(pages,controlRef), json=new PagedJSON(pages);
  let domain=(await PagedDomain.empty(pages)).root, requests=null,ledger=null,journal=null,count=0;
  async function replay(ref,published) {
    const r=await readRequest(pages,ref), input=await json.read(r.input,{maxBytes:1048576,maxValues:200000});
    check(input.operation_id===r.operation_id&&r.input_fingerprint===fingerprint('write-payload',input)&&equal(r.base,domain),'NEEDS_RESOLUTION','Request input/base mismatch');
    check(await pages.mapGet(requests,r.operation_id)===null,'NEEDS_RESOLUTION','Duplicate operation');
    const generated=await json.read(r.generated), result=await json.read(r.result);
    const compiled=await compilePaged(pages,domain,input,generated);
    check(equal(compiled.domain,r.after)&&equal(compiled.result,result),'NEEDS_RESOLUTION','Domain/ID/result replay mismatch');
    requests=await pages.mapSet(requests,r.operation_id,ref);
    if(published) {
      ledger=await pages.mapSet(ledger,r.operation_id,ref); journal=await pages.concat(journal,await pages.sequence([ref])); domain=r.after; count++;
    }
  }
  for await(const ref of pages.range(control.journal)) await replay(ref,true);
  if(control.pending!==null) {
    const ref=await pages.mapGet(control.requests,control.pending); check(ref,'NEEDS_RESOLUTION','Missing prepared work');
    check((await readRequest(pages,ref)).operation_id===control.pending,'NEEDS_RESOLUTION','Pending operation mismatch'); await replay(ref,false);
  }
  check(count===control.count&&equal(domain,control.domain)&&equal(requests,control.requests)&&equal(ledger,control.ledger)&&equal(journal,control.journal),'NEEDS_RESOLUTION','Checkpoint exact index/domain mismatch');
  return {operations:count,pending:control.pending,physicalPages};
}
export async function restorePagedIntoEmpty(io,chunks,options={}) {
  await io.reopen?.(); check(typeof io.assertEmpty==='function','UNSUPPORTED','Exact empty target proof required'); await io.assertEmpty();
  const point=async(label,fn)=>{await io.point?.(label,'before');const r=await fn();await io.point?.(label,'after');return r;};
  const library_id=newId('operation');
  const staging=sealRoot({format:PAGED_FORMAT,library_id,status:'staging',control:null,directory:null});
  await point('paged-restore-stage',async()=>{await io.put(ROOT_SLOT,staging);await io.flush();});
  const pages=new Pages(io);
  const imported=await importPageDirectory(pages,chunks,{...options,directoryPages:new BufferedDirectory(io)});
  const {metadata,directory}=imported;
  check(metadata&&equal(Object.keys(metadata).sort(),['control','format','library_id'])&&metadata.format===PAGED_FORMAT,'INVALID_SCHEMA','Unknown paged backup metadata'); id('operation',metadata.library_id);
  await point('paged-restore-materials',()=>io.flush());
  pages.clearCache(); await point('paged-restore-audit',()=>auditPaged(pages,directory,metadata.control));
  // Replay can only reproduce existing reachable pages. The published directory
  // is exactly the imported set; no scratch additions become authoritative.
  await point('paged-restore-activate',async()=>{
    await io.put(ROOT_SLOT,sealRoot({format:PAGED_FORMAT,library_id,status:'active',control:metadata.control,directory})); await io.flush();
  });
  const owner=new PagedCoordinator(io); await owner.recover(); return owner;
}
