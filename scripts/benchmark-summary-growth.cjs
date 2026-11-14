/** Optional synthetic storage-growth model. Run: node scripts/benchmark-summary-growth.cjs
 * Calls the real publisher through an in-memory Transaction, never a user library.
 * Counts all historical serialized bytes; trims only the fake working cache.
 * Per two floors: one L0; per eight L0: one L1; per five L1: one L2.
 * Does not measure full-package size, native IO, browser responsiveness or phone RAM.
 */
const { build } = require('esbuild');
const { mkdtemp, rm } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const source = String.raw`
import { publishMemoryView } from './src/mnemosyne/memory-selections';
const tables = new Map([['memory_views',new Map()],['memory_selection_nodes',new Map()]]);
let bytes = {memory_views:2,memory_selection_nodes:2}, nodeCount=0, entriesWritten=0;
const tx={rawGet:async(s,k)=>tables.get(s).get(k),get:async(s,k)=>tables.get(s).get(k),add:async(s,r)=>{
 if(s==='memory_views')tables.get(s).clear();
 tables.get(s).set(r.id,r); bytes[s]+=Buffer.byteLength(JSON.stringify(r))+1;
 if(s==='memory_selection_nodes'){nodeCount++;entriesWritten+=r.entries.length;}
}};
const branch='br_00000000-0000-4000-8000-000000000000';
const id=(p,n)=>p+'_'+n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000';
function trim(root){const nodes=tables.get('memory_selection_nodes'),keep=new Set(),stack=[root];while(stack.length){const k=stack.pop();if(!k||keep.has(k))continue;keep.add(k);stack.push(...Object.values(nodes.get(k).children));}for(const k of nodes.keys())if(!keep.has(k))nodes.delete(k);}
let previous, legacyBytes=2;
const steps=new Set([500,990,2500,5000]);
for(let i=1;i<=5000;i++){
 const l1=Math.floor(i/8),l2=Math.floor(l1/5),entries=[];
 for(let j=1;j<=i;j++)entries.push([id('mem',j),id('mr',j)]);
 for(let j=1;j<=l1;j++)entries.push([id('mem',100000+j),id('mr',100000+j)]);
 for(let j=1;j<=l2;j++)entries.push([id('mem',200000+j),id('mr',200000+j)]);
 const view={id:id('mv',i),schema:1,branch,selections:Object.fromEntries(entries)};
 legacyBytes+=Buffer.byteLength(JSON.stringify(view))+1;
 const beforeNodes=nodeCount,beforeEntries=entriesWritten;
 await publishMemoryView(tx,view,previous);
 previous=view;trim(tables.get('memory_views').get(view.id).root);
 if(steps.has(i))console.log(JSON.stringify({floors:2*i,L0:i,L1:l1,L2:l2,expectedDenseRankChanges:1+Math.floor((i-1)/8)+Math.floor(Math.floor((i-1)/8)/5)+(l1-Math.floor((i-1)/8))+(l2-Math.floor(Math.floor((i-1)/8)/5)),lastNodesWritten:nodeCount-beforeNodes,lastLeafEntriesWritten:entriesWritten-beforeEntries,cumulativeLeafEntriesWritten:entriesWritten,legacyViewBytes:legacyBytes,currentViewNodeBytes:bytes.memory_views+bytes.memory_selection_nodes,totalNodes:nodeCount,liveNodes:tables.get('memory_selection_nodes').size}));
}
`;
(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mnemosyne-summary-growth-'));
  let child, timer;
  try {
    const filename = path.join(directory, 'growth.mjs');
    await build({ stdin: { contents: source, resolveDir: root, loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', outfile: filename, logLevel: 'silent' });
    await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [filename], { stdio: 'inherit' });
      timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Growth model exceeded 110 seconds')); }, 110000);
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Growth model exited: ' + code)));
    });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
