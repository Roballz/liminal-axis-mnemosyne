import { afterEach, expect, test, vi } from 'vitest';
import { parseStrictJson } from './json';

afterEach(() => vi.restoreAllMocks());

test('UTF-8 limits match TextEncoder at exact boundaries, including unpaired surrogates', () => {
    const samples = [
        'ASCII', '\u007f\u0080\u07ff\u0800\uffff', '中文', '😀🧠',
        '\ud800', '\udfff', '\ud800a\udc00', '\ud800\ud800\udc00\udc00', 'a界é😀\ud800',
    ];
    for (const value of samples) {
        // Keep literal lone surrogates: JSON.stringify would escape them first.
        const text = `"${value}"`, bytes = new TextEncoder().encode(text).length;
        expect(parseStrictJson(text, bytes)).toBe(value);
        expect(() => parseStrictJson(text, bytes - 1)).toThrow('大小上限');
    }
    const escaped = '"\\u4e2d\\ud83d\\ude00"', bytes = new TextEncoder().encode(escaped).length;
    expect(parseStrictJson(escaped, bytes)).toBe('中😀');
    expect(() => parseStrictJson(escaped, bytes - 1)).toThrow('大小上限');
});

test('size checks allocate no encoded copy for accepted or rejected JSON', () => {
    const text = `"${'中😀a'.repeat(2048)}"`, bytes = new TextEncoder().encode(text).length;
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => { throw new Error('encoded copy'); });
    const encodeInto = vi.spyOn(TextEncoder.prototype, 'encodeInto').mockImplementation(() => { throw new Error('encoded copy'); });
    expect(parseStrictJson(text, bytes)).toBe('中😀a'.repeat(2048));
    expect(() => parseStrictJson(text, bytes - 1)).toThrow('大小上限');
    expect(parseStrictJson('{"small":true}')).toEqual({ small: true });
    expect(encode).not.toHaveBeenCalled();
    expect(encodeInto).not.toHaveBeenCalled();
});

test('UTF-8 counting stops as soon as the remaining character lower bound exceeds the limit', () => {
    const text = `"${'中'.repeat(8192)}"`;
    const read = vi.spyOn(String.prototype, 'charCodeAt');
    let error: unknown;
    try { parseStrictJson(text, text.length + 1); } catch (e) { error = e; }
    const inputReads = read.mock.contexts.filter(context => context === text).length;
    read.mockRestore();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('大小上限');
    expect(inputReads).toBeGreaterThan(0);
    expect(inputReads).toBeLessThanOrEqual(4);
});

test('the default 64 MiB bound rejects oversized text without encoding or scanning it', () => {
    const text = ' '.repeat(64 * 1024 * 1024 + 1);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => { throw new Error('encoded copy'); });
    const read = vi.spyOn(String.prototype, 'charCodeAt');
    let error: unknown;
    try { parseStrictJson(text); } catch (e) { error = e; }
    const inputReads = read.mock.contexts.filter(context => context === text).length;
    read.mockRestore();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('大小上限');
    expect(inputReads).toBe(0);
    expect(encode).not.toHaveBeenCalled();
});
