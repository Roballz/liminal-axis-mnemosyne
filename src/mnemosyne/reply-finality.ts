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
    epoch: number; scope: string; chat: ReplyMessage[]; floor: number; page?: number; type?: string;
    before?: { message: ReplyMessage; text: string; swipe: number };
    stopped: boolean; ended: boolean; received?: { message: ReplyMessage; text: string; swipe: number };
    processor?: ReplyHost['processor'];
    initialProcessor?: ReplyHost['processor'];
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

export type ReplyBlockerReason = 'streaming' | 'uncreated' | 'pending' | 'aborted' | 'api_error' | 'changed' | 'unknown';
export const replyBlockerText: Record<ReplyBlockerReason, string> = {
    streaming: '仍在生成，等待结束后再核对', uncreated: '当前 swipe 尚未形成正文',
    pending: '未取得完成确认', aborted: '曾停止或中断，尚未人工确认',
    api_error: '疑似 API 错误，需核对正文', changed: '正文或 swipe 已变化，原确认不再匹配',
    unknown: '确认记录无法识别，需重新核对',
};
/** Temporary, body-free UI evidence. It never grants archival or edit authority. */
export interface ReplyBlocker { floor: number; swipe: number; reason: ReplyBlockerReason; current: () => boolean }
export interface ReplyBlockerCursor { offset: number; candidateFloor: number; current: () => boolean }
export interface ReplyBlockerPage {
    items: ReplyBlocker[]; examined: number; total: number; next?: ReplyBlockerCursor; current: () => boolean;
}
export class ReplyFinalityError extends Error {
    constructor(readonly blocker?: ReplyBlocker) {
        super(blocker ? `楼层 #${blocker.floor}（swipe ${blocker.swipe + 1}）：${replyBlockerText[blocker.reason]}。${reason}` : reason);
        this.name = 'ReplyFinalityError';
    }
}

