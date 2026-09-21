// One synthetic call-count probe, not a phone/Rust throughput benchmark.
import {PagedCoordinator} from '../../storage/paged-coordinator.mjs';
import {resourceMeter} from '../../storage/resource-meter.mjs';
import {snapshot,rawMessage} from '../../bridge/source.mjs';
import {Demo} from '../controller.mjs';
const nodes=new Map(),meter=resourceMeter();
const io={get:async s=>structuredClone(nodes.get(s)??null),put:async(s,p)=>{nodes.set(s,structuredClone(p));},flush:async()=>{},assertEmpty:async()=>{},close:async()=>{}};
const owner=new PagedCoordinator(meter.io(io)),h=await owner.create();
const input=snapshot('synthetic-27',Array.from({length:27},(_,i)=>rawMessage({mes:'虚构聊天正文。'.repeat(47)+i,is_user:i%2===0},i)));
const source={capture:async()=>input,guard:async()=>{},identity:async()=>({source:input.source})};
const demo=new Demo(h,source),started=performance.now();await demo.preview('合成27条');await demo.confirm();
console.log(JSON.stringify({kind:'node-map-not-native',messages:27,characters:input.messages.reduce((n,m)=>n+m.content.length,0),milliseconds:Math.round(performance.now()-started),physicalNodes:nodes.size,metrics:meter.snapshot()},null,2));
await owner.close();
