import { Library, freshLibraryName, libraryWriteStamp } from './db';
import { STORES, check, type Store, type Row, type MemoryView } from './model';
import { SHARED_META, sharedStore } from './shared-payloads';
import { publishMemoryView } from './memory-selections';
import { exportLibrary } from './migration';

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const PAGE = 32;
export interface ReorganizationResult {
    library: string; sourceStamp: number; beforeBytes: number; afterBytes: number; records: number;
}
export interface ReorganizationProgress { phase: 'copy' | 'views' | 'verify' | 'validate'; store: string; records: number }

async function page(lib: Library, store: Store, after?: IDBValidKey): Promise<Row[]> {
    return lib.transaction([store], 'readonly', tx => new Promise((resolve, reject) => {
        const rows: Row[] = [];
        const request = tx.native.objectStore(store).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || rows.length === PAGE) { resolve(rows); return; }
            rows.push(cursor.value); cursor.continue();
        };
    }));
}
async function logical(lib: Library, store: Store, physical: Row[], forceRead = false): Promise<Row[]> {
    if (!forceRead && !sharedStore(store) && store !== 'memory_views') return physical;
    return lib.transaction([store], 'readonly', async tx => {
        const result: Row[] = [];
        for (const row of physical) { const value = await tx.get(store, row.id); check(value, '整理来源记录缺失'); result.push(value); }
        return result;
    });
}

/** Explicit Worker job. Never writes to source, copies history IDs verbatim and
 * compares every logical row/view after persistence. No chronological inference
 * from view IDs: a predecessor is only a compression hint, never a history edge. */
export async function reorganizeCoreLibrary(source: Library, guard: () => Promise<boolean>,
    progress: (value: ReorganizationProgress) => void = () => {}): Promise<ReorganizationResult> {
    const sourceStamp = await libraryWriteStamp(source), target = await Library.open(freshLibraryName());
    let records = 0, beforeBytes = 0, afterBytes = 0;
    const current = async () => {
        check(await guard() && await libraryWriteStamp(source) === sourceStamp,
            '整理期间资料或页面已改变，新库未启用，请重试；原库保留');
    };
    const eachPage = async (store: Store, action: (rows: Row[]) => Promise<void>) => {
        let after: IDBValidKey | undefined;
        while (true) {
            await current();
            const rows = await page(source, store, after);
            if (!rows.length) break;
            await action(rows); after = rows.at(-1)!.id;
            await pause();
        }
    };
    try {
        target.compactWrites = true;
        for (const store of STORES) {
            if (store === 'memory_payloads' || store === 'memory_selection_nodes' || store === 'memory_views') continue;
            await eachPage(store, async rows => {
                const values = await logical(source, store, rows);
                await target.transaction([store], 'readwrite', async tx => {
                    for (const row of values) await tx.add(store, row);
                });
                records += rows.length; progress({ phase: 'copy', store, records });
            });
        }
        await target.transaction(['library_meta'], 'readwrite', tx => tx.put('library_meta',
            { id: SHARED_META, schema: 1, value: { version: 1 } } as Row));
        // At most one view retained across transactions, even with many branches.
        let previous: MemoryView | undefined;
        await eachPage('memory_views', async rows => {
            for (const row of rows) {
                const view = await source.get<MemoryView>('memory_views', row.id); check(view, '历史视图缺失');
                await target.transaction(['memory_views'], 'readwrite', tx => publishMemoryView(tx, view,
                    previous?.branch === view.branch ? previous : undefined, true));
                previous = view; records++;
            }
            progress({ phase: 'views', store: 'memory_views', records });
        });
        // Validate exact persisted projections, all history included. Original
        // selection nodes/payloads are physical encodings, replaced by new encodings.
        for (const store of STORES) {
            if (store === 'memory_payloads' || store === 'memory_selection_nodes') continue;
            let count = 0;
            await eachPage(store, async rows => {
                const expected = await logical(source, store, rows);
                const actual = await logical(target, store, rows, true);
                for (let i = 0; i < rows.length; i++) check(JSON.stringify(actual[i]) === JSON.stringify(expected[i]),
                    `整理后记录不一致 ${store}`);
                count += rows.length;
                progress({ phase: 'verify', store, records: count });
            });
            const targetCount = await target.transaction([store], 'readonly', tx => new Promise<number>((resolve, reject) => {
                const r = tx.native.objectStore(store).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            }));
            const extra = store === 'library_meta' && !await source.get('library_meta', SHARED_META) ? 1 : 0;
            check(targetCount === count + extra, `整理后记录数量不一致 ${store}`);
        }
        progress({ phase: 'validate', store: '', records });
        // Domain validation runs sequentially; do not keep two full archives alive.
        async function validatedBytes(lib: Library) {
            const pack = await exportLibrary(lib);
            return STORES.reduce((bytes, store) => bytes + new TextEncoder().encode(JSON.stringify(pack.data[store])).length, 0);
        }
        beforeBytes = await validatedBytes(source);
        await current();
        afterBytes = await validatedBytes(target);
        await current();
        return { library: target.db.name, sourceStamp, beforeBytes, afterBytes, records };
    } finally { target.close(); } // Never purge or overwrite original/partial copies.
}
