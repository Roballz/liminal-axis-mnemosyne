import { canonicalize, equal, requireThat as check } from '../contracts/primitives.mjs';
import { digest } from './records.mjs';

export const OPTIONAL = ['items', 'scenes', 'lifeDetails'];
const fields = {
  items: ['id','name','desc','qty','carried','location','createdAt','updatedAt'],
  scenes: ['id','name','path','parentId','desc','createdAt','updatedAt'],
  lifeDetails: ['id','subject','text','topics','anchors','tier','until','createdTime','createdAt'],
};
function pick(value, keys) {
  const out = {};
  for (const key of keys) if (Object.hasOwn(value, key)) {
    const v = value[key];
    check(v === null || ['string','number','boolean'].includes(typeof v) ||
      Array.isArray(v) && v.every(x => typeof x === 'string'), 'INVALID_SCHEMA', 'Unexpected public DTO field');
    out[key] = structuredClone(v);
  }
  return out;
}
export function rawMessage(message, floor) {
  check(message && typeof message.mes === 'string', 'INVALID_SCHEMA', 'Raw TT message text required');
  const role = message.is_system ? 'system' : message.is_user === true ? 'user' : message.is_user === false ? 'assistant' : 'other';
  const candidates = Array.isArray(message.swipes) ? message.swipes.map(text => {
    check(typeof text === 'string', 'INVALID_SCHEMA', 'Raw swipe text required'); return text;
  }) : [];
  const selected = Number.isSafeInteger(message.swipe_id) ? message.swipe_id : null;
  // The currently displayed raw mes is authoritative; absent candidates are not invented.
  return { floor, role, content: message.mes, candidates, selected };
}
export function parseJSONL(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  check(lines.length > 0 && !Object.hasOwn(lines[0], 'mes'), 'INVALID_SCHEMA', 'TT JSONL header must be separate');
  return lines.slice(1).map(rawMessage);
}
export function ordinaryPair(messages, floor) {
  return floor > 0 && messages[floor]?.role === 'assistant' && messages[floor - 1]?.role === 'user' &&
    (floor < 2 || messages[floor - 2]?.role !== 'user') && messages[floor + 1]?.role !== 'assistant';
}
function floorAsset(f, messages) {
  if(f.omitted||!f.memory?.valid||typeof f.memory.summary!=='string'||!f.memory.summary.length)return null;
  return {category:'summary',source_id:`floor:${f.floor}:${f.memory.id??'unknown'}`,anchor:f.floor,
    data:{text:f.memory.summary,old_id:f.memory.id??null,floor:f.floor,ordinary_pair:ordinaryPair(messages,f.floor),validity:'legacy-asserted'}};
}
const nodeData=n=>pick(n,['id','kind','level','text','timeStart','timeEnd','timeLabel','createdAt','floorStart','floorEnd']);
function legacySelection(snapshot,history,categories) {
  if((history.nodes?.length??0)>64||categories.some(c=>(snapshot[c]?.length??0)>64))return null;
  return {nodes:(history.nodes??[]).map(n=>({id:n.id,kind:n.kind,start:n.floorStart,end:n.floorEnd,hash:digest(nodeData(n))})),
    optional:categories.flatMap(category=>(snapshot[category]??[]).map(item=>({category,id:item.id,hash:digest(pick(item,fields[category]))}))),
    missing:[...snapshot.coverage.missingAiFloors]};
}
export function projectLegacy(api, messages, categories = [], identity = null) {
  check(categories.every(k => OPTIONAL.includes(k)), 'INVALID_SCHEMA', 'Import category');
  const report = { available: false, pluginVersion: null, coverage: null, unprovided: ['summaries','higher','items','scenes','lifeDetails'],
    excluded: ['state','protagonist','npcs','vars','plans','vectors','credentials','injection'],
    limitations: [], unpaired: messages.filter((m, i) => !ordinaryPair(messages, i) && m.role === 'assistant').map(m => m.floor) };
  if (!api) return { assets: [], report };
  check(api.apiVersion === 1, 'UNSUPPORTED', 'Unsupported BaiBai public API');
  const snapshot = api.getSnapshot(), history = api.getHistory();
  check(snapshot.revision === history.revision && equal(snapshot.chat, history.chat) && snapshot.chat.length === messages.length,
    'VERSION_CONFLICT', 'Legacy snapshot/history mismatch');
  if (identity !== null) check(snapshot.chat.id === identity, 'VERSION_CONFLICT', 'Legacy chat differs');
  const assets = [];
  const add = (category, source_id, data, anchor) => assets.push({category, source_id, data, anchor});
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const f = api.getFloor(m.floor);
    check(f.revision === snapshot.revision && equal(f.chat, snapshot.chat) && f.floor === m.floor,
      'VERSION_CONFLICT', 'Legacy floor read changed');
    if (!f.omitted && f.memory?.valid && typeof f.memory.summary === 'string' && f.memory.summary.length) {
      add('summary', `floor:${m.floor}:${f.memory.id ?? 'unknown'}`, {
        text: f.memory.summary, old_id: f.memory.id ?? null, floor: m.floor,
        ordinary_pair: ordinaryPair(messages, m.floor), validity: 'legacy-asserted',
      }, m.floor);
    }
  }
  for (const n of history.nodes ?? []) if (n.kind === 'comp') {
    add('higher', `higher:${n.id}`, pick(n, ['id','kind','level','text','timeStart','timeEnd','timeLabel','createdAt','floorStart','floorEnd']), null);
  }
  for (const category of categories) for (const item of snapshot[category] ?? []) {
    check(typeof item.id === 'string' && item.id.length > 0, 'INVALID_SCHEMA', 'Legacy stable item ID required');
    add(category, `${category}:${item.id}`, pick(item, fields[category]), null);
  }
  check(new Set(assets.map(a => a.source_id)).size === assets.length, 'INVALID_SCHEMA', 'Duplicate legacy identity');
  report.available = true; report.pluginVersion = api.pluginVersion;
  report.coverage = { complete: snapshot.coverage.complete === true, missingAiFloors: [...snapshot.coverage.missingAiFloors] };
  report.unprovided = OPTIONAL.filter(k => !categories.includes(k));
  report.legacy_selection=legacySelection(snapshot,history,categories);
  report.limitations = ['Only selected higher nodes are exposed; not every stored level.',
    'Legacy generation inputs are unproven; retained as scoped bridge material, not source-derived TurnMemory.'];
  check(api.getSnapshot().revision === snapshot.revision, 'VERSION_CONFLICT', 'Legacy changed during read');
  return { assets, report };
}

