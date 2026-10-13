import { fingerprint } from './model';

/** Host-side, body-free receipt. Host saves persist this along with the message;
 * a Mnemosyne library export does not back up the host's chat metadata. */
export const REPLY_FINALITY_KEY = 'mnemosyne_reply_finality_v1';
type State = 'pending' | 'aborted' | 'uncertain' | 'complete' | 'edited';
export interface ReplyMessage {
    mes: string;
    is_user: boolean;
    is_system?: boolean;
    swipe_id?: number;
    swipes?: string[];
    swipe_info?: { extra?: Record<string, unknown> }[];
    extra?: Record<string, unknown>;
}
export interface ReplyHost {
    scope: string;
    errorLabel?: string;
    chat: ReplyMessage[];
    processor?: { messageId?: number; isFinished?: boolean; isStopped?: boolean; abortController?: { signal?: { aborted?: boolean } } } | null;
}
interface Receipt { version: 1; epoch: number; scope: string; floor: number; swipe: number; hash: string; state: State }
interface Run {
    epoch: number; scope: string; chat: ReplyMessage[]; floor: number; page?: number;
    before?: { message: ReplyMessage; text: string; swipe: number };
    stopped: boolean; ended: boolean; received?: { message: ReplyMessage; text: string; swipe: number };
    processor?: ReplyHost['processor'];
}
const assistant = (m: ReplyMessage) => !m.is_user && !m.extra?.bbs_internal_notice &&
    !(m.is_system && m.extra?.type && !m.extra?.bbs_hidden);
const swipe = (m: ReplyMessage) => m.swipe_id ?? 0;
/** Heuristic, never proof: prose with a line beginning with this TT marker
 * is quarantined too, and errors without a marker cannot be identified here. */
export const hasTTErrorMarker = (text: string, localizedLabel = '[API Error]') =>
    text.split(/\r?\n/).some(line => ['[API Error]', localizedLabel].some(label => line.trimStart().startsWith(label) &&
        /^(?:\s|:|$)/.test(line.trimStart().slice(label.length))));
const reason = '当前回复尚未确认完成、已停止或疑似 API 错误，暂不归档；可编辑并保存确认要保留的正文';

export class ReplyFinalityError extends Error {
    constructor() { super(reason); this.name = 'ReplyFinalityError'; }
}