export class ReplyFinality {
    revision = 0;
    private epoch = Date.now();
    private run?: Run;
    private edit?: { scope: string; chat: ReplyMessage[]; floor: number; message: ReplyMessage; swipe: number; expires: number; expectedText: string; text?: string };
    private writes = new Set<Promise<void>>();
    private editSerial = 0;
    constructor(private host: () => ReplyHost) {}
    reset() { this.run = undefined; this.cancelEdit(); this.revision++; }
    start(type?: string, _options?: unknown, dryRun?: boolean) {
        if (dryRun || type === 'quiet' || type === 'impersonate') return;
        const h = this.host(), tail = h.chat.at(-1);
        this.cancelEdit();
        const rewrites = ['swipe', 'regenerate', 'continue'].includes(type ?? '') && tail && assistant(tail);
        const floor = rewrites ? h.chat.length - 1 : h.chat.length;
        const m = h.chat[floor];
        this.run = { epoch: ++this.epoch, scope: h.scope, chat: h.chat, floor, type,
            ...(m ? { before: { message: m, text: m.mes, swipe: swipe(m) } } : {}),
            stopped: false, ended: false, initialProcessor: h.processor };
        this.revision++;
    }
    private current(run = this.run) {
        const h = this.host();
        return run && run === this.run && run.scope === h.scope && run.chat === h.chat ? run : undefined;
    }
    private matchesProcessor(run: Run, p: ReplyHost['processor']) {
        return !!p && p !== run.initialProcessor && p.messageId === run.floor &&
            (!run.processor || p === run.processor);
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
    private async stamp(m: ReplyMessage, floor: number, state: State, run?: Run, quiet = false, current = () => true) {
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
            m.extra[REPLY_FINALITY_KEY] !== receipt || (run && !this.current(run)) || !current()) return false;
        receipt.hash = hash;
        if (!quiet) this.revision++;
        return true;
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
        if (this.matchesProcessor(run, p)) {
            run.processor ??= p;
            if (p?.abortController?.signal?.aborted || p?.isStopped) run.stopped = true;
        }
        const receipt = m.extra?.[REPLY_FINALITY_KEY] as Receipt | undefined;
        if (!receipt || receipt.epoch !== run.epoch || (run.stopped && receipt.state !== 'aborted'))
            await this.stamp(m, run.floor, run.stopped ? 'aborted' : 'pending', run);
    }
    /** Render-only notifications for this active candidate do not change archive permissions. */
    isStreamingFloor(floor: unknown) {
        const run = this.current(), p = this.host().processor;
        return !!run && typeof floor === 'number' && run.floor === floor && this.matchesProcessor(run, p) &&
            p?.isFinished !== true && !p?.isStopped && !p?.abortController?.signal?.aborted;
    }
    streaming() {
        const run = this.current(), h = this.host(), p = h.processor;
        if (!run) return this.observe();
        this.candidate(run); // Resolve a newly appended user floor before the assistant.
        if (!this.matchesProcessor(run, p) || p?.isFinished || p?.isStopped || p?.abortController?.signal?.aborted) return;
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
        if ((run.processor && p !== run.processor) || (p && !this.matchesProcessor(run, p))) return;
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
        this.editSerial++;
        const h = this.host(), m = h.chat[floor];
        this.edit = m && assistant(m) ? { scope: h.scope, chat: h.chat, floor, message: m, swipe: swipe(m), expires: Date.now() + 15_000, expectedText } : undefined;
    }
    cancelEdit() { this.edit = undefined; this.editSerial++; }
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
        const run = this.current(), serial = this.editSerial;
        const terminal = (p: ReplyHost['processor']) => !!p &&
            (p.isFinished === true || p.isStopped === true || p.abortController?.signal?.aborted === true);
        // UI END can arrive before a stream actually finishes. Native save never
        // accepts a live processor, even when the old run says ended/stopped.
        if ((h.processor && !terminal(h.processor)) || (run?.processor && !terminal(run.processor))) return;
        const received = run?.received, processor = run?.processor;
        const completedRun = !!run && !!received && !!processor && processor !== run.initialProcessor &&
            processor.messageId === run.floor && terminal(processor) &&
            (!h.processor || h.processor === processor) && received.message === run.chat[run.floor] &&
            received.swipe === swipe(run.chat[run.floor]);
        // A terminal processor tied to this received body is sufficient for an
        // explicit save; processor=null and a missing END event alone are not.
        if (run && !run.ended && !run.stopped && this.candidate(run) && !completedRun) return;
        const current = () => this.editSerial === serial && this.run === run &&
            this.host().processor === h.processor && !(h.processor && !terminal(h.processor)) &&
            !(processor && !terminal(processor));
        if (!await this.stamp(m, floor!, 'edited', undefined, false, current)) return;
        if (run && this.current(run) && run.floor === floor) this.run = undefined;
        return true;
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
    private targetCurrent(h: ReplyHost, floor: number, scoped = false) {
        const m = h.chat[floor], text = m.mes, page = swipe(m), role = assistant(m), uncreated = this.uncreatedSwipe(m);
        const receipt = JSON.stringify(m.extra?.[REPLY_FINALITY_KEY]), revision = this.revision;
        return () => {
            const now = this.host();
            return now.scope === h.scope && now.chat === h.chat && now.chat[floor] === m && (scoped || this.revision === revision) &&
                m.mes === text && swipe(m) === page && assistant(m) === role && this.uncreatedSwipe(m) === uncreated &&
                JSON.stringify(m.extra?.[REPLY_FINALITY_KEY]) === receipt;
        };
    }
    private diagnosticContext(h: ReplyHost) {
        const run = this.current(), revision = this.revision, total = h.chat.length, processor = h.processor;
        const state = () => JSON.stringify([processor?.messageId, processor?.isFinished, processor?.isStopped,
            processor?.abortController?.signal?.aborted, run?.floor, run?.page, run?.ended, run?.stopped]);
        const observed = state();
        return () => {
            const now = this.host();
            return now.scope === h.scope && now.chat === h.chat && now.chat.length === total && now.errorLabel === h.errorLabel &&
                now.processor === processor && this.current() === run && this.revision === revision && state() === observed;
        };
    }
    private blocker(h: ReplyHost, floor: number, reason: ReplyBlockerReason): ReplyBlocker {
        const context = this.diagnosticContext(h), target = this.targetCurrent(h, floor);
        return { floor, swipe: swipe(h.chat[floor]), reason, current: () => context() && target() };
    }
    /** Same classification for the gate and diagnostic pages; no mutation or receipt creation. */
    private blockerReason(h: ReplyHost, m: ReplyMessage, floor: number, run: Run | undefined, candidate: boolean): ReplyBlockerReason | undefined | Promise<ReplyBlockerReason | undefined> {
        if (this.uncreatedSwipe(m)) return 'uncreated';
        const p = h.processor, receipt = m.extra?.[REPLY_FINALITY_KEY] as Receipt | undefined;
        if (p?.messageId === floor && p.isFinished !== true && !p.isStopped && !p.abortController?.signal?.aborted &&
            (!run || candidate)) return 'streaming';
        if (!receipt) return candidate ? 'pending' : hasTTErrorMarker(m.mes, h.errorLabel) ? 'api_error' : undefined;
        return fingerprint(m.mes).then(hash => {
            if (receipt.version !== 1) return 'unknown';
            if (receipt.swipe !== swipe(m) || receipt.hash !== hash) return 'changed';
            if (receipt.state === 'aborted' || (candidate && run?.stopped && receipt.state !== 'edited')) return 'aborted';
            if (receipt.state === 'pending') return 'pending';
            if (receipt.state === 'uncertain') return 'api_error';
            if (!['complete', 'edited'].includes(receipt.state)) return 'unknown';
            if (hasTTErrorMarker(m.mes, h.errorLabel) && receipt.state !== 'edited') return 'api_error';
        });
    }
    /** Explicit diagnostic pages only: at most 100 new floors / 10 findings per call.
     * Page-local exact guards; continuation uses the host lifecycle token, never a retained prefix scan. */
    async inspectBlockers(cursor?: ReplyBlockerCursor): Promise<ReplyBlockerPage> {
        const h = this.host(), run = this.current(), total = h.chat.length;
        const contextCurrent = this.diagnosticContext(h), checks: (() => boolean)[] = [];
        const current = () => contextCurrent() && checks.every(check => check());
        let floor = cursor?.offset ?? 0;
        if (!Number.isSafeInteger(floor) || floor < 0 || floor > total || (cursor && !cursor.current()) || !current()) throw new Error('聊天或正文已变化，请重新检查');
        // Resolve a pending candidate locally; candidate() would mutate run.floor/page.
        let runFloor = cursor?.candidateFloor ?? run?.floor ?? -1;
        const items: ReplyBlocker[] = [], start = floor;
        for (; floor < total && floor - start < 100 && items.length < 10; floor++) {
            const m = h.chat[floor], check = this.targetCurrent(h, floor); checks.push(check);
            if (run && !run.before && floor === runFloor && m.is_user) runFloor++;
            if (!assistant(m)) continue;
            const before = run?.before;
            const candidate = !!run && runFloor === floor && (run.page === undefined || run.page === swipe(m)) &&
                !(before && before.message === m && before.text === m.mes && before.swipe === swipe(m) && !this.uncreatedSwipe(m));
            const result = this.blockerReason(h, m, floor, run, candidate);
            const problem = result instanceof Promise ? await result : result;
            if (!contextCurrent() || !check()) throw new Error('聊天或正文已变化，请重新检查');
            if (problem) items.push(this.blocker(h, floor, problem));
        }
        if (!current()) throw new Error('聊天或正文已变化，请重新检查');
        return { items, examined: floor, total, ...(floor < total ? { next: { offset: floor, candidateFloor: runFloor, current: contextCurrent } } : {}), current };
    }
    /** Read-only prompt use only. The uncreated last swipe is never archive evidence. */
    async assertPromptPrefix(type: string | undefined) {
        const run = this.current(), h = this.host(), cutoff = h.chat.length - 1;
        const eligible = () => {
            const now = this.host(), m = now.chat[cutoff], p = now.processor;
            return type === 'swipe' && !!run && this.current(run) === run && run.type === 'swipe' &&
                !run.ended && !run.stopped && run.floor === cutoff && cutoff > 0 && now.chat.length === cutoff + 1 &&
                !!run.before && run.before.message === m && run.before.text === m.mes &&
                run.before.swipe === swipe(m) && this.uncreatedSwipe(m) &&
                !(p?.messageId === cutoff && !p.isFinished && !p.isStopped && !p.abortController?.signal?.aborted);
        };
        if (!eligible()) return null;
        const unchanged = await this.assertRange(false, cutoff);
        const current = () => eligible() && unchanged();
        if (!current()) throw new ReplyFinalityError();
        return { cutoff, current };
    }
    async assertArchivable(observe = true) {
        return this.assertRange(observe);
    }
    /** Validate completed source floors without coupling them to a later streaming reply. */
    async assertSummaryPrefix(cutoff: number) {
        return this.assertRange(false, cutoff, true);
    }
    private async assertRange(observe: boolean, cutoff?: number, scoped = false) {
        await Promise.all([...this.writes]);
        if (observe) await this.observe();
        const h = this.host(), run = this.current(), revision = this.revision;
        const processor = h.processor;
        const processorState = (p: ReplyHost['processor']) => JSON.stringify([p?.messageId, p?.isFinished, p?.isStopped, p?.abortController?.signal?.aborted]);
        const observedProcessor = processorState(processor);
        const relevantRun = () => {
            const r = this.current();
            return r && r.floor < (cutoff ?? h.chat.length) ? [r.epoch, r.floor, r.page, r.ended, r.stopped] : null;
        };
        const runState = JSON.stringify(relevantRun());
        const relevantProcessor = () => {
            const p = this.host().processor;
            return p && typeof p.messageId === 'number' && p.messageId < (cutoff ?? h.chat.length) ? processorState(p) : null;
        };
        const prefixProcessor = relevantProcessor();
        const snapshot = (scoped ? h.chat.slice(0, cutoff) : h.chat).map(m => ({ message: m, text: m.mes, swipe: swipe(m),
            receipt: JSON.stringify(m.extra?.[REPLY_FINALITY_KEY]), role: assistant(m), uncreated: this.uncreatedSwipe(m) }));
        const current = () => {
            const now = this.host();
            return now.scope === h.scope && now.chat === h.chat && now.errorLabel === h.errorLabel &&
                (scoped ? now.chat.length >= snapshot.length && JSON.stringify(relevantRun()) === runState && relevantProcessor() === prefixProcessor :
                    now.processor === processor && processorState(now.processor) === observedProcessor && this.revision === revision && now.chat.length === snapshot.length) &&
                snapshot.every((s, i) => now.chat[i] === s.message && s.text === s.message.mes && s.swipe === swipe(s.message) &&
                    s.role === assistant(s.message) && s.uncreated === this.uncreatedSwipe(s.message) && s.receipt === JSON.stringify(s.message.extra?.[REPLY_FINALITY_KEY]));
        };
        for (let floor = 0; floor < (cutoff ?? h.chat.length); floor++) {
            const m = h.chat[floor];
            if (!assistant(m)) continue;
            const target = this.targetCurrent(h, floor, scoped), candidate = !!run && run.floor === floor && this.candidate(run) === m;
            const result = this.blockerReason(h, m, floor, run, candidate);
            const problem = result instanceof Promise ? await result : result;
            if (!target()) throw new ReplyFinalityError();
            if (problem) throw new ReplyFinalityError(this.blocker(h, floor, problem));
        }
        if (!current()) throw new ReplyFinalityError();
        return current;
    }
}
