const fs = require('node:fs'), vm = require('node:vm'), { Worker } = require('node:worker_threads');
const built = fs.readFileSync('dist/index.js','utf8');
const literals = built.match(/'(?:[^'\\]|\\.)*'/g) || [];
const literal = literals.find(s => s.includes('self.onmessage') && s.includes('Worker cannot write settings'));
if (!literal) throw Error('Missing inline backup worker');
const code = vm.runInNewContext(literal);
const bootstrap = `const {parentPort}=require('node:worker_threads'); global.self=global; global.postMessage=m=>parentPort.postMessage(m); require(${JSON.stringify(require.resolve('fake-indexeddb/auto', {paths:[process.cwd()]}))}); parentPort.on('message',data=>self.onmessage({data}));`;
const worker = new Worker(bootstrap+code,{eval:true});
const timer = setTimeout(()=>{ worker.terminate(); throw Error('startup timed out'); },10000);
worker.on('error',error=>{ clearTimeout(timer); throw error; });
worker.on('message',message=>{
 if(message.type==='ready') worker.postMessage({type:'start',job:{kind:'auto',library:'mnemosyne_daily_missing_worker_smoke',keep:5}});
 else if(message.type==='failed') { clearTimeout(timer); worker.terminate(); console.log('PASS: actual built inline worker starts in worker_threads; missing database safely fails:',message.error); }
 else throw Error('Unexpected disk request on missing database: '+JSON.stringify(message));
});
