// Strict, resource-limited JSON transport. JSON.parse alone loses duplicate keys.
import { requireThat } from '../contracts/primitives.mjs';
const check = requireThat;
export const TEXT_LIMITS = Object.freeze({ lineBytes: 1048576, totalBytes: 33554432, lines: 4096, depth: 64, values: 200000 });
export function parseStrictJSON(text, limits = TEXT_LIMITS) {
  check(typeof text === 'string' && text.isWellFormed(), 'INVALID_SCHEMA', 'Invalid Unicode input');
  check(new TextEncoder().encode(text).length <= limits.lineBytes, 'RESOURCE_LIMIT', 'JSON record too large');
  let i = 0, values = 0;
  const ws = () => { while (i < text.length && /[\x20\t\r\n]/.test(text[i])) i++; };
  const bad = () => check(false, 'INVALID_SCHEMA', `Invalid JSON at character ${i}`);
  function string() {
    const begin = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') {
        let value; try { value = JSON.parse(text.slice(begin, i)); } catch { bad(); }
        check(value.isWellFormed(), 'INVALID_SCHEMA', 'Invalid Unicode escape'); return value;
      }
      if (c === '\\') i++;
      else if (c.charCodeAt(0) < 32) bad();
    }
    bad();
  }
  function value(depth) {
    check(depth <= limits.depth && ++values <= limits.values, 'RESOURCE_LIMIT', 'JSON nesting/value limit');
    ws(); const c = text[i];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      i++; ws(); const object = c === '{', end = object ? '}' : ']', output = object ? {} : [], keys = new Set();
      if (text[i] === end) { i++; return output; }
      while (i < text.length) {
        ws();
        if (object) {
          if (text[i] !== '"') bad();
          const key = string(); check(!keys.has(key), 'DUPLICATE_KEY', 'Duplicate JSON key'); keys.add(key);
          ws(); if (text[i++] !== ':') bad();
          Object.defineProperty(output, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
        } else output.push(value(depth + 1));
        ws(); if (text[i] === end) { i++; return output; }
        if (text[i++] !== ',') bad();
      }
      bad();
    }
    for (const [literal, result] of [['null', null], ['true', true], ['false', false]]) {
      if (text.startsWith(literal, i)) { i += literal.length; return result; }
    }
    const token = text.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!token) bad();
    i += token[0].length; const number = Number(token[0]);
    check(Number.isFinite(number), 'INVALID_SCHEMA', 'Non-finite JSON number'); return number;
  }
  const output = value(0); ws(); if (i !== text.length) bad(); return output;
}

// Byte chunks, not a pre-materialized backup. Reject before retaining an oversized line.
export async function* readJSONLines(chunks, limits = TEXT_LIMITS) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let line = '', lineBytes = 0, total = 0, count = 0;
  for await (const chunk of chunks) {
    check(chunk instanceof Uint8Array, 'INVALID_SCHEMA', 'UTF-8 byte chunks required');
    total += chunk.byteLength; check(total <= limits.totalBytes, 'RESOURCE_LIMIT', 'Backup byte limit');
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i !== chunk.length && chunk[i] !== 10) continue;
      const part = chunk.subarray(start, i); lineBytes += part.length;
      check(lineBytes <= limits.lineBytes, 'RESOURCE_LIMIT', 'Backup line limit');
      try { line += decoder.decode(part, { stream: true }); } catch { check(false, 'INVALID_SCHEMA', 'Invalid UTF-8'); }
      if (i !== chunk.length) {
        try { line += decoder.decode(); } catch { check(false, 'INVALID_SCHEMA', 'Truncated UTF-8'); }
        check(++count <= limits.lines, 'RESOURCE_LIMIT', 'Backup record count limit');
        yield parseStrictJSON(line, limits); line = ''; lineBytes = 0;
      }
      start = i + 1;
    }
  }
  try { line += decoder.decode(); } catch { check(false, 'INVALID_SCHEMA', 'Truncated UTF-8'); }
  check(line.length === 0 && lineBytes === 0, 'INVALID_SCHEMA', 'Backup must end at a newline boundary');
}
