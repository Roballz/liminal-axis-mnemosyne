export const context = () => globalThis.SillyTavern?.getContext?.();
const chatApi = () => globalThis.__TAURITAVERN__?.api?.chat;
export function chatKey() {
    const ctx = context();
    if (!ctx) return '';
    let ref;
    try { ref = chatApi()?.current?.ref?.(); } catch { /* welcome screen */ }
    if (ref?.kind === 'group') return JSON.stringify(['group',ref.chatId]);
    if (ref?.kind === 'character') return JSON.stringify(['character',ref.characterId,ref.fileName]);
    const id = ctx.getCurrentChatId?.() ?? ctx.chatId;
    if (!id) return '';
    return JSON.stringify(ctx.groupId != null ? ['group',ctx.groupId,id] :
        ['character',ctx.characters?.[ctx.characterId]?.avatar ?? ctx.characterId,id]);
}
export class Host {
    constructor(key) {
        this.key = key;
        this.handle = chatApi()?.current?.handle?.();
        this.offset = 0;
    }
    active() { return this.key === chatKey(); }
    async sync() {
        const info = await chatApi()?.current?.windowInfo?.();
        if (!this.active()) throw Error('聊天已切换');
        this.offset = info?.windowStartIndex || 0;
        this.total = info?.totalCount ?? context()?.chat?.length ?? 0;
        const chat=context()?.chat || [];
        const messages=new Map();
        for(let i=Math.max(0,chat.length-6);i<chat.length;i++)messages.set(this.offset+i,chat[i]);
        this.tail={total:this.total,messages};
        return this.total;
    }
    size() { return Math.max(this.total || 0, this.offset + (context()?.chat?.length || 0)); }
    async read(first, end) {
        if (!this.active()) throw Error('聊天已切换');
        const chat = context().chat;
        if (first >= this.offset && end <= this.offset + chat.length) {
            const chunk = chat.slice(first-this.offset,end-this.offset);
            if (Array.from(chunk).every(m => m && typeof m.mes === 'string')) return chunk;
        }
        const history = this.handle?.history;
        if (!history) throw Error('当前宿主没有提供这段历史，请加载旧楼层后重试');
        const result = [];
        let page = this.page;
        if (!page || page.startIndex + page.messages.length < end) page = await history.tail({limit:64});
        while (true) {
            if (!this.active()) throw Error('聊天已切换');
            const a = Math.max(first,page.startIndex), b = Math.min(end,page.startIndex+page.messages.length);
            if (b>a) result.unshift(...page.messages.slice(a-page.startIndex,b-page.startIndex));
            if (page.startIndex <= first || !page.hasMoreBefore) break;
            const previous = await history.before(page,{limit:64});
            if (previous.startIndex >= page.startIndex) throw Error('历史分页未前进');
            page = previous;
        }
        this.page = page;
        if (result.length !== end-first) throw Error('历史楼层未完整返回');
        return result;
    }
}
export function centeredFloor() {
    const chat = document.querySelector('#chat');
    if (!chat) return null;
    const rect = chat.getBoundingClientRect();
    const x = Math.min(innerWidth-1,Math.max(0,rect.left+rect.width/2));
    const top = Math.max(0,rect.top), bottom = Math.min(innerHeight,rect.bottom);
    const y = (top+bottom)/2;
    const at = document.elementsFromPoint(x,y).map(e => e.closest('#chat .mes[mesid]')).find(Boolean);
    if (at) return Number(at.getAttribute('mesid'));
    let nearest = null, distance = Infinity;
    for (const node of chat.querySelectorAll('.mes[mesid]')) {
        const r = node.getBoundingClientRect();
        if (!r.height || r.bottom <= top || r.top >= bottom) continue;
        const d = Math.max(r.top-y,y-r.bottom,0);
        if (d < distance) { nearest = Number(node.getAttribute('mesid')); distance = d; }
    }
    return nearest;
}
