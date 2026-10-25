import { check, type Row, type Store } from './model';

export const EVIDENCE_STORES = ['memory_revisions', 'reviews', 'event_revisions', 'event_memberships',
    'event_progress', 'event_processing_receipts', 'custom_table_rows', 'table_receipts', 'table_history'] as const satisfies readonly Store[];
type EvidenceStore = typeof EVIDENCE_STORES[number];
const evidenceStores = new Set<Store>(EVIDENCE_STORES);
export const isEvidenceStore = (store: Store): store is EvidenceStore => evidenceStores.has(store);
// Internal coordination only. Neither this store nor its stamp is archive data.
export const RETENTION_CONTROL_STORE = 'retention_control';
export const RETENTION_STAMP_KEY = 'evidence';
type Request = <T>(request: IDBRequest<T>) => Promise<T>;

export interface RetentionRoots {
    snapshotRoots: ReadonlySet<string>;
    sourceRoots: ReadonlySet<string>;
}
interface RowRoots extends RetentionRoots { story?: string }
interface Counts { snapshotRoots: Map<string, number>; sourceRoots: Map<string, number> }
interface Delta { store: EvidenceStore; sequence: number; before?: RowRoots; after?: RowRoots }
interface Scan { counts: Counts; watermarks: Map<EvidenceStore, number> }
const emptyCounts = (): Counts => ({ snapshotRoots: new Map(), sourceRoots: new Map() });
const copyCounts = (counts: Counts): Counts => ({ snapshotRoots: new Map(counts.snapshotRoots), sourceRoots: new Map(counts.sourceRoots) });

/** Same generic collect semantics as the complete collector, including nested
 * receipts/table values. A row contributes each root once, regardless of aliases. */
export function rowRetentionRoots(row: Row | undefined): RowRoots | undefined {
    if (!row) return undefined;
    const snapshotRoots = new Set<string>(), sourceRoots = new Set<string>();
    const pending: object[] = [row], seen = new Set<object>();
    while (pending.length) {
        const value = pending.pop()!;
        if (seen.has(value)) continue;
        seen.add(value);
        const item = value as { message?: unknown; revision?: unknown; basis?: unknown; snapshot?: unknown };
        if (typeof item.message === 'string' && typeof item.revision === 'string') sourceRoots.add(item.revision);
        if (typeof item.basis === 'string') snapshotRoots.add(item.basis);
        if (typeof item.snapshot === 'string') snapshotRoots.add(item.snapshot);
        for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
    }
    return { story: typeof row.story === 'string' ? row.story : undefined, snapshotRoots, sourceRoots };
}

function change(counts: Counts, roots: RowRoots, amount: 1 | -1): void {
    for (const field of ['snapshotRoots', 'sourceRoots'] as const) for (const id of roots[field]) {
        const next = (counts[field].get(id) ?? 0) + amount;
        check(Number.isSafeInteger(next) && next >= 0, '历史证据根计数不一致');
        if (next) counts[field].set(id, next); else counts[field].delete(id);
    }
}
function apply(counts: Counts, story: string, deltas: readonly Delta[], watermarks?: Map<EvidenceStore, number>): void {
    for (const delta of deltas) {
        if (delta.sequence <= (watermarks?.get(delta.store) ?? 0)) continue;
        if (delta.before?.story === story) change(counts, delta.before, -1);
        if (delta.after?.story === story) change(counts, delta.after, 1);
    }
}

/** Per connection, derived ID counts only. Another connection's evidence stamp
 * invalidates all cached stories, even when no branch epoch was changed. */
export class RetentionRootsCache {
    private stamp: number | undefined;
    private stories = new Map<string, Counts>();

    at(stamp: number): Map<string, Counts> {
        return this.stamp === stamp ? new Map(this.stories) : new Map();
    }

    publish(before: number, after: number, scans: Map<string, Scan>, deltas: readonly Delta[]): void {
        // Never apply a delayed commit to a different cached generation. Cold scans
        // still prove their own snapshot; everything else can be rebuilt on demand.
        const next = this.stamp === before ? this.stories : new Map<string, Counts>();
        for (const [story, scan] of scans) next.set(story, scan.counts);
        for (const [story, counts] of next) apply(counts, story, deltas, scans.get(story)?.watermarks);
        this.stories = next;
        this.stamp = after;
    }
}

