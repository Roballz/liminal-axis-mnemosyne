/** Synthetic Node/fake-IDB check, not a WebView/phone responsiveness claim.
 * Same dataset as evals/core-reorganization-responsiveness.html; production codec,
 * reorganization, validation and restore functions. No private data or native IO. */
const {createRequire}=require('node:module');
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const {readFileSync,mkdtempSync,rmSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..'), temp=mkdtempSync(path.join(os.tmpdir(),'mnemosyne-reorganization-'));
let source=readFileSync(path.join(root,'evals/core-reorganization-responsiveness.html'),'utf8').split('<script type="module">')[1].split('</script>')[0];
source=source.replace("const result = document.querySelector('#result');", "import 'fake-indexeddb/auto'; import {reorganizeCoreLibrary} from './src/mnemosyne/core-reorganization';");
source=source.replaceAll("'/src/", "'./src/");
source=source.replace("const { runBackupWorker } = await import('./src/mnemosyne/backup-worker-client.ts');", '');
source=source.replace("const outcome=await runBackupWorker(undefined,{kind:'reorganize',library:source.db.name},()=>true,undefined,undefined,()=>{progress++;});", "const outcome={state:'reorganized',report:await reorganizeCoreLibrary(source,async()=>true,()=>{progress++;})};");
source=source.replace("const exported=await runBackupWorker(undefined,{kind:'export',library:report.library},()=>true);", "const exported={state:'exported',blob:new Blob([JSON.stringify(await exportLibrary(target))])};");
source=source.replace("const restored=await runBackupWorker(undefined,{kind:'import',blob:exported.blob},()=>true);", "const restoredCopy=await restoreLibrary(JSON.parse(await exported.blob.text()),false); const restored={state:'restored',library:restoredCopy.db.name}; restoredCopy.close();");
source=source.replace("workerExportImportEqual:equal", "exportImportEqual:equal,runtime:'Node/fake-indexeddb'");
source=source.replaceAll('result.textContent=JSON.stringify(value,null,2);window.benchmarkDone=true;', "delete value.library; console.log(JSON.stringify(value,null,2));");
source=source.replaceAll("result.textContent=String(error)+'\\n'+error.stack;window.benchmarkDone=true;", "console.error(error); process.exitCode=1;");
(async()=>{try{const filename=path.join(temp,'benchmark.mjs');await build({stdin:{contents:source,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:filename,logLevel:'silent',alias:{'@':path.join(root,'src')}});const result=spawnSync(process.execPath,['--max-old-space-size=4096',filename],{encoding:'utf8',timeout:110000});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.error)throw result.error;process.exitCode=result.status??1;}finally{rmSync(temp,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
