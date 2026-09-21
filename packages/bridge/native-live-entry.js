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
      const safe=new Set(['Non-JSON or cyclic value','Non-JSON object','Sparse or extended array','Invalid Unicode',
        'Raw swipe text required','Unexpected public DTO field','Source message order/role','Bridge record fields']);
      if(config)await fetch(endpoint+'/result',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'error',run:config.run,code:e.code??'ERROR',
          phase:['读取来源并预览','确认当前预览'].includes(e.phase)?e.phase:'other',detail:safe.has(e.message)?e.message:'unlisted-error',
          message:'Actual interface demonstration stopped; preserve source and target.'})}).catch(()=>{});
      button.textContent=`验证未完成：${e.code??'ERROR'}。需要1–32条且已有摘要的隔离聊天。`;
      button.disabled=false;
    }
  };
})();
