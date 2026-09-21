import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMenu} from '../menu.mjs';
import {mountPanel} from '../panel.mjs';
class Element {
  constructor(){this.children=[];this.style={};this.dataset={};this.value='';this.isConnected=false;}
  append(...nodes){for(const n of nodes){n.parent=this;n.isConnected=true;this.children.push(n);}}
  setAttribute(){}attachShadow(){return new Element();}get options(){return this.children;}
  replaceChildren(...n){this.children=[];this.append(...n);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;this.isConnected=false;}
}
test('wand entry mounts once, opens detached panel outside body, closes and cleans up',async()=>{
  const body=new Element(),html=new Element(),menu=new Element();html.append(body);body.append(menu);
  const host={document:{body,documentElement:html,createElement:()=>new Element(),getElementById:id=>id==='extensionsMenu'?menu:null},
    localStorage:{getItem:()=>null},addEventListener(){},removeEventListener(){},innerWidth:1000,innerHeight:800};
  let connects=0;
  const demo={workbench:{cancel(){}},catalog:async()=>({items:[],done:true}),current:async()=>({}),invalidate(){}};
  const panel=mountPanel({host,connect:async()=>{connects++;return demo;}});
  const entry=mountMenu(host,()=>panel.open());
  assert.equal(panel.root.isConnected,false);assert.equal(connects,0);assert.equal(menu.children.length,1);
  await entry.item.onclick({preventDefault(){}});
  assert.equal(connects,1);assert.equal(panel.root.parent,html);assert.equal(body.children.length,1);
  assert.equal(menu.style.display,'none');assert.equal(panel.controls.panel.hidden,false);
  panel.controls.close.onclick();assert.equal(panel.root.isConnected,false);assert.equal(body.children.length,1);
  entry.dispose();panel.dispose();assert.equal(menu.children.length,0);assert.equal(html.children.length,1);
});
