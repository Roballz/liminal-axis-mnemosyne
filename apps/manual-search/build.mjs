import { readFile,writeFile,mkdir,copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const version=JSON.parse(await readFile(path.join(root,'apps/manual-search/manifest.json'),'utf8').then(t=>t.replace(/^\uFEFF/,''))).version;
const out=path.join(root,'dist','mnemosyne-manual-search'),runtime=path.join(out,`runtime-${version}`);
const seen=new Set(),hashes=[];
async function copy(relative) {
  if(seen.has(relative))return;seen.add(relative);
  const absolute=path.resolve(root,relative);
  if(!absolute.startsWith(root)||relative.includes('tests/')||relative.includes('native'))throw Error('Unexpected runtime dependency: '+relative);
  const text=await readFile(absolute,'utf8');
  const target=path.join(runtime,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,text);
  hashes.push({path:`runtime-${version}/${relative}`,sha256:createHash('sha256').update(text).digest('hex')});
  const pattern=/(?:from\s*|import\s*\(\s*|import\s*)(['"])(\.[^'"]+)\1/g;
  for(const match of text.matchAll(pattern))await copy(path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[2])));
}
await copy('packages/demo/entry.mjs');
for(const file of ['index.js','manifest.json','README.md'])await copyFile(path.join(root,'apps/manual-search',file),path.join(out,file));
const entry=await readFile(path.join(out,'index.js'),'utf8');
if(!entry.includes(`runtime-${version}/`))throw Error('Entry/manifest version mismatch');
await writeFile(path.join(out,'SHA256.json'),JSON.stringify({version,files:hashes.sort((a,b)=>a.path.localeCompare(b.path))},null,2)+'\n');
console.log(JSON.stringify({out,version,modules:seen.size}));
