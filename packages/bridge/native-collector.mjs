import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const run=process.argv[2];
if(!/^[a-z0-9]+$/.test(run??''))throw Error('Run ID required');
const server=createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','http://tauri.localhost');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  if(req.url==='/phase'&&req.method==='GET'){
    if(process.argv.includes('--drain')){res.writeHead(410).end('Drain only; do not start work');return;}
    res.end(JSON.stringify({fixture:'mnemosyne-t04-synthetic',run}));return;
  }
  if(req.url!=='/result'||req.method!=='POST'){res.writeHead(404).end();return;}
  let text='';for await(const c of req){text+=c;if(text.length>16000){res.writeHead(413).end();return;}}
  const result=JSON.parse(text);
  if(result.run!==run||!['done','error'].includes(result.type)){res.writeHead(400).end();return;}
  writeFileSync(`evals/t04/native-${run}.json`,JSON.stringify(result,null,2)+'\n');res.end('ok');server.close();
  console.log(JSON.stringify(result));
});
server.listen(19375,'127.0.0.1',()=>console.log('T04 synthetic collector ready'));
server.requestTimeout=10000;
setTimeout(()=>{console.log('Five-minute limit: no new work; drain native writes before retry.');server.close();},300000).unref();
