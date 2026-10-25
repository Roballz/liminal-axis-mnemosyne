import { afterEach, expect, test, vi } from 'vitest';
import { HostVersionMemo } from './host-version';

afterEach(() => vi.restoreAllMocks());

test('unchanged large bodies reuse the JSON string while exact nested edits invalidate it', () => {
    const memo = new HostVersionMemo(), stringify = JSON.stringify;
    const value = ['scope', Array.from({ length: 300 }, (_, i) => [i, '甲'.repeat(2000), { delta: { x: 1 } }]), [], 1] as any[];
    const spy = vi.spyOn(JSON, 'stringify');
    const first = memo.read(value);
    for (let i = 0; i < 6; i++) expect(memo.read(value)).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    value[1][1][1] = '乙'.repeat(2000); // Same length, no notification, same container.
    expect(memo.read(value)).toBe(stringify(value));
    value[1][2][2].delta.x = 2;
    expect(memo.read(value)).toBe(stringify(value));
    value[2].push({ childIds: ['a'], text: '高层摘要' });
    expect(memo.read(value)).toBe(stringify(value));
    value[2][0].childIds[0] = 'b';
    expect(memo.read(value)).toBe(stringify(value));
    expect(spy).toHaveBeenCalledTimes(5);
});

test('scope, order, deleted keys, sparse slots and array replacement preserve exact JSON semantics', () => {
    const memo = new HostVersionMemo();
    const values: any[] = ['a', [[1, { x: 1, y: 2 }], [2, { x: 3 }]], ['first', 'second'], 1];
    const check = () => expect(memo.read(values)).toBe(JSON.stringify(values));
    check(); values[0] = 'b'; check(); values[1].reverse(); check();
    delete values[1][1][1].x; values[1][1][1].x = 1; check();
    delete values[2][0]; check(); values[2][0] = undefined; check();
    values[2] = [null, 'second']; check(); values[3]++; check();
});

test('Date, custom toJSON and accessors take the original uncached serialization path', () => {
    const memo = new HostVersionMemo(), date = new Date('2026-01-01T00:00:00Z');
    expect(memo.read([date])).toBe('["2026-01-01T00:00:00.000Z"]');
    date.setUTCFullYear(2027);
    expect(memo.read([date])).toBe('["2027-01-01T00:00:00.000Z"]');
    let n = 0;
    const custom = { toJSON: () => ++n };
    expect(memo.read([custom])).toBe('[1]'); expect(memo.read([custom])).toBe('[2]');
    n = 0;
    const accessor = { get value() { return Math.min(++n, 2); } };
    expect(memo.read([accessor])).toBe('[{"value":1}]');
    expect(memo.read([accessor])).toBe('[{"value":2}]');
    expect(memo.read([accessor])).toBe('[{"value":2}]');
});

test('unsupported cyclic inputs retain the original error and do not poison a previous version', () => {
    const memo = new HostVersionMemo();
    expect(memo.read(['ok'])).toBe('["ok"]');
    const cyclic: any[] = []; cyclic.push(cyclic);
    expect(() => memo.read(cyclic)).toThrow(TypeError);
    expect(memo.read(['ok'])).toBe('["ok"]');
});
