(async () => {
  try {
    const { start } = await import('./runtime-0.1.0/packages/demo/entry.mjs');
    await start();
  } catch (error) {
    // No chat text or error object in console output.
    console.error('[Mnemosyne] 入口加载失败，请核对完整安装包并刷新页面。');
    const note=document.createElement('div');
    note.textContent='Mnemosyne 档案加载失败，请核对完整安装包并刷新页面。点击关闭。';
    Object.assign(note.style,{position:'fixed',right:'20px',bottom:'20px',zIndex:2147483000,background:'#263e40',color:'#fff',padding:'16px',borderRadius:'12px'});
    note.onclick=()=>note.remove();document.body.append(note);
    addEventListener('pagehide',()=>note.remove(),{once:true});
  }
})();
