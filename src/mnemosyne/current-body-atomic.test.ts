import 'fake-indexeddb/auto';
import { test, expect, vi } from 'vitest';
import { Library, Transaction, freshLibraryName } from './db';
import { capture, current, synchronize, type HostObservation } from './canonical';
import { STORES } from './model';

const input = (): HostObservation => ({ scope: 'atomic-current', messages: [
    { key: 'user', role: 'user', content: '合成问题', swipe: 0 },
    { key: 'assistant', role: 'assistant', content: '合成正文 A', swipe: 0 },
], memories: [] });

for (const failure of ['publish', 'retire'] as const) test(`current body ${failure} failure rolls back payload, descriptors and head atomically`, async () => {
    const lib = await Library.open(freshLibraryName()), observation = input();
    try {
        const branch = await synchronize(lib, observation), before = await capture(lib, branch.id);
        const saved = await Promise.all(STORES.map(store => lib.all(store)));
        observation.messages[1].content = '合成正文 B';
        const put = Transaction.prototype.put, remove = Transaction.prototype.delete;
        const spy = failure === 'publish'
            ? vi.spyOn(Transaction.prototype, 'put').mockImplementation(function (this: Transaction, store, value) {
                if (store === 'source_bodies') throw new DOMException('synthetic quota', 'QuotaExceededError');
                return put.call(this, store, value);
            })
            : vi.spyOn(Transaction.prototype, 'delete').mockImplementation(function (this: Transaction, store, key) {
                if (store === 'source_bodies') throw new DOMException('synthetic interruption', 'AbortError');
                return remove.call(this, store, key);
            });
        try { await expect(synchronize(lib, observation)).rejects.toThrow(/synthetic/); }
        finally { spy.mockRestore(); }
        expect(await Promise.all(STORES.map(store => lib.all(store)))).toEqual(saved);
        expect(await current(lib, before)).toBe(true);
        expect(await capture(lib, branch.id)).toEqual(before);
        await synchronize(lib, observation);
        expect(await current(lib, before)).toBe(false);
        const after = await capture(lib, branch.id);
        expect(after.sources.get(after.refs[1].revision)?.content).toBe('合成正文 B');
        expect(await lib.get('source_bodies', before.refs[1].revision)).toBeUndefined();
    } finally { lib.close(); }
});
