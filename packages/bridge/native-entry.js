// Isolated demonstration entry, not the normal product entry.
(async()=>{
  await globalThis.__TAURITAVERN__.ready;
  const {mountPanel}=await import('./packages/bridge/panel.mjs');mountPanel();
  const endpoint='http://127.0.0.1:19375';
  let config;
  try{config=await(await fetch(endpoint+'/phase')).json();}catch{return;}
  if(config.fixture!=='mnemosyne-t04-synthetic')return;
  let result;
  try{const {runNativeDemo}=await import('./packages/bridge/native-demo.mjs');result=await runNativeDemo(globalThis.__TAURITAVERN__.api.db,config.run);}
  catch(e){result={type:'error',run:config.run,code:e.code??null,message:e.message};}
  await fetch(endpoint+'/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
})();
