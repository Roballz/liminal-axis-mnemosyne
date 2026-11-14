import type { Library } from './db';
import { check, STORES, type Store } from './model';
import { utf8ByteLength } from './json';

export interface StoreSize { store: Store; records: number; bytes: number }
export interface CorePackageSize {
    measuredAt: number;
    bytes: number;
    stores: StoreSize[];
    details: {
        legacyViews: number; legacySelectionPairs: number; legacySelectionBytes: number;
        compactViews: number; selectionNodes: number; selectionEntries: number;
        reviewSourceRefs: number; reviewSourceBytes: number;
        summaryDependencies: number; summaryDependencyBytes: number;
        legacyTextRevisions: number; legacyTextBytes: number;
        snapshotBlockRefs: number;
    };
}

const PAGE_ROWS = 128;
const jsonBytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Explicit, read-only diagnosis. At most one row is serialized at a time and each
 * 128-row transaction ends before yielding; it never holds a full-library lock.
 * Only aggregate numbers leave the Worker, never source text, names or IDs.
 */
export async function measureCorePackageSize(lib: Library, isCurrent: () => boolean | Promise<boolean>): Promise<CorePackageSize> {
    const report: CorePackageSize = { measuredAt: 0, bytes: 0, stores: [], details: {
        legacyViews: 0, legacySelectionPairs: 0, legacySelectionBytes: 0, compactViews: 0,
        selectionNodes: 0, selectionEntries: 0, reviewSourceRefs: 0, reviewSourceBytes: 0,
        summaryDependencies: 0, summaryDependencyBytes: 0, legacyTextRevisions: 0,
        legacyTextBytes: 0, snapshotBlockRefs: 0,
    } };
    const details = report.details;
    for (const store of STORES) {
        const size: StoreSize = { store, records: 0, bytes: 2 }; // JSON array brackets
        let after: IDBValidKey | undefined;
        while (true) {
            check(await isCurrent(), '档案或页面已改变，本次体积分析已取消');
            const page = await lib.transaction([store], 'readonly', tx => new Promise<{ count: number; last?: IDBValidKey }>((resolve, reject) => {
                const request = tx.native.objectStore(store).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
                let count = 0, last: IDBValidKey | undefined;
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) { resolve({ count, last }); return; }
                    try {
                        const row = cursor.value;
                        size.bytes += jsonBytes(row) + (size.records++ ? 1 : 0);
                        if (store === 'memory_views') {
                            if (row.selectionSchema === 2) details.compactViews++;
                            else if (row.selections && typeof row.selections === 'object') {
                                details.legacyViews++;
                                details.legacySelectionPairs += Object.keys(row.selections).length;
                                details.legacySelectionBytes += jsonBytes(row.selections);
                            }
                        } else if (store === 'memory_selection_nodes') {
                            details.selectionNodes++;
                            details.selectionEntries += Array.isArray(row.entries) ? row.entries.length : 0;
                        } else if (store === 'reviews' && Array.isArray(row.sourceRefs)) {
                            details.reviewSourceRefs += row.sourceRefs.length;
                            details.reviewSourceBytes += jsonBytes(row.sourceRefs);
                        } else if (store === 'memory_revisions' && Array.isArray(row.dependencies)) {
                            details.summaryDependencies += row.dependencies.length;
                            details.summaryDependencyBytes += jsonBytes(row.dependencies);
                        } else if (store === 'source_revisions' && typeof row.content === 'string') {
                            details.legacyTextRevisions++;
                            details.legacyTextBytes += jsonBytes(row.content);
                        } else if (store === 'history_snapshots' && Array.isArray(row.blocks)) details.snapshotBlockRefs += row.blocks.length;
                        last = cursor.primaryKey;
                        if (++count === PAGE_ROWS) resolve({ count, last });
                        else cursor.continue();
                    } catch (error) { reject(error); }
                };
            }));
            if (page.count < PAGE_ROWS) break;
            after = page.last;
            await yieldTask();
        }
        report.stores.push(size);
        report.bytes += size.bytes;
        await yieldTask();
    }
    check(await isCurrent(), '档案或页面已改变，本次体积分析已取消');
    report.measuredAt = Date.now();
    report.stores.sort((a, b) => b.bytes - a.bytes);
    return report;
}
