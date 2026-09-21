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
  return snapshot(input.source,input.messages.slice(0,length),{assets,report:{...input.report,
    inheritance_cutoff:length,omitted_outside_cutoff:input.assets.length-assets.length}},input.generation);
}

// One manual stable read. Events invalidate plans; they are never treated as a log.
export class TTSource {
  constructor(host = globalThis) { this.host = host; this.generation = 0; this.generating = false; this.unsubscribers = []; }
  cancel() { this.generation++; }
  subscribe(onNotice) {
    const ctx = this.host.SillyTavern?.getContext?.();
    const emit = name => (...args) => {
      this.generation++;
      if (name === 'GENERATION_STARTED') this.generating = true;
      if (['GENERATION_ENDED','GENERATION_STOPPED'].includes(name)) this.generating = false;
      onNotice({ name, index: Number.isSafeInteger(args[0]) ? args[0] : null, generation: this.generation, generating: this.generating });
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
    return { source: digest({ ref, stable: await handle.stableId() }), chatId: ctx.getCurrentChatId?.() ?? null, ctx };
  }
  async capture(categories = []) {
    const generation = this.generation, first = await this.identity();
    check(!this.generating, 'NOT_READY', 'Generation in progress');
    const messages = first.ctx.chat.map(rawMessage);
    const legacy = projectLegacy(this.host.STBaiBaiBook, messages, categories, first.chatId);
    const second = await this.identity();
    check(generation === this.generation && first.source === second.source &&
      equal(messages, second.ctx.chat.map(rawMessage)), 'VERSION_CONFLICT', 'Source changed while reading');
    return snapshot(first.source, messages, legacy, generation);
  }
  async guard(captured) {
    const current = await this.identity();
    check(!this.generating && captured.source === current.source && captured.generation === this.generation,
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
    check(generation === this.generation && first.source === second.source && second.ctx.chat.length === total &&
      equal(messages,second.ctx.chat.slice(start,start+count).map((m,i)=>rawMessage(m,start+i))),
      'VERSION_CONFLICT', 'Local source changed while reading');
    return {source:first.source,generation,start,total,messages,neighbors};
  }
}