export class ReplyFinality {
    revision = 0;
    private epoch = Date.now();
    private run?: Run;
    private edit?: { scope: string; chat: ReplyMessage[]; floor: number; message: ReplyMessage; swipe: number; expires: number; expectedText: string; text?: string };
    private writes = new Set<Promise<void>>();
    constructor(private host: () => ReplyHost) {}
    reset() { this.run = undefined; this.edit = undefined; this.revision++; }
    start(type?: string, _options?: unknown, dryRun?: boolean) {
        if (dryRun || type === 'quiet' || type === 'impersonate') return;
        const h = this.host(), tail = h.chat.at(-1);
        this.edit = undefined;
        const rewrites = ['swipe', 'regenerate', 'continue'].includes(type ?? '') && tail && assistant(tail);
        const floor = rewrites ? h.chat.length - 1 : h.chat.length;
        const m = h.chat[floor];
        this.run = { epoch: ++this.epoch, scope: h.scope, chat: h.chat, floor,
            ...(m ? { before: { message: m, text: m.mes, swipe: swipe(m) } } : {}),
            stopped: false, ended: false };
        this.revision++;
    }
    private current(run = this.run) {
        const h = this.host();
        return run && run === this.run && run.scope === h.scope && run.chat === h.chat ? run : undefined;
    }
    private candidate(run: Run) {
        if (!run.before) while (run.chat[run.floor]?.is_user) run.floor++;
        const m = run.chat[run.floor], old = run.before;
        if (!m || !assistant(m) || (old && old.message === m && old.text === m.mes && old.swipe === swipe(m) && !this.uncreatedSwipe(m))) return;
        if (run.page !== undefined && run.page !== swipe(m)) return;
        run.page ??= swipe(m);
        return m;
    }
    private uncreatedSwipe(m: ReplyMessage) {
        return Array.isArray(m.swipes) && swipe(m) >= m.swipes.length;
    }
    private async stamp(m: ReplyMessage, floor: number, state: State, run?: Run, quiet = false) {
        const h = this.host(), text = m.mes, page = swipe(m), epoch = run?.epoch ?? (quiet ? (m.extra?.[REPLY_FINALITY_KEY] as Receipt)?.epoch : undefined) ?? ++this.epoch;
        const receipt: Receipt = { version: 1, epoch, scope: h.scope, floor, swipe: page, hash: '', state };
        m.extra ??= {};
        m.extra[REPLY_FINALITY_KEY] = receipt;
        // TT restores extra from swipe_info when selecting a page. Mirror only our receipt.
        const info = m.swipe_info?.[page];
        if (info) { info.extra ??= {}; info.extra[REPLY_FINALITY_KEY] = receipt; }
        if (!quiet) this.revision++;
        const hash = await fingerprint(text), now = this.host();
        if (h.scope !== now.scope || h.chat !== now.chat || now.chat[floor] !== m || m.mes !== text || swipe(m) !== page ||
            m.extra[REPLY_FINALITY_KEY] !== receipt || (run && !this.current(run))) return;
        receipt.hash = hash;
        if (!quiet) this.revision++;
    }
    async observe() {
        let run = this.current();
        if (!run) {
            const h = this.host(), p = h.processor, floor = p?.messageId;
            if (!p || p.isFinished || p.isStopped || p.abortController?.signal?.aborted || typeof floor !== 'number' || !h.chat[floor]) return;
            // Attached during a live stream: infer only a pending run, never success.
            run = this.run = { epoch: ++this.epoch, scope: h.scope, chat: h.chat, floor,
                stopped: false, ended: false, processor: p };
        }
        const m = this.candidate(run);
        if (!m) return;
        const p = this.host().processor;
        if (p) run.processor ??= p;
        if (p?.abortController?.signal?.aborted || p?.isStopped) run.stopped = true;
        const receipt = m.extra?.[REPLY_FINALITY_KEY] as Receipt | undefined;
        if (!receipt || receipt.epoch !== run.epoch || (run.stopped && receipt.state !== 'aborted'))
            await this.stamp(m, run.floor, run.stopped ? 'aborted' : 'pending', run);
    }
    streaming() {
        const run = this.current(), h = this.host(), p = h.processor;
        if (!run) return this.observe();
        this.candidate(run); // Resolve a newly appended user floor before the assistant.
        if (!p || p.messageId !== run.floor || p.isFinished || p.isStopped || p.abortController?.signal?.aborted) return;
        const m = h.chat[run.floor];
        if (!m || (run.page !== undefined && run.page !== swipe(m))) return;
        // STREAM_TOKEN_RECEIVED precedes onProgressStreaming. First token revokes
        // the prior body before TT writes any fragment, including continue/swipe.
        run.before = undefined;
        const receipt = m.extra?.[REPLY_FINALITY_KEY] as Receipt | undefined;
        if (receipt?.epoch === run.epoch && receipt.state === 'pending') return;
        return this.observe();
    }
    async received(floor?: number) {
        const run = this.current();
        if (!run) return;
        const m = this.candidate(run);
        if (!m || floor !== run.floor) return;
        const p = this.host().processor;
        if ((run.processor && p !== run.processor) || (p?.messageId !== undefined && p.messageId !== floor)) return;
        run.processor ??= p;
        run.received = { message: m, text: m.mes, swipe: swipe(m) };
        if (p?.abortController?.signal?.aborted || p?.isStopped) run.stopped = true;
        const state: State = run.stopped ? 'aborted' : hasTTErrorMarker(m.mes, this.host().errorLabel) ? 'uncertain' :
            (p ? p.isFinished !== true : !run.ended) ? 'pending' : 'complete';
        await this.stamp(m, run.floor, state, run);
    }
    async stop() {
        const run = this.current();
        if (!run) return;
        run.stopped = true;
        this.revision++;
        await this.observe();
    }
    async end() {
        const run = this.current();
        if (!run) return;
        run.ended = true;
        // UI teardown alone is not a completion receipt. Non-stream mode also
        // requires a matching received body, observed in this exact run.
        await this.observe();
        const received = run.received, m = this.candidate(run);
        if (this.current(run) && !this.host().processor && received && m === received.message &&
            m.mes === received.text && swipe(m) === received.swipe) await this.received(run.floor);
    }
    confirmEdit(floor: number, expectedText: string) {
        const h = this.host(), m = h.chat[floor];
        this.edit = m && assistant(m) ? { scope: h.scope, chat: h.chat, floor, message: m, swipe: swipe(m), expires: Date.now() + 15_000, expectedText } : undefined;
    }
    cancelEdit() { this.edit = undefined; }
    editStarted(floor?: number) {
        const h = this.host(), intent = this.edit, m = typeof floor === 'number' ? h.chat[floor] : undefined;
        if (!m || !intent || Date.now() > intent.expires || intent.scope !== h.scope || intent.chat !== h.chat ||
            intent.floor !== floor || intent.message !== m || intent.swipe !== swipe(m) || intent.expectedText !== m.mes) { this.edit = undefined; return; }
        intent.text = m.mes;
    }
    async edited(floor?: number) {
        const h = this.host(), m = typeof floor === 'number' ? h.chat[floor] : undefined;
        const intent = this.edit;
        this.edit = undefined;
        if (!m || !intent || Date.now() > intent.expires || intent.scope !== h.scope || intent.chat !== h.chat || intent.floor !== floor || intent.message !== m || intent.swipe !== swipe(m) || intent.text !== m.mes) return;
        const run = this.current();
        if (run && !run.ended && !run.stopped && this.candidate(run)) return;
        await this.stamp(m, floor!, 'edited');
        if (run && this.current(run) && run.floor === floor) this.run = undefined;
    }
    /** Only verified plugin-owned summary sidecar hooks may call this. */
    reconcileDerived(floor: number, originalText: string) {
        const h = this.host(), m = h.chat[floor], receipt = m?.extra?.[REPLY_FINALITY_KEY] as Receipt | undefined;
        if (!receipt || !['complete', 'edited'].includes(receipt.state)) return;
        const text = m.mes, page = swipe(m), run = this.run, revision = this.revision;
        const write = (async () => {
            if (receipt.hash !== await fingerprint(originalText)) return;
            const now = this.host();
            if (now.scope !== h.scope || now.chat !== h.chat || now.chat[floor] !== m || m.mes !== text ||
                swipe(m) !== page || m.extra?.[REPLY_FINALITY_KEY] !== receipt || this.run !== run || this.revision !== revision) return;
            await this.stamp(m, floor, receipt.state, undefined, true);
        })();
        this.writes.add(write);
        void write.then(() => this.writes.delete(write), () => this.writes.delete(write));
    }
    async assertArchivable(observe = true) {
        await Promise.all([...this.writes]);
        if (observe) await this.observe();
        const h = this.host(), run = this.current(), revision = this.revision;
        const processor = h.processor;
        const processorState = (p: ReplyHost['processor']) => JSON.stringify([p?.messageId, p?.isFinished, p?.isStopped, p?.abortController?.signal?.aborted]);
        const observedProcessor = processorState(processor);
        const snapshot = h.chat.map(m => ({ message: m, text: m.mes, swipe: swipe(m),
            receipt: JSON.stringify(m.extra?.[REPLY_FINALITY_KEY]), role: assistant(m), uncreated: this.uncreatedSwipe(m) }));
        const current = () => {
            const now = this.host();
            return now.scope === h.scope && now.chat === h.chat && now.errorLabel === h.errorLabel && now.processor === processor &&
                processorState(now.processor) === observedProcessor && this.revision === revision && now.chat.length === snapshot.length &&
                snapshot.every((s, i) => now.chat[i] === s.message && s.text === s.message.mes && s.swipe === swipe(s.message) &&
                    s.role === assistant(s.message) && s.uncreated === this.uncreatedSwipe(s.message) && s.receipt === JSON.stringify(s.message.extra?.[REPLY_FINALITY_KEY]));
        };
        for (let floor = 0; floor < h.chat.length; floor++) {
            const m = h.chat[floor];
            if (!assistant(m)) continue;
            if (this.uncreatedSwipe(m)) throw new ReplyFinalityError();
            const receipt = m.extra?.[REPLY_FINALITY_KEY] as Receipt | undefined;
            const candidate = run && run.floor === floor && this.candidate(run) === m;
            const p = h.processor;
            if (p?.messageId === floor && p.isFinished !== true && !p.isStopped && !p.abortController?.signal?.aborted &&
                (!run || candidate)) throw new ReplyFinalityError();
            if (!receipt) {
                if (candidate || hasTTErrorMarker(m.mes, h.errorLabel)) throw new ReplyFinalityError();
                continue; // Historical unmarked ordinary chat remains supported.
            }
            const text = m.mes, page = swipe(m), revision = this.revision;
            const hash = await fingerprint(text);
            const now = this.host();
            if (now.scope !== h.scope || now.chat !== h.chat || now.chat[floor] !== m ||
                text !== m.mes || page !== swipe(m) || revision !== this.revision) throw new ReplyFinalityError();
            // Durable receipts travel with an explicit branch copy or floor move. Scope/floor
            // describe origin; live event correlation above must still match the current run.
            const matches = receipt.version === 1 && receipt.swipe === swipe(m) && receipt.hash === hash;
            // Changed or unknown receipts are not historical evidence of finality.
            if (!matches || !['complete', 'edited'].includes(receipt.state) ||
                (candidate && run.stopped && receipt.state !== 'edited')) throw new ReplyFinalityError();
            if (hasTTErrorMarker(m.mes, h.errorLabel) && receipt.state !== 'edited') throw new ReplyFinalityError();
        }
        if (!current()) throw new ReplyFinalityError();
        return current;
    }
}
