// Uses the same host-owned menu DOM contract as the installed BaiBai extension.
// Does not import ST internals or create a body sibling while the panel is closed.
export function mountMenu(host,open) {
  const doc=host.document,item=doc.createElement('div');
  item.id='mnemosyne-daily-menu';item.className='extension_container interactable';item.tabIndex=0;
  const link=doc.createElement('a');link.className='list-group-item';link.href='#';link.title='Mnemosyne 档案';
  const icon=doc.createElement('i');icon.className='fa-solid fa-book-open';icon.setAttribute('aria-hidden','true');
  const text=doc.createElement('span');text.textContent='Mnemosyne 档案';link.append(icon,text);item.append(link);
  let observer=null,disposed=false;
  const attach=()=>{if(disposed)return;const menu=doc.getElementById('extensionsMenu');if(!menu)return;
    if(!item.isConnected)menu.append(item);observer?.disconnect();};
  const activate=e=>{e.preventDefault();const menu=doc.getElementById('extensionsMenu');
    if(menu){if(host.$)host.$(menu).hide();else menu.style.display='none';}return open();};
  item.onclick=activate;item.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')activate(e);};
  attach();
  if(!item.isConnected&&host.MutationObserver){observer=new host.MutationObserver(attach);observer.observe(doc.body,{childList:true,subtree:true});}
  return {item,dispose(){disposed=true;observer?.disconnect();item.remove();}};
}
