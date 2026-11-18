import * as db from './db.js';
import { actionFor, digest, identity, matchSource } from './model.js';
import { Parser } from './parser.js';
const later = ms => new Promise(resolve => setTimeout(resolve,ms));
export class Engine {
    constructor(host, ui, parser = new Parser()) {
        Object.assign(this,{host,ui,parser,key:host.key,pending:new Map(),recent:new Map(),epoch:0,disposed:false});
    }
    alive() { return !this.disposed && this.host.active(); }
    async init() {
        const [book,progress] = await Promise.all([db.getBook(this.key),db.getProgress(this.key),this.host.sync()]);
        this.book = book;
        this.progress = progress;
        if (!this.alive()) return;
        if (progress.revision !== book.revision || progress.next > this.host.size() || progress.target > this.host.size()) {
            await this.reset(0,false);
        } else if (progress.next > 0 && progress.anchor) {
            const [last] = await this.host.read(progress.next-1,progress.next);
            if (digest(last.mes) !== progress.anchor) {
                const tailOnly=progress.anchorIdentity && progress.anchorIdentity===identity(last);
                await this.reset(tailOnly ? progress.next-1 : 0,false);
                if(tailOnly)this.dirty(progress.next-1,false);
            }
        }
    }
    dispose() {
        this.disposed = true; this.epoch++; this.parser.stop(); clearTimeout(this.timer);
        this.pending.clear(); this.recent.clear();
    }
    open() { this.history = true; this.kick(); }
    dirty(floor,notify) {
        if (!Number.isInteger(floor) || floor<0) return;
        this.pending.set(floor,notify || this.pending.get(floor) || false);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.kick(),100);
    }
    async reset(floor = 0, start = true) {
        const token = ++this.epoch;
        this.parser.stop(); this.recent.clear(); this.host.page = null;
        this.resetting = true;
        try {
            const next = Math.min(this.progress?.next || 0,floor);
            await db.rewind(this.key,floor,this.book.revision,next);
            if (this.epoch !== token || !this.alive()) return;
            this.progress = {next,revision:this.book.revision};
            if (start) this.history = true;
        } finally { if (token === this.epoch) this.resetting = false; }
        this.ui.changed('reset'); this.kick();
    }
    kick() {
        if (!this.book || this.running || this.resetting || !this.alive()) return;
        this.running = true;
        this.loop().catch(e => {
            if (this.alive()) { this.history = false; this.ui.error(e); }
        }).finally(() => {
            this.running = false;
            if (this.alive() && !this.resetting && (this.pending.size || this.history)) this.kick();
        });
    }
    async loop() {
        while (this.alive() && !this.resetting) {
            const epoch = this.epoch, valid = () => this.alive() && epoch === this.epoch && !this.resetting;
            try {
                if (this.pending.size) {
                    const [floor,notify] = this.pending.entries().next().value;
                    this.pending.delete(floor);
                    const total = await this.host.sync();
                    if (!valid() || floor >= total) continue;
                    const [msg] = await this.host.read(floor,floor+1);
                    if (!valid()) continue;
                    const prior = this.recent.get(floor);
                    if (prior && prior.text === msg.mes && prior.swipe === msg.swipe_id) continue;
                    const [scan] = await this.parser.run([msg],this.book);
                    if (!valid() || this.pending.has(floor)) continue;
                    const p = this.progress;
                    let progress;
                    if (!p.back && (floor === p.next || floor === p.next-1))
                        progress = {...p,next:floor+1,revision:this.book.revision,anchor:digest(msg.mes),anchorIdentity:identity(msg)};
                    if (!await db.writeBatch(this.key,[{floor,rows:scan.rows}],progress,valid) || !valid()) continue;
                    if (progress) this.progress = progress;
                    this.recent.set(floor,{text:msg.mes,swipe:msg.swipe_id});
                    if (this.recent.size > 12) this.recent.delete(this.recent.keys().next().value);
                    if (notify && !msg.is_user && actionFor(scan,this.ui.zero())) this.ui.notice(floor,scan);
                    this.ui.changed('live');
                    continue;
                }
                if (!this.history) break;
                const p = this.progress;
                if (p.revisit != null) {
                    const floors = await db.candidateFloors(this.key,p.revisit);
                    if (!valid()) continue;
                    const updates = [];
                    if (floors.length) {
                        const messages=[];
                        for(const floor of floors) messages.push((await this.host.read(floor,floor+1))[0]);
                        if(!valid())continue;
                        const results=await this.parser.run(messages,this.book);
                        floors.forEach((floor,i)=>updates.push({floor,rows:results[i].rows}));
                    }
                    const progress = {...p,revisit:floors.length ? floors.at(-1)+1 : null};
                    if(await db.writeBatch(this.key,updates,progress,valid) && valid())this.progress=progress;
                    await later(18);continue;
                }
                const target = p.target ?? this.host.size(), end = p.back ?? target;
                if (p.next >= end) { this.history = false; this.ui.changed('done'); break; }
                const first = Math.max(p.next,end-16);
                const messages = await this.host.read(first,end);
                if (!valid()) continue;
                const results = await this.parser.run(messages,this.book);
                if (!valid()) continue;
                const anchor = p.targetAnchor ?? digest(messages.at(-1).mes);
                const anchorIdentity=p.targetIdentity ?? identity(messages.at(-1));
                const progress = first === p.next ? {next:target,revision:this.book.revision,anchor,anchorIdentity} :
                    {...p,revision:this.book.revision,target,targetAnchor:anchor,targetIdentity:anchorIdentity,back:first};
                const floors = results.map((r,i) => ({floor:first+i,rows:r.rows}));
                if (await db.writeBatch(this.key,floors,progress,valid) && valid()) {
                    this.progress = progress;
                    this.ui.changed(first === p.next ? 'done' : 'progress');
                }
                await later(18);
            } catch(e) { if (valid()) throw e; }
        }
    }
    async source(row, note = false) {
        let floor = row.floor;
        let msg = floor < this.host.size() ? (await this.host.read(floor,floor+1))[0] : null;
        if (!matchSource(row,msg) || (note && digest(msg.mes)!==row.hash)) {
            if (!note) { this.dirty(floor,false); throw Error('来源楼层已变化，正在更新索引'); }
            // Exact content resolves duplicate timestamps after a deletion; edits may fall back to a unique identity.
            let exact, candidates=0, exactCount=0, found;
            for (let end = this.host.size(); end>0;) {
                const start = Math.max(0,end-64);
                const page = await this.host.read(start,end);
                for (let i=0;i<page.length;i++) if (matchSource(row,page[i])) {
                    found = {msg:page[i],floor:start+i};candidates++;
                    if(digest(page[i].mes)===row.hash){exact=found;exactCount++;}
                }
                end=start; await later(0);
            }
            if (exactCount===1) found=exact;
            else if(candidates>1)throw Error('有多个相同来源，无法确定收藏楼层');
            if (!found) throw Error('收藏的来源已移除，备注和标签仍然保留');
            ({floor,msg} = found);
        }
        if (!note && (digest(msg.mes) !== row.hash || (msg.swipe_id || 0) !== row.swipe)) {
            this.dirty(floor,false); throw Error('原文已变更，正在更新本楼索引，请重新打开');
        }
        return {floor,msg};
    }
}
