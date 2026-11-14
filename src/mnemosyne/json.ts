/** Strict JSON boundary: duplicate keys, non-finite values and excessive nesting are rejected. */
import { check } from './model';

function countUtf8Bytes(text: string, maxBytes: number): number {
    let bytes = text.length;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) continue;
        if (code < 0x800) bytes++;
        else {
            bytes += 2;
            if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
                const next = text.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) i++;
            }
        }
        // Unpaired surrogates count as the 3-byte replacement used by TextEncoder.
        if (bytes > maxBytes) return bytes;
    }
    return bytes;
}

/** Exact UTF-8 size without allocating an encoded copy. */
export const utf8ByteLength = (text: string): number => countUtf8Bytes(text, Infinity);

export function parseStrictJson(text: string, maxBytes = 64 * 1024 * 1024): unknown {
    // Each UTF-16 unit needs 1..3 UTF-8 bytes; the bounds avoid unnecessary scans.
    check(text.length <= maxBytes && (text.length * 3 <= maxBytes || countUtf8Bytes(text, maxBytes) <= maxBytes), 'JSON 超过导入/请求大小上限');
    let i = 0;
    const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length)
        i++; };
    const string = (): string => {
        check(text[i] === '"', 'JSON字符串缺失');
        const begin = i++;
        while (i < text.length) {
            if (text[i] === '\\') {
                i += 2;
                continue;
            }
            if (text[i++] === '"')
                return JSON.parse(text.slice(begin, i));
        }
        throw new Error('JSON字符串未闭合');
    };
    const value = (depth: number): unknown => {
        check(depth <= 128, 'JSON嵌套过深');
        ws();
        if (text[i] === '"')
            return string();
        if (text[i] === '{') {
            i++;
            ws();
            const out: Record<string, unknown> = Object.create(null);
            const keys = new Set<string>();
            if (text[i] === '}') {
                i++;
                return out;
            }
            while (i < text.length) {
                ws();
                const key = string();
                check(!keys.has(key), `JSON重复字段 ${key}`);
                keys.add(key);
                ws();
                check(text[i++] === ':', 'JSON缺少冒号');
                out[key] = value(depth + 1);
                ws();
                const next = text[i++];
                if (next === '}')
                    return out;
                check(next === ',', 'JSON对象分隔符错误');
            }
            throw new Error('JSON对象未闭合');
        }
        if (text[i] === '[') {
            i++;
            ws();
            const out: unknown[] = [];
            if (text[i] === ']') {
                i++;
                return out;
            }
            while (i < text.length) {
                out.push(value(depth + 1));
                ws();
                const next = text[i++];
                if (next === ']')
                    return out;
                check(next === ',', 'JSON数组分隔符错误');
            }
            throw new Error('JSON数组未闭合');
        }
        const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
        check(token, 'JSON值无效');
        i += token[0].length;
        const result = JSON.parse(token[0]);
        check(typeof result !== 'number' || Number.isFinite(result), 'JSON数字非有限');
        return result;
    };
    const result = value(0);
    ws();
    check(i === text.length, 'JSON末尾有额外内容');
    return result;
}
