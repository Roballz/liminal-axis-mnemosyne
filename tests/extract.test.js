import test from 'node:test';
import assert from 'node:assert/strict';
import { extract,compile,validateRule } from '../lib/extract.js';
import { actionFor,blankBook,blankFolder,tagPage,touchTags } from '../lib/model.js';

const book=blankBook();
book.folders=[{...blankFolder('信箱'),names:['与青岚的微信','微信·青岚'],pattern:'^与(?<person>.+?)的微信$',person:'阿澄'},
    {...blankFolder('线索'),names:['与青岚的微信']}];
book.ignoreAttrs=['data-status'];book.ignoreNames=['体力表'];
const run=(mes,b=book)=>extract({mes,send_date:'fixture'},compile(b));
const wrap=(name,body='文字')=>'<div data-nvwa-ui="'+name+'">'+body+'</div>';

test('完整别名与正则取并集，同一块只入一次索引',()=>{
    const {rows}=run(wrap('与青岚的微信')+wrap('微信·青岚')+wrap('与玉山的微信'));
    assert.deepEqual(rows.map(r=>r.folders),[['信箱','线索'],['信箱'],['信箱']]);
    assert.deepEqual(rows.map(r=>r.people),[['阿澄','青岚'],['阿澄'],['阿澄','玉山']]);
});
test('完整切片保留嵌套、同楼多块和跨日时间',()=>{
    const block=wrap('微信·青岚','<div title="x > y"><span>22:01</span></div><button>备选</button>');
    const raw='<globalTime>某年五月初三</globalTime>'+block+wrap('未知')+'<endTime>次日凌晨</endTime>';
    const {rows}=run(raw);assert.equal(raw.slice(rows[0].from,rows[0].to),block);
    assert.equal(rows[0].start,'某年五月初三');assert.equal(rows[1].end,'次日凌晨');
    assert.deepEqual(rows[1].folders,[]);assert.equal(rows[1].slot,1);
});
test('过滤属性优先于匹配，过滤名称跳过整个子树',()=>{
    const a=run('<div data-status>'+wrap('与青岚的微信')+'</div>'+wrap('体力表','<div>b</div>'));
    assert.deepEqual(a,{rows:[],unmarkedDiv:false});assert.equal(actionFor(a,true),'');
    assert.deepEqual(run('<div>'+wrap('体力表')+'</div>'),{rows:[],unmarkedDiv:false});
    assert.equal(run(wrap('体力表')+wrap('陌生')).rows[0].name,'陌生');
});
for(const [name,source,want] of [
    ['纯正文','全是叙述',''],['只有 span','<span>一个</span>',''],
    ['文本伪标记','比较符 &lt;div&gt;',''],['注释与脚本','<!-- <div>a</div> --><script>"<div>"</script>',''],
    ['未标记 div','<div class="box">短信</div>','zero'],
    ['陌生名称',wrap('新名字'),'blocks'],['已知名称',wrap('微信·青岚'),'blocks'],
    ['忽略块旁的独立 div',wrap('体力表')+'<div>其他</div>','zero'],
])test(name,()=>{const scan=run(source);assert.equal(actionFor(scan,true),want);
    assert.equal(actionFor(scan,false),want==='blocks'?'blocks':'');});
test('自定义元素、属性、记住的其他格式、日期正则',()=>{
    const alt={...blankFolder('报刊'),tag:'section',attr:'title',names:['简报'],extra:[{tag:'aside',attr:'data-paper',names:['早报']}]};
    const b={...book,folders:[alt],startPattern:'日期【(.*?)】'};
    const {rows}=run('日期【初一】<section title="简报">a</section><aside data-paper="早报">b</aside>',b);
    assert.deepEqual(rows.map(r=>[r.folders,r.start]),[[['报刊'],'初一'],[['报刊'],'初一']]);
    assert.throws(()=>validateRule({...alt,pattern:'['}));
});
test('关键词十个一批，尾批保留且循环，近期常用优先',()=>{
    const now=Date.now();let tags=touchTags([],Array.from({length:23},(_,i)=>'标签'+i),now);
    tags=touchTags(tags,['标签18'],now+1);
    assert.equal(tagPage(tags,0,now+1)[0],'标签18');
    assert.equal(tagPage(tags,1).length,10);assert.equal(tagPage(tags,2).length,3);
    assert.deepEqual(tagPage(tags,3),tagPage(tags,0));
    assert.equal(new Set([...tagPage(tags,0),...tagPage(tags,1),...tagPage(tags,2)]).size,23);
});
test('过滤支持按元素与属性值精确匹配，保留同属性的其他值',()=>{
    const b={...book,ignoreAttrs:['div[data-role="status"]','<aside>']};
    const source='<aside>'+wrap('微信·青岚')+'</aside><div data-role="status">'+wrap('微信·青岚')+'</div>'+
        '<div data-role="letter" data-nvwa-ui="微信·青岚">内容</div>';
    const scan=run(source,b);assert.deepEqual(scan.rows.map(r=>r.name),['微信·青岚']);assert.equal(scan.unmarkedDiv,false);
});
