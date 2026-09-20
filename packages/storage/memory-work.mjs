import { requireThat as check } from '../contracts/primitives.mjs';

// Per operation/query, never retained across a domain or view mutation. Only
// IDs and scalar outcomes are memoized; archived memory bodies are not cached.
export const MEMORY_WORK_LIMITS=Object.freeze({states:8192,steps:131072,depth:128});
export class MemoryWork {
  constructor() { this.states=0; this.steps=0; this.groups=new Map(); }
  step(count=1) {
    this.steps+=count;
    check(this.steps<=MEMORY_WORK_LIMITS.steps,'RESOURCE_LIMIT','Memory traversal work limit');
  }
  async run(group,key,fn) {
    this.step();
    if(!this.groups.has(group)) this.groups.set(group,{active:new Set(),done:new Map(),stack:[]});
    const g=this.groups.get(group);
    check(!g.active.has(key),'NEEDS_RESOLUTION','Memory dependency/correction cycle');
    const saved=g.done.get(key);
    // Cached subgraphs retain their height: reaching one on a longer path
    // must not bypass the existing depth bound or depend on selection order.
    const height=saved?.height??1;
    check(g.stack.length+height<=MEMORY_WORK_LIMITS.depth,'NEEDS_RESOLUTION','Memory dependency/correction depth');
    if(saved) {
      if(g.stack.length) g.stack.at(-1).height=Math.max(g.stack.at(-1).height,height+1);
      return saved.value;
    }
    check(++this.states<=MEMORY_WORK_LIMITS.states,'RESOURCE_LIMIT','Memory traversal state limit');
    const frame={height:1};g.active.add(key);g.stack.push(frame);
    try {
      const value=await fn();g.done.set(key,{value,height:frame.height});return value;
    } finally {
      g.stack.pop();g.active.delete(key);
      if(g.stack.length) g.stack.at(-1).height=Math.max(g.stack.at(-1).height,frame.height+1);
    }
  }
}
