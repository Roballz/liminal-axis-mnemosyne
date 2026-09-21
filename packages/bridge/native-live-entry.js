(async()=>{
  await globalThis.__TAURITAVERN__.ready;
  const {mountPanel}=await import('./packages/bridge/panel.mjs');
  const panel=mountPanel(),button=document.createElement('button');
  button.textContent='验证当前小样本（只读源）';panel.root.append(button);
  button.onclick=async()=>{
    button.disabled=true;
    const endpoint='http://127.0.0.1:19375';let config;
    try{
      config=await(await fetch(endpoint+'/phase')).json();
      if(config.fixture!=='mnemosyne-t04-synthetic')throw Error('Wrong local collector');
      const{runLiveRead}=await import('./packages/bridge/native-live.mjs');
      const result=await runLiveRead(panel,globalThis,config.run);
      await fetch(endpoint+'/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
    }catch(e){
      // Error codes and fixed generic hints only; never send source text/locators.
      if(config)await fetch(endpoint+'/result',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'error',run:config.run,code:e.code??'ERROR',message:'Actual interface demonstration stopped; preserve source and target.'})}).catch(()=>{});
      button.textContent=`验证未完成：${e.code??'ERROR'}。需要1–16条且已有摘要的隔离聊天。`;
      button.disabled=false;
    }
  };
})();
