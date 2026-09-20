// Local history compiler. Delta requests are a versioned storage input shorthand;
// the retained command expands to the unchanged contracts v2 command.
import { equal, requireThat as check, id, fingerprint, canonicalize } from '../contracts/primitives.mjs';
import { validate, sourceRef } from '../contracts/schema.mjs';
const GAP=1n<<256n, MAX=(1n<<384n)-1n;
const label=n=>n.toString(16).padStart(96,'0');
const value=s=>s===null?0n:BigInt('0x'+s);
export async function compileHistory(d,input,makeId) {
  const p=d.pages, j=d.json, c=structuredClone(input.payload);
  const delta=input.kind==='history-delta';
  const splice=delta?c.splice:null;
  if(delta) { delete c.splice; c.entries=[]; }
  validate('command',c); check(c.operation_id===input.operation_id,'INVALID_SCHEMA','Operation mismatch');
  const {story_id,branch_id,expected_head,change_kind,fork}=c;
  let branch=await d.get('branches',branch_id,false), before=null;
  if(branch) {
    check(branch.story_id===story_id && branch.head_snapshot_id===expected_head,'HEAD_CONFLICT','Head/owner changed');
    check(!['init','fork'].includes(change_kind)&&fork===null,'INVALID_TRANSITION','Existing branch initialization');
    before=await d.get('historyIndex',expected_head);
  } else {
    check(expected_head===null&&['init','fork'].includes(change_kind),'HEAD_CONFLICT','New branch requires init/fork');
    check(change_kind==='fork'?fork!==null:fork===null,'INVALID_TRANSITION','Fork metadata');
    if(!await d.get('stories',story_id,false)) { check(change_kind==='init','NEEDS_RESOLUTION','Fork story missing'); await d.put('stories',story_id,{schema_version:1,story_id},true); }
    branch={schema_version:1,story_id,branch_id,head_snapshot_id:null,fork};
    let view=await j.write({version:await d.allocate('memoryView',makeId),selections:{},corrections:{}});
    if(fork) {
      const parent=await d.get('branches',fork.parent_branch_id), snapshot=await d.get('snapshots',fork.source_snapshot_id);
      check(parent.story_id===story_id&&snapshot.story_id===story_id&&snapshot.branch_id===parent.branch_id&&parent.branch_id!==branch_id,'NEEDS_RESOLUTION','Fork owner');
      check(fork.prefix_length<=snapshot.message_count&&equal(fork.anchor,fork.prefix_length?await d.entry(snapshot.snapshot_id,fork.prefix_length-1):null),'NEEDS_RESOLUTION','Fork anchor');
      before=await d.get('historyIndex',fork.source_snapshot_id);
      const sequence=(await p.split(before.sequence,fork.prefix_length))[0];
      const last=fork.prefix_length?(await p.get((await p.range(sequence,fork.prefix_length-1,1).next()).value)).label:null;
      before={sequence,members:before.members,order:await p.mapPrefix(before.order,last)};
      const parentView=await d.ref('views',parent.branch_id);
      for(const field of ['selections','corrections']) view=await j.set(view,[field],await j.at(parentView,[field]));
    }
    await d.setRef('views',branch_id,view,true);
    await d.put('viewIds',await j.read(await j.at(view,['version'])),branch_id,true);
  }
  for(const m of c.messages) { check(m.story_id===story_id,'NEEDS_RESOLUTION','Message story'); await d.put('messages',m.message_id,m,true); }
  for(const r of c.revisions) {
    check((await d.get('messages',r.message_id)).story_id===story_id&&r.content_fingerprint===fingerprint('content',{role:r.role,content:r.content}),'NEEDS_RESOLUTION','Revision owner/fingerprint');
    if(r.provenance.binding_id) check((await d.get('bindings',r.provenance.binding_id)).story_id===story_id,'NEEDS_RESOLUTION','Revision binding crosses story');
    await d.put('revisions',r.revision_id,r,true);
  }
  const original=before??{sequence:null,members:null,order:null};
  let {sequence,members,order}=original; const size=await p.length(sequence);
  let start=0,remove=size,insert=c.entries;
  if(delta) {
    check(splice&&equal(Object.keys(splice).sort(),['delete_count','entries','start'])&&Array.isArray(splice.entries),'INVALID_SCHEMA','Delta splice shape');
    ({start,delete_count:remove,entries:insert}=splice); insert.forEach(sourceRef);
    check(Number.isSafeInteger(start)&&Number.isSafeInteger(remove)&&start>=0&&remove>=0&&start+remove<=size,'INVALID_SCHEMA','Delta range');
    // Normalize only the supplied changed range. Exact reimports must retain the
    // Head even when expressed as a redundant splice.
    let prefix=0, suffix=0;
    while(prefix<Math.min(remove,insert.length)) {
      const item=await p.get((await p.range(sequence,start+prefix,1).next()).value);
      if(!equal(item.entry,insert[prefix])) break; prefix++;
    }
    while(suffix<Math.min(remove,insert.length)-prefix) {
      const item=await p.get((await p.range(sequence,start+remove-suffix-1,1).next()).value);
      if(!equal(item.entry,insert[insert.length-suffix-1])) break; suffix++;
    }
    start+=prefix; remove-=prefix+suffix; insert=insert.slice(prefix,insert.length-suffix);
  } else {
    // Full-command compatibility input: explicitly scans its supplied history.
    // Ordinary callers use history-delta and never read this prefix.
    while(start<Math.min(size,insert.length)) {
      const item=await p.get((await p.range(sequence,start,1).next()).value);
      if(!equal(item.entry,insert[start])) break; start++;
    }
    let tail=0;
    while(tail<Math.min(size,insert.length)-start) {
      const item=await p.get((await p.range(sequence,size-tail-1,1).next()).value);
      if(!equal(item.entry,insert[insert.length-tail-1])) break; tail++;
    }
    remove=size-start-tail; insert=insert.slice(start,insert.length-tail);
  }
  if(change_kind==='fork') check(remove===0&&insert.length===0&&start===size,'INVALID_TRANSITION','Child must equal fixed prefix');
  if(change_kind==='append') check(start===size&&remove===0&&insert.length>0,'INVALID_TRANSITION','Append changes prefix');
  if(['edit','swipe','regenerate'].includes(change_kind)) {
    check(remove===1&&insert.length===1,'INVALID_TRANSITION','Edit exactly one revision');
    const old=(await p.get((await p.range(sequence,start,1).next()).value)).entry;
    check(old.message_id===insert[0].message_id&&!equal(old,insert[0]),'INVALID_TRANSITION','Edit changes identity/no-op');
    if(change_kind!=='edit') check((await d.get('revisions',old.revision_id)).role==='assistant'&&(await d.get('revisions',insert[0].revision_id)).role==='assistant','INVALID_TRANSITION','Assistant revision required');
  }
  if(change_kind==='delete') {
    check(remove>insert.length,'INVALID_TRANSITION','Delete must shrink');
    let n=0; for await(const ref of p.range(sequence,start,remove)) if(n<insert.length&&equal((await p.get(ref)).entry,insert[n])) n++;
    check(n===insert.length,'INVALID_TRANSITION','Delete changes retained source');
  }
  if(change_kind==='reorder') {
    check(remove===insert.length&&remove>0,'INVALID_TRANSITION','Reorder size/no-op');
    // Membership equality checked against the original persistent UUID index.
    for(const entry of insert) {
      const old=await p.mapGet(members,entry.message_id);
      check(old&&equal((await p.get(old)).entry,entry)&&await p.mapGet(order,(await p.get(old)).label),'INVALID_TRANSITION','Reorder source changed');
    }
  }
  const left=start?(await p.get((await p.range(sequence,start-1,1).next()).value)).label:null;
  const right=start+remove<size?(await p.get((await p.range(sequence,start+remove,1).next()).value)).label:null;
  for await(const ref of p.range(sequence,start,remove)) { const item=await p.get(ref); order=await p.mapDelete(order,item.label); members=await p.mapDelete(members,item.entry.message_id); }
  let inserted=null, low=value(left), high=right?value(right):MAX;
  const gap=right?(high-low)/BigInt(insert.length+1):GAP;
  check(gap>0n&&low+gap*BigInt(insert.length)<high,'RESOURCE_LIMIT','Order label space exhausted');
  for(const entry of insert) {
    check((await d.get('messages',entry.message_id)).story_id===story_id&&(await d.get('revisions',entry.revision_id)).message_id===entry.message_id,'NEEDS_RESOLUTION','Source owner');
    const existing=await p.mapGet(members,entry.message_id);
    check(!existing||await p.mapGet(order,(await p.get(existing)).label)===null,'NEEDS_RESOLUTION','Duplicate source');
    low+=gap; const ref=await p.put({kind:'history-entry',label:label(low),entry});
    members=await p.mapSet(members,entry.message_id,ref); order=await p.mapSet(order,label(low),ref);
    inserted=await p.concat(inserted,await p.sequence([ref]));
  }
  sequence=await p.splice(sequence,start,remove,inserted);
  if(change_kind==='restore') {
    let cursor=expected_head,matched=false;
    while(cursor) {
      const old=await d.get('snapshots',cursor);
      if(old.message_count===await p.length(sequence)) {
        let same=true, it=d.entries(cursor)[Symbol.asyncIterator]();
        for await(const ref of p.range(sequence)) if(!equal((await p.get(ref)).entry,(await it.next()).value)) { same=false; break; }
        if(same) { matched=true; break; }
      }
      cursor=old.previous_snapshot_id;
    }
    check(matched,'INVALID_TRANSITION','Restore requires retained branch history');
  }
  const unchanged=remove===0&&insert.length===0;
  let snapshot_id=expected_head;
  const entriesRoot=await commandEntries(d,sequence);
  if(!(change_kind==='import'&&expected_head&&unchanged)) {
    snapshot_id=await d.allocate('snapshot',makeId);
    const manifest_root_id=await manifest(d,sequence,makeId);
    await d.put('snapshots',snapshot_id,{schema_version:1,snapshot_id,story_id,branch_id,previous_snapshot_id:expected_head,manifest_root_id,message_count:await p.length(sequence),change_kind,operation_id:c.operation_id,created_at:c.created_at},true);
    await d.put('historyIndex',snapshot_id,{sequence,members,order},true);
    branch.head_snapshot_id=snapshot_id; await d.put('branches',branch_id,branch);
  }
  let command=await j.write({...c,entries:[]}); command=await j.set(command,['entries'],entriesRoot);
  let operation=await j.write({operation_id:c.operation_id,snapshot_id}); operation=await j.set(operation,['command'],command);
  await d.setRef('operations',c.operation_id,operation,true);
  await d.put('markers',branch_id,{head:branch.head_snapshot_id,view:await d.field('views',branch_id,['version']),index:'behind',rebuild:'evaluate'});
  return {snapshot_id};
}
// Sequence-shape sharing for logical command entries. Each new path is converted
// once, then reused by later commands; no full history copy on append.
async function commandEntries(d,sequence) {
  if(sequence===null) return d.json.write([]);
  const old=await d.get('manifests','entries:'+sequence.hash,false); if(old) return old;
  const node=await d.pages.get(sequence); let root;
  if(node.kind==='leaf') { const refs=[]; for(const ref of node.items) refs.push(await d.json.write((await d.pages.get(ref)).entry)); root=await d.pages.sequence(refs); }
  else {
    const left=await d.pages.get(await commandEntries(d,node.left)),right=await d.pages.get(await commandEntries(d,node.right));
    root=await d.pages.concat(left.root,right.root);
  }
  const ref=await d.pages.put({kind:'json-array',root}); await d.put('manifests','entries:'+sequence.hash,ref,true); return ref;
}
async function manifest(d,sequence,makeId) {
  const key='block:'+(sequence?.hash??'empty'), old=await d.get('manifests',key,false); if(old) return old;
  const node=sequence?await d.pages.get(sequence):{kind:'leaf',items:[]}; let body;
  if(node.kind==='leaf') { const entries=[]; for(const ref of node.items) entries.push((await d.pages.get(ref)).entry); body={kind:'leaf',entries}; }
  else body={kind:'directory',children:[{block_id:await manifest(d,node.left,makeId),message_count:await d.pages.length(node.left)},{block_id:await manifest(d,node.right,makeId),message_count:await d.pages.length(node.right)}]};
  const block_id=await d.allocate('block',makeId); await d.put('blocks',block_id,{schema_version:1,block_id,...body},true); await d.put('manifests',key,block_id,true); return block_id;
}