/** One native transaction. Native writes are enqueued by db.ts immediately;
 * this ledger waits only to obtain their exact old roots and successful outcome.
 * No count or stamp is published to the connection cache before IDB commits. */
export class RetentionTransaction {
    private sequence = 0;
    private writes: Promise<Delta>[] = [];
    private base?: Promise<{ stamp: number; stories: Map<string, Counts> }>;
    private scans = new Map<string, Promise<Scan>>();
    private prepared = false;
    private publication?: { before: number; after: number; scans: Map<string, Scan>; deltas: Delta[] };

    constructor(private native: IDBTransaction, private cache: RetentionRootsCache, private request: Request) {}

    assertWritable(): void { check(!this.prepared, '证据写事务已经结束'); }

    private start() {
        return this.base ??= this.request<{ id: string; schema: number; stamp: number } | undefined>(
            this.native.objectStore(RETENTION_CONTROL_STORE).get(RETENTION_STAMP_KEY),
        ).then(row => {
            check(row === undefined || row.id === RETENTION_STAMP_KEY && row.schema === 1 &&
                Number.isSafeInteger(row.stamp) && row.stamp >= 0, '历史证据写标记非法');
            const stamp = row?.stamp ?? 0;
            return { stamp, stories: this.cache.at(stamp) };
        });
    }

    record(store: EvidenceStore, before: Promise<RowRoots | undefined> | undefined, after: RowRoots | undefined,
        success: Promise<unknown>): void {
        const sequence = ++this.sequence;
        const delta = Promise.all([before, success]).then(([prior]): Delta => ({ store, sequence, before: prior, after }));
        // Aborted requests may reject after the caller already left fn. They must
        // not leak unhandled rejections or publish a partly successful ledger.
        void delta.catch(() => {});
        this.writes.push(delta);
    }

    private async settled(): Promise<Delta[]> {
        let sequence: number, deltas: Delta[];
        do { sequence = this.sequence; deltas = await Promise.all(this.writes); }
        while (sequence !== this.sequence);
        return deltas;
    }

    private async scan(load: (store: EvidenceStore) => Promise<Row[]>): Promise<Scan> {
        const counts = emptyCounts(), watermarks = new Map<EvidenceStore, number>();
        for (const store of EVIDENCE_STORES) {
            // The getAll request is enqueued synchronously by load. Later writes
            // to this store are not in that read and must be applied as deltas.
            watermarks.set(store, this.sequence);
            const rows = await load(store);
            for (const row of rows) change(counts, rowRetentionRoots(row)!, 1);
        }
        return { counts, watermarks };
    }

    async roots(story: string, refresh: boolean, load: (store: EvidenceStore) => Promise<Row[]>): Promise<RetentionRoots> {
        const base = await this.start();
        let pending = this.scans.get(story);
        if (refresh || !pending && !base.stories.has(story)) {
            pending = this.scan(load); this.scans.set(story, pending);
        }
        const scan = pending ? await pending : undefined;
        const counts = copyCounts(scan?.counts ?? base.stories.get(story)!);
        apply(counts, story, await this.settled(), scan?.watermarks);
        return { snapshotRoots: new Set(counts.snapshotRoots.keys()), sourceRoots: new Set(counts.sourceRoots.keys()) };
    }

    /** Called after fn resolves, while the native transaction is still active. */
    async prepare(): Promise<void> {
        this.prepared = true;
        if (!this.writes.length && !this.base) return;
        const { stamp } = await this.start();
        const scans = new Map(await Promise.all([...this.scans].map(async ([story, scan]) => [story, await scan] as const)));
        const deltas = await this.settled();
        let after = stamp;
        if (deltas.length) {
            check(stamp < Number.MAX_SAFE_INTEGER, '历史证据写标记已达到上限');
            after++;
            await this.request(this.native.objectStore(RETENTION_CONTROL_STORE).put({
                id: RETENTION_STAMP_KEY, schema: 1, stamp: after,
            }));
        }
        this.publication = { before: stamp, after, scans, deltas };
    }

    /** Only Library.transaction's successful oncomplete path calls this. */
    publish(): void {
        const value = this.publication;
        if (value) this.cache.publish(value.before, value.after, value.scans, value.deltas);
    }
}
