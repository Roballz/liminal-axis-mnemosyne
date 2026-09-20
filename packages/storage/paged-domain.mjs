import { Pages } from './pages.mjs';
import { PagedJSON } from './paged-json.mjs';
import { equal, requireThat as check, canonicalize, newId, id } from '../contracts/primitives.mjs';
import { emptyState } from '../contracts/history.mjs';
import { SHA256Stream } from '../contracts/runtime.mjs';
export const DOMAIN_TABLES = Object.keys(emptyState()).filter(k => k !== 'schema_version');
export const EXTRA_TABLES = ['manifests', 'historyIndex', 'families', 'viewIds', 'markers'];
export const DOMAIN_LIMITS = Object.freeze({ objectBytes: 1048576, objectValues: 200000, graphDepth: 128 });
export class PagedDomain {
  constructor(pages, root) { this.pages = pages; this.json = new PagedJSON(pages); this.root = root; }
  static async empty(pages) {
    const json = new PagedJSON(pages);
    return new PagedDomain(pages, await json.write({ ...emptyState(), ...Object.fromEntries(EXTRA_TABLES.map(k=>[k,{}])) }));
  }
  async table(table) { return (await this.pages.get(await this.json.at(this.root, [table]))).root; }
  async ref(table, key) { return this.pages.mapGet(await this.table(table), key); }
  async get(table, key, required = true) {
    const ref = await this.ref(table, key); check(!required || ref, 'NEEDS_RESOLUTION', `Missing ${table}:${key}`);
    return ref ? structuredClone(await this.json.read(ref, { maxBytes: DOMAIN_LIMITS.objectBytes, maxValues: DOMAIN_LIMITS.objectValues })) : null;
  }
  async field(table, key, path) { const ref = await this.ref(table,key); check(ref,'NEEDS_RESOLUTION','Missing object'); return this.json.read(await this.json.at(ref,path)); }
  async setRef(table, key, ref, fresh = false) {
    check(!fresh || await this.ref(table,key) === null, 'ID_COLLISION', `Existing ${table}:${key}`);
    this.root = await this.json.set(this.root, [table,key], ref);
  }
  async delete(table,key) { const root=await this.pages.mapDelete(await this.table(table),key); this.root=await this.json.set(this.root,[table],await this.pages.put({kind:'json-object',root})); }
  async put(table,key,value,fresh=false) { await this.setRef(table,key,await this.json.write(value),fresh); }
  async patch(table,key,path,ref) { await this.setRef(table,key,await this.json.set(await this.ref(table,key),path,ref)); }
  async *records(table) { for await (const [key,ref] of this.pages.mapEntries(await this.table(table))) yield [key,ref]; }
  async allocate(kind, makeId = newId) {
    const value = id(kind,makeId(kind));
    if (kind === 'memoryView') check(await this.ref('viewIds',value) === null,'ID_COLLISION','View ID collision');
    return value;
  }
  async viewValue(branch, field, key) {
    const dict = await this.json.at(await this.ref('views',branch),[field]);
    const value = await this.pages.mapGet((await this.pages.get(dict)).root,key);
    return value ? this.json.read(value) : null;
  }
  async viewSet(branch, field, key, value) {
    const view = await this.ref('views',branch), dict = await this.json.at(view,[field]);
    const root = (await this.pages.get(dict)).root;
    const next = value === null ? await this.pages.mapDelete(root,key) : await this.pages.mapSet(root,key,await this.json.write(value));
    await this.patch('views',branch,[field],await this.pages.put({kind:'json-object',root:next}));
  }
  async *viewEntries(branch,field) {
    const dict = await this.json.at(await this.ref('views',branch),[field]);
    for await (const [key,ref] of this.pages.mapEntries((await this.pages.get(dict)).root)) yield [key,await this.json.read(ref)];
  }
  async sequence(snapshot) { return snapshot ? (await this.get('historyIndex',snapshot)).sequence : null; }
  async *entries(snapshot,start=0,count=null) {
    for await (const ref of this.pages.range(await this.sequence(snapshot),start,count)) yield (await this.pages.get(ref)).entry;
  }
  async entry(snapshot,index) { for await (const item of this.entries(snapshot,index,1)) return item; }
  async member(snapshot, message) {
    return this.indexMember(await this.get('historyIndex',snapshot),message);
  }
  async indexMember(index, message) {
    const ref = await this.pages.mapGet(index.members,message);
    if (!ref) return null;
    const item = await this.pages.get(ref);
    if (!equal(await this.pages.mapGet(index.order,item.label),ref)) return null;
    return item;
  }
  async matches(snapshot, entries, start=0) {
    if (start + entries.length > (await this.get('snapshots',snapshot)).message_count) return false;
    let i=0; for await (const ref of this.entries(snapshot,start,entries.length)) if (!equal(ref,entries[i++])) return false;
    return true;
  }
  async samePrefix(a,b,count) {
    const iter = this.entries(b,0,count)[Symbol.asyncIterator]();
    for await (const ref of this.entries(a,0,count)) if (!equal(ref,(await iter.next()).value)) return false;
    return true;
  }
  // Logical operations compute the unchanged v2 command fingerprint only during
  // explicit operation reads/exports. Ordinary appends retain the shared command
  // reference, avoiding a full canonical-history scan on every write.
  async logical(table,key) {
    const value = await this.get(table,key);
    if (table === 'operations') value.payload_fingerprint = await this.commandFingerprint(await this.json.at(await this.ref(table,key),['command']));
    return value;
  }
  async commandFingerprint(ref) {
    const hash = new SHA256Stream().update('{"payload":');
    for await (const text of this.tokens(ref)) hash.update(text);
    hash.update(',"purpose":"write-payload","version":1}');
    return `sha256:write-payload:v1:${hash.digest()}`;
  }
  async *tokens(ref,depth=0) {
    check(depth<64,'RESOURCE_LIMIT','JSON stream depth'); const n = await this.pages.get(ref);
    if (n.kind==='json-scalar') { yield canonicalize(n.value); return; }
    if (n.kind==='json-string') {
      yield '"'; for await (const part of this.pages.range(n.root)) yield canonicalize((await this.pages.get(part)).value).slice(1,-1); yield '"'; return;
    }
    check(['json-array','json-object'].includes(n.kind),'NEEDS_RESOLUTION','Invalid JSON wrapper');
    const object=n.kind==='json-object'; yield object?'{':'['; let first=true;
    const items=object?this.pages.mapEntries(n.root):this.pages.range(n.root);
    for await (const item of items) {
      if (!first) yield ','; first=false;
      if(object) yield canonicalize(item[0])+':';
      yield* this.tokens(object?item[1]:item,depth+1);
    }
    yield object?'}':']';
  }
}