export function snapshot(source, messages, legacy = { assets: [], report: { available: false } }, generation = 0) {
  check(typeof source === 'string' && source.length > 0, 'INVALID_SCHEMA', 'Explicit source identity required');
  messages.forEach((m, i) => {
    check(m.floor === i && typeof m.content === 'string' && ['user','assistant','system','other'].includes(m.role),
      'INVALID_SCHEMA', 'Source message order/role');
  });
  const body = { source, messages: structuredClone(messages), assets: structuredClone(legacy.assets), report: structuredClone(legacy.report) };
  check(new TextEncoder().encode(canonicalize(body)).length <= 32 * 1024 * 1024, 'RESOURCE_LIMIT', 'Explicit input snapshot exceeds 32MiB');
  return { ...body, generation, fingerprint: digest(body) };
}

export function restrictSnapshot(input, length) {
  check(Number.isSafeInteger(length) && length >= 0 && length <= input.messages.length,'INVALID_SCHEMA','Source cutoff');
  const assets=input.assets.filter(a=>a.anchor!==null ? a.anchor<length : a.category==='higher' ?
    Number.isSafeInteger(a.data.floorEnd)&&a.data.floorEnd<length : false);
  return {...snapshot(input.source,input.messages.slice(0,length),{assets,report:{...input.report,
    inheritance_cutoff:length,omitted_outside_cutoff:input.assets.length-assets.length}},input.generation),...(input.identity?{identity:input.identity}:{})};
}

