import { PagedCoordinator } from '../../storage/paged-coordinator.mjs';
import { FakeIO } from '../../storage/tests/fake-io.mjs';
import { Importer } from '../../bridge/importer.mjs';
import { snapshot,rawMessage } from '../../bridge/source.mjs';
export class IO extends FakeIO { async assertEmpty(){if(this.live.size)throw Error('not empty');} }
export const rows=[
  {mes:'ＨＥＬＬＯ　Straße\u0085钟楼',is_user:true},
  {mes:'铜钥匙与钟楼。',is_user:false,swipes:[null,'旧swipe不可搜',null],swipe_id:2},
  {mes:'system 钟楼',is_system:true},
  {mes:'<img src=x onerror=alert(1)> ab a b',is_user:true},
  {mes:'终点 钟楼 Σςσ İ ﬃ',is_user:false},
  {mes:'待回复 User',is_user:true}
];
export function input(source='fixture',values=rows,summary='旧摘要：铜钥匙与钟楼') {
  return snapshot(source,values.map(rawMessage),{assets:summary===null?[]:[
    {category:'summary',source_id:'floor:1:legacy',anchor:1,data:{text:summary,floor:1,ordinary_pair:true,validity:'legacy-asserted'}}
  ],report:{available:summary!==null}});
}
export async function commit(bridge,source,choice){return bridge.confirm(await bridge.preview(source,choice));}
export async function fixture(){const io=new IO(),owner=new PagedCoordinator(io),h=await owner.create(),bridge=new Importer(h);
  const bound=await commit(bridge,input());return{io,owner,h,bridge,bound};}
export const scope=b=>({branch:b.target.branch_id,bindingSource:b.source});

// Minimal DOM host only: all behavior under test comes from the product handlers.
export class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.style={};this.value='';this.checked=false;this.textContent='';this.attributes={};}
  setAttribute(k,v){this.attributes[k]=v;}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  remove(){this.removed=true;}
}
export const documentFixture=()=>({body:new Element('body'),createElement:tag=>new Element(tag)});
