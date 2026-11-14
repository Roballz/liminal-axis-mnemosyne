import type { Library } from './db';
import { STORES, check, type Row, type Store } from './model';

/** Compare one persisted row at a time with already validated import data.
 * Store/key order and JSON serialization match exportLibrary's raw getAll data,
 * so equal rows/counts imply the same complete data fingerprint without keeping
 * a second full export or its serialized/hash buffers alive. Domain validation
 * remains the caller's responsibility; all reads share one readonly snapshot.
 */
export async function verifyRestoredRows(lib: Library, data: Readonly<Record<Store, readonly Row[]>>): Promise<void> {
    await lib.transaction(STORES, 'readonly', async tx => {
        for (const store of STORES) {
            const expected = data[store];
            await new Promise<void>((resolve, reject) => {
                let index = 0;
                const request = tx.native.objectStore(store).openCursor();
                request.onerror = () => reject(request.error ?? new Error('恢复后读取失败'));
                request.onsuccess = () => {
                    try {
                        const cursor = request.result;
                        if (!cursor) {
                            check(index === expected.length, `恢复后对象不一致 ${store}：记录数量不同`);
                            resolve();
                            return;
                        }
                        check(index < expected.length && JSON.stringify(cursor.value) === JSON.stringify(expected[index]),
                            `恢复后对象不一致 ${store}：第 ${index + 1} 条记录或顺序不同`);
                        index++;
                        cursor.continue();
                    } catch (error) { reject(error); }
                };
            });
        }
    });
}
