(async()=>{
  await globalThis.__TAURITAVERN__.ready;
  const {TTSource,rawMessage,projectLegacy,snapshot}=await import('./packages/bridge/source.mjs');
  const {digest}=await import('./packages/bridge/records.mjs');
  const button=document.createElement('button');button.textContent='Mnemosyne · 只读定位错误';
  button.style.cssText='position:fixed;bottom:12px;right:12px;z-index:9999';document.body.append(button);
  button.onclick=async()=>{
    button.disabled=true;const endpoint='http://127.0.0.1:19375';let config,stage='collector',candidateTypes={};
    const safe=new Set(['Non-JSON or cyclic value','Non-JSON object','Sparse or extended array','Invalid Unicode',
      'Non-finite number','Accessors/symbols/hidden fields are not JSON','Unexpected public DTO field',
      'Raw TT message text required','Raw swipe text required','Duplicate legacy identity','Source message order/role']);
    try{
      config=await(await fetch(endpoint+'/phase')).json();
      const source=new TTSource(),rows=globalThis.SillyTavern.getContext().chat;
      if(!Array.isArray(rows)||rows.length>32)throw Error('Sample limit');
      for(const row of rows)if(Array.isArray(row.swipes))for(let i=0;i<row.swipes.length;i++){
        const value=row.swipes[i],type=!Object.hasOwn(row.swipes,i)?'hole':value===null?'null':Array.isArray(value)?'array':typeof value;
        candidateTypes[type]=(candidateTypes[type]??0)+1;
      }
      stage='source-hash';digest(rows.map(m=>({mes:m.mes,is_user:m.is_user??null,is_system:m.is_system??null})));
      stage='identity';const identity=await source.identity();
      stage='raw-messages';const messages=rows.map(rawMessage);digest(messages);
      stage='legacy-projection';const legacy=projectLegacy(globalThis.STBaiBaiBook,messages,[],identity.chatId);
      stage='snapshot';snapshot(identity.source,messages,legacy);
      stage='actual-capture';await source.capture();
      await fetch(endpoint+'/result',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'done',run:config.run,diagnostic:true,stage,sourceWrites:0,targetWrites:0})});
      button.textContent='只读诊断完成';
    }catch(e){
      if(config)await fetch(endpoint+'/result',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'error',run:config.run,diagnostic:true,stage,code:e.code??'ERROR',
          detail:safe.has(e.message)?e.message:'unlisted-error',candidateTypes,sourceWrites:0,targetWrites:0})}).catch(()=>{});
      button.textContent='诊断已停止；请返回Codex';
    }
  };
})();