// One manual stable read. Events invalidate plans; they are never treated as a log.
export class TTSource {
  constructor(host = globalThis) { this.host = host; this.generation = 0; this.generating = false; this.generationKind=null; this.unsubscribers = []; }
  cancel() { this.generation++; }
  subscribe(onNotice) {
    const ctx = this.host.SillyTavern?.getContext?.();
    const emit = name => (...args) => {
      this.generation++;
      if (name === 'GENERATION_STARTED') {this.generating = true;this.generationKind=typeof args[0]==='string'?args[0]:null;}
      if (['GENERATION_ENDED','GENERATION_STOPPED'].includes(name)) this.generating = false;
      if(name==='CHAT_CHANGED'){this.generating=false;this.generationKind=null;}
      onNotice({ name, index: Number.isSafeInteger(args[0]) ? args[0] : null, generation: this.generation, generating: this.generating,
        generationKind:this.generationKind });
    };
    for (const name of ['CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_RECEIVED','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED']) {
      const event = (ctx?.eventTypes ?? ctx?.event_types)?.[name];
      if (event && ctx.eventSource?.on) {
        const fn = emit(name); ctx.eventSource.on(event, fn);
        this.unsubscribers.push(() => ctx.eventSource.removeListener(event, fn));
      }
    }
    const api = this.host.STBaiBaiBook;
    if (api?.subscribe) this.unsubscribers.push(api.subscribe(emit('LEGACY_CHANGED')));
    return () => { this.cancel(); this.unsubscribers.splice(0).forEach(fn => fn()); };
  }
  async identity() {
    const ctx = this.host.SillyTavern?.getContext?.();
    const current = this.host.__TAURITAVERN__?.api?.chat?.current;
    check(ctx && current, 'NOT_READY', 'TT current chat unavailable');
    const ref = await current.ref(), handle = await current.handle();
    check(ref && handle && Array.isArray(ctx.chat), 'NOT_READY', 'Open a chat first');
    const stable_id=await handle.stableId();
    check(typeof stable_id==='string'&&stable_id.length>0&&['character','group'].includes(ref.kind),'NOT_READY','Stable scoped host identity required');
    const scope={host:'TT',kind:ref.kind,owner:ref.kind==='character'?ref.characterId:(ctx.groupId??null)};
    check(ref.kind!=='character'||typeof scope.owner==='string','NOT_READY','Character scope required');
    const source=digest({identity_version:2,scope,stable_id});
    const identity={source,scope,stable_id,locator:structuredClone(ref),legacy_source:digest({ref,stable:stable_id})};
    return {source,identity,chatId:ctx.getCurrentChatId?.()??null,ctx};
  }
  async capture(categories = []) {
    const generation = this.generation, first = await this.identity();
    check(!this.generating, 'NOT_READY', 'Generation in progress');
    const messages = first.ctx.chat.map(rawMessage);
    const legacy = projectLegacy(this.host.STBaiBaiBook, messages, categories, first.chatId);
    const second = await this.identity();
    check(generation === this.generation && equal(first.identity,second.identity) &&
      equal(messages, second.ctx.chat.map(rawMessage)), 'VERSION_CONFLICT', 'Source changed while reading');
    return {...snapshot(first.source, messages, legacy, generation),identity:first.identity};
  }
  async guard(captured) {
    const current = await this.identity();
    check(!this.generating && (captured.identity?.source??captured.source) === current.source && captured.generation === this.generation &&
      (!captured.identity||equal(captured.identity.locator,current.identity.locator)),
      'VERSION_CONFLICT', 'Old source session');
  }
  async captureLocal(start, count = 1) {
    check(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(count) && count > 0 && count <= 16,
      'RESOURCE_LIMIT', 'Local read range');
    const generation = this.generation, first = await this.identity();
    check(!this.generating, 'NOT_READY', 'Generation pending');
    const total = first.ctx.chat.length;
    const messages = first.ctx.chat.slice(start, start + count).map((m,i)=>rawMessage(m,start+i));
    const neighbors = [];
    for (const i of [start-1,start+messages.length]) if (i >= 0 && i < total) neighbors.push(rawMessage(first.ctx.chat[i],i));
    const second = await this.identity();
    check(generation === this.generation && equal(first.identity,second.identity) && second.ctx.chat.length === total &&
      equal(messages,second.ctx.chat.slice(start,start+count).map((m,i)=>rawMessage(m,start+i))),
      'VERSION_CONFLICT', 'Local source changed while reading');
    return {source:first.source,identity:first.identity,generation,start,total,messages,neighbors};
  }
  async captureLegacy(previous,categories,dirtyFloors=[]) {
    const generation=this.generation,first=await this.identity(),api=this.host.STBaiBaiBook;
    check(!this.generating,'NOT_READY','Generation pending');
    if(!api)return null;
    check(api.apiVersion===1,'UNSUPPORTED','Legacy API version');
    const state=api.getSnapshot(),history=api.getHistory();
    check(state.revision===history.revision&&equal(state.chat,history.chat)&&state.chat.id===first.chatId&&state.chat.length===first.ctx.chat.length,
      'VERSION_CONFLICT','Legacy source changed');
    const selection=legacySelection(state,history,categories);
    check(previous&&selection,'RESOURCE_LIMIT','Legacy selection exceeds bounded automatic inspection; manually recheck');
    const changed=selection.nodes.filter(n=>!previous.nodes.some(p=>p.id===n.id&&p.hash===n.hash));
    const floors=new Set(dirtyFloors),assets=[];
    for(const n of changed) {
      check(Number.isSafeInteger(n.start)&&Number.isSafeInteger(n.end)&&n.start>=0&&n.end>=n.start&&n.end-n.start<16,
        'NOT_READY','Changed legacy node needs explicit range review');
      for(let i=n.start;i<=n.end;i++)floors.add(i);
      if(n.kind==='comp'){const data=nodeData(history.nodes.find(x=>x.id===n.id));assets.push({category:'higher',source_id:`higher:${n.id}`,data,anchor:null});}
    }
    check(floors.size<=16,'RESOURCE_LIMIT','Legacy changed floor budget');
    check(equal(selection.missing,previous.missing)||selection.missing.every(i=>previous.missing.includes(i)),
      'NOT_READY','Previously available legacy material is now missing');
    for(const i of floors) {
      check(Number.isSafeInteger(i)&&i>=0&&i<first.ctx.chat.length,'VERSION_CONFLICT','Legacy floor outside current chat');
      if(rawMessage(first.ctx.chat[i],i).role!=='assistant')continue;
      const f=api.getFloor(i);
      check(f.floor===i&&f.revision===state.revision&&equal(f.chat,state.chat),'VERSION_CONFLICT','Legacy floor version');
      // A bounded sparse view is only used to check neighboring roles, never serialized.
      const nearby=[];for(let k=Math.max(0,i-2);k<=Math.min(i+1,first.ctx.chat.length-1);k++)nearby[k]=rawMessage(first.ctx.chat[k],k);
      const asset=floorAsset(f,nearby);
      if(asset)assets.push(asset);
    }
    for(const category of categories)for(const item of state[category]??[]) {
      const data=pick(item,fields[category]);
      if(!previous.optional.some(p=>p.category===category&&p.id===item.id&&p.hash===digest(data)))assets.push({category,source_id:`${category}:${item.id}`,data,anchor:null});
    }
    check(previous.optional.every(p=>selection.optional.some(n=>n.category===p.category&&n.id===p.id)),
      'NOT_READY','Legacy optional removal requires review');
    check(assets.length<=16,'RESOURCE_LIMIT','Legacy asset batch limit');
    const second=await this.identity();
    check(generation===this.generation&&equal(first.identity,second.identity)&&api.getSnapshot().revision===state.revision,
      'VERSION_CONFLICT','Legacy read became stale');
    return {source:first.source,identity:first.identity,generation,assets,selection,changed:!equal(previous,selection),
      messages:[...floors].map(i=>rawMessage(first.ctx.chat[i],i))};
  }
}
