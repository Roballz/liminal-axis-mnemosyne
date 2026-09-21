// Bounded write buffer for the physical inventory tree only. Catalog nodes made
// obsolete within one batch need not be written. Domain pages are never dropped.
import { Pages } from './pages.mjs';
import { canonicalize, requireThat as check } from '../contracts/primitives.mjs';
export const DIRECTORY_LIMITS = Object.freeze({ batch: 1024, candidates: 16384, bytes: 16 * 1024 * 1024 });
export class BufferedDirectory extends Pages {
  constructor(io,capacity=512) {
    const pending=new Map(); let pendingBytes=0;
    super({metric:(name,count,bytes)=>io.metric?.('directory.'+name,count,bytes),get:async slot=>pending.get(slot)??io.get(slot),put:async(slot,page)=>{
      io.metric?.('directory.candidate');
      const size=new TextEncoder().encode(canonicalize(page)).length;
      check(pending.size < DIRECTORY_LIMITS.candidates && pendingBytes + size <= DIRECTORY_LIMITS.bytes,
        'RESOURCE_LIMIT','Directory candidate working set');
      pendingBytes+=size;
      pending.set(slot,page);
    }});
    this.finish=async root=>{
      const visit=async ref=>{
        if(ref===null||!pending.has(ref.slot)) return;
        const page=pending.get(ref.slot),n=page.body;
        await visit(n.left); await visit(n.right);
        await io.point?.('directory-write','before'); await io.put(ref.slot,page);
        await io.point?.('directory-write','after');
        io.metric?.('directory.persisted'); pending.delete(ref.slot);
      };
      await visit(root); pending.clear(); pendingBytes=0;
    };
    this.checkpoint=async root=>{if(pending.size>=capacity) await this.finish(root);};
  }
}
