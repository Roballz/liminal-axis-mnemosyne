// Bounded write buffer for the physical inventory tree only. Catalog nodes made
// obsolete within one batch need not be written. Domain pages are never dropped.
import { Pages } from './pages.mjs';
export class BufferedDirectory extends Pages {
  constructor(io,capacity=512) {
    const pending=new Map();
    super({get:async slot=>pending.get(slot)??io.get(slot),put:async(slot,page)=>{
      pending.set(slot,page);
    }});
    this.finish=async root=>{
      const visit=async ref=>{
        if(ref===null||!pending.has(ref.slot)) return;
        const page=pending.get(ref.slot),n=page.body;
        await visit(n.left); await visit(n.right); await io.put(ref.slot,page); pending.delete(ref.slot);
      };
      await visit(root); pending.clear();
    };
    this.checkpoint=async root=>{if(pending.size>=capacity) await this.finish(root);};
  }
}
