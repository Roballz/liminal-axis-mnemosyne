/** 取思考块外最后一个完整 JSON 对象，由调用方校验摘要或批量楼层字段。 */
export function extractJsonObject<T = unknown>(raw: string): T | null {
  if (!raw || typeof raw !== 'string') return null;
  return scanObjects<T>(raw, 0, false, true, null);
}

function scanObjects<T>(raw: string, from: number, relaxedQuotes: boolean, mayEndPrefill: boolean, last: T | null): T | null {
  const marker = /\{|<think(?:ing)?\b|<\/think(?:ing)?>/gi;
  const tag = /<think(?:ing)?\b|<\/think(?:ing)?>/gi;
  marker.lastIndex = from;
  let retryFrom = -1;
  let retryMayEndPrefill = false;
  let match;
  while ((match = marker.exec(raw))) {
    if (match[0] !== '{') {
      if (match[0].startsWith('</')) {
        // 只有闭合标签的 assistant prefill，其前面的对象都属于检查草稿。
        if (mayEndPrefill) { last = null; retryFrom = -1; }
      } else {
        tag.lastIndex = marker.lastIndex;
        let depth = 1;
        while (depth > 0 && (match = tag.exec(raw))) {
          depth += match[0].startsWith('</') ? -1 : 1;
        }
        if (depth > 0) break;
        marker.lastIndex = tag.lastIndex;
      }
      mayEndPrefill = false;
      continue;
    }

    const start = match.index;
    const end = objectEnd(raw, start, relaxedQuotes);
    const body = raw.slice(start, end);
    const parsed = body.endsWith('}') ? parseObject<T>(body) : null;
    if (parsed !== null) {
      last = parsed;
      retryFrom = -1;
    } else if (!relaxedQuotes && retryFrom < 0 && /["“”]/.test(body)) {
      retryFrom = start;
      retryMayEndPrefill = mayEndPrefill;
    }
    marker.lastIndex = end;
    // 未合引号的 prefill 草稿可能吞掉真正的闭合标签与随后单独给出的答案。
    if (parsed === null && last === null && mayEndPrefill && end === raw.length) {
      tag.lastIndex = start + 1;
      const boundary = tag.exec(raw);
      if (boundary?.[0].startsWith('</') && /^\s*(?:```(?:json)?\s*)?\{/.test(raw.slice(tag.lastIndex))) {
        marker.lastIndex = boundary.index;
      }
    }
  }

  // 野引号可能导致普通扫描误判对象边界。只对最后一次成功之后的失败片段重扫一次。
  if (!relaxedQuotes && retryFrom >= 0) return scanObjects(raw, retryFrom, true, retryMayEndPrefill, last);
  return last;
}

/** 返回闭合位置之后的下标；破损片段遇到下一段围栏或思考标签时交回外层扫描。 */
function objectEnd(text: string, start: number, relaxedQuotes: boolean): number {
  let depth = 1;
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    const delimiter = c === '“' ? '”' : c;
    const isQuote = delimiter === '"' || delimiter === '”';
    if (quote) {
      if (c === '\\') i++;
      else if (isQuote && (relaxedQuotes ? endsString(text, i) : delimiter === quote)) quote = '';
    } else if (isQuote) {
      quote = delimiter;
    } else if (c === '{') {
      // 新行的对象仅在前一个位置无法容纳 JSON 值时才是重新起稿。
      let prev = i - 1;
      while (prev > start && /\s/.test(text[prev])) prev--;
      if (!':[,'.includes(text[prev]) && /[\r\n]/.test(text.slice(prev + 1, i))) return i;
      depth++;
    } else if (c === '}' && --depth === 0) {
      return i + 1;
    } else if (c === '<') {
      const tag = /<\/?think(?:ing)?\b/iy;
      tag.lastIndex = i;
      if (tag.test(text)) return i;
    } else if (c === '`' && text.startsWith('```', i)) {
      return i;
    }
  }
  return text.length;
}

function parseObject<T>(body: string): T | null {
  // 后记里的 {占位符} 不是 JSON，避免为每个占位符抛出解析异常。
  if (!/^\{\s*["“”}]/u.test(body)) return null;
  const direct = tryParse<T>(body);
  if (direct !== null) return direct;
  const cleaned = body.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1');
  if (cleaned !== body) {
    const normalized = tryParse<T>(cleaned);
    if (normalized !== null) return normalized;
  }
  const escaped = escapeStrayQuotes(body);
  return (escaped !== body ? tryParse<T>(escaped) : null)
    ?? (cleaned !== body ? tryParse<T>(escapeStrayQuotes(cleaned)) : null);
}

function endsString(text: string, quoteAt: number): boolean {
  let next = quoteAt + 1;
  while (next < text.length && /\s/.test(text[next])) next++;
  return next === text.length || ':,}]'.includes(text[next]);
}

/**
 * 补转义:把「字符串值内部未转义的双引号」补成 \"。仅在直接/清洗解析都失败后作兜底。
 * 逐字符扫描并跟踪是否在字符串内:字符串内遇到 " 时,向后看第一个非空白字符——只有它是
 * 结构符(: , } ] 或结尾)时才当作结束引号,否则判为正文里的野引号并补成 \"。
 * 对本就合法的 JSON 是恒等变换(合法 JSON 的字符串内不存在未转义的 "),故绝不会把能解析的弄坏;
 * 遇到真正歧义(野引号紧贴 ASCII 逗号)时会解析失败落到重试,不会静默截断成错数据。
 */
function escapeStrayQuotes(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '\\') {
      // 保留转义对(\" \\ \n 等)整体原样搬过去,不误判其中的引号
      out += c;
      if (i + 1 < s.length) { out += s[i + 1]; i++; }
      continue;
    }
    if (c === '"') {
      if (endsString(s, i)) {
        out += c;        // 结束引号
        inString = false;
      } else {
        out += '\\"';    // 正文野引号 -> 补转义
      }
      continue;
    }
    out += c;
  }
  return out;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
