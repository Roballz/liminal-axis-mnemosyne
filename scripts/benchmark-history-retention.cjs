/** Small synthetic acceptance probe: node scripts/benchmark-history-retention.cjs
 * Real production paths + fake IndexedDB; no user data, TT, phone or native disk.
 * Reports actual JSON UTF-8 bytes, not a prediction for a user's 200 MiB archive.
 */
const { build } = require('esbuild');
const { mkdtemp, rm } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const source = String.raw`
import 'fake-indexeddb/auto';
import { Library, freshLibraryName } from './src/mnemosyne/db';
import { synchronize } from './src/mnemosyne/canonical';
import { sourceSyncBaseline } from './src/mnemosyne/source-sync-guard';
import { cleanLibraryHistory } from './src/mnemosyne/history-cleanup';
import { exportLibrary } from './src/mnemosyne/migration';
import { exportArchive } from './src/mnemosyne/archive-package';
const lib = await Library.open(freshLibraryName());
const input = {scope:'retention-synthetic', messages:[
 {key:'user',role:'user',content:'合成问题',swipe:0},
 {key:'reply',role:'assistant',content:'合成正文',swipe:0}],
 memories:[{hostId:'leaf',content:'合成摘要',level:0,anchorKey:'reply',children:[],storyTime:'',seed:false,enabled:true}]};
const branch = await synchronize(lib,input);
try {
 for(let i=0;i<20;i++) {
  input.messages[1].content='合成正文修正 '+i;
  input.memories[0].content='合成摘要修正 '+i+'。'.repeat(700);
  await synchronize(lib,input);
 }
 const before=await exportLibrary(lib), cleanup=await cleanLibraryHistory(lib,async()=>true), after=await exportLibrary(lib);
 const live=[];
 for(let i=0;i<20;i++) {
  input.messages[1].content='后续正文修正 '+i;
  input.memories[0].content='后续摘要修正 '+i+'。'.repeat(700);
  await synchronize(lib,input,{...await sourceSyncBaseline(lib,input),retireHistory:true,isCurrent:()=>true});
  live.push(Buffer.byteLength(JSON.stringify(await exportLibrary(lib))));
 }
 const current=await exportLibrary(lib), single=await exportArchive(lib,branch.id);
 console.log(JSON.stringify({fixture:'one archive, one floor, twenty replacements before and after cleanup',
  oldHistoryPackageBytes:Buffer.byteLength(JSON.stringify(before)), cleanedPackageBytes:Buffer.byteLength(JSON.stringify(after)),
  removed:cleanup.removed, repeatedEditsFirstBytes:live[0], repeatedEditsLastBytes:live.at(-1),
  finalCounts:current.counts,singleArchiveBytes:Buffer.byteLength(JSON.stringify(single))},null,2));
} finally {lib.close();}
`;
(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mnemosyne-history-retention-'));
  let child, timer;
  try {
    const filename = path.join(directory, 'probe.mjs');
    await build({ stdin: { contents: source, resolveDir: root, loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', outfile: filename, logLevel: 'silent' });
    await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [filename], { stdio: 'inherit' });
      timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Synthetic probe exceeded 30 seconds')); }, 30_000);
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Probe exited: ' + code)));
    });
  } finally { clearTimeout(timer); if (child && child.exitCode === null) child.kill('SIGTERM'); await rm(directory, {recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode=1; });
