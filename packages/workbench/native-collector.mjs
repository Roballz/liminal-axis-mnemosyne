import {createServer} from 'node:http';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
const files=new Map();
for(const part of ['contracts','storage','bridge','workbench','workbench/unicode'])for(const file of readdirSync(`packages/${part}`))
  if(file.endsWith('.mjs'))files.set(`/packages/${part}/${file}`,`packages/${part}/${file}`);
const server=createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','http://tauri.localhost');res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  if(req.method==='GET'&&files.has(req.url)){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(files.get(req.url)));return;}
  if(req.method!=='POST'||req.url!=='/result'){res.writeHead(404).end();return;}
  let body='';for await(const c of req){body+=c;if(body.length>12000){res.writeHead(413).end();return;}}
  const value=JSON.parse(body);if(value.run!=='20260922t05'){res.writeHead(400).end();return;}
  writeFileSync('evals/t05/native-20260922.json',JSON.stringify(value,null,2)+'\n');res.end('ok');console.log(JSON.stringify(value));server.close();
});
server.listen(19375,'127.0.0.1',()=>console.log('T05 module host ready; explicit one-shot synthetic action'));
server.requestTimeout=10000;
setTimeout(()=>{console.log('Listener ended; this is not cancellation of TT in-flight work.');server.close();},300000).unref();
