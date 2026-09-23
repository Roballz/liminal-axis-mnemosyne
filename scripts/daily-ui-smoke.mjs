// Synthetic local browser only. Never connects to TT or a model provider.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4173'],{stdio:'ignore'});
let browser;
try {
 for(let n=0;n<40;n++){try{if((await fetch('http://127.0.0.1:4173/scripts/daily-smoke.html')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:4173/')?route.continue():route.abort());
 await page.goto('http://127.0.0.1:4173/scripts/daily-smoke.html');await page.waitForFunction(()=>window.__smoke?.ready);
 await page.getByRole('heading',{name:'Mnemosyne 档案 / 迁移'}).waitFor();
 await page.getByRole('button',{name:'事件',exact:true}).first().click();
 await page.getByRole('heading',{name:'事件',exact:true}).waitFor();
 const event=page.locator('.mn-card').filter({has:page.locator('summary strong',{hasText:'玉佩归还'})});
 assert.equal(await event.getAttribute('open'),null);await event.locator(':scope > summary').click();
 await event.getByText('人工锁定',{exact:false}).waitFor();
 await page.getByRole('button',{name:'表格',exact:true}).click();
 await page.getByRole('heading',{name:'本地自定义表'}).waitFor();
 let replies=['合成事项表'];page.on('dialog',async dialog=>dialog.accept(replies.shift()??''));
 await page.getByRole('button',{name:'新建表',exact:true}).click();await page.getByRole('heading',{name:'合成事项表'}).waitFor();
 replies=['备注','text','manual','人工记录'];await page.getByRole('button',{name:'新增字段',exact:true}).click();
 await page.getByRole('columnheader',{name:'备注'}).waitFor();
 replies=['这是一条合成记录'];await page.getByRole('button',{name:'新增行',exact:true}).click();
 await page.getByRole('cell',{name:'这是一条合成记录',exact:true}).waitFor();
 await page.getByPlaceholder('搜索行').fill('不会匹配');assert.equal(await page.getByRole('cell',{name:'这是一条合成记录',exact:true}).count(),0);
 await page.getByPlaceholder('搜索行').fill('');await page.screenshot({path:'/tmp/w01-ui-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: synthetic Chromium 390x844 archive, folded event, manual table/column/row CRUD, search, no page errors; no TT/model calls.');
} finally {await browser?.close();server.kill();}
