/** Strict JSON boundary: duplicate keys, non-finite values and excessive nesting are rejected. */
import { check } from './model';
export function parseStrictJson(text: string, maxBytes = 64 * 1024 * 1024): unknown {
    check(new TextEncoder().encode(text).length <= maxBytes, 'JSON 超过导入/请求大小上限');
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
