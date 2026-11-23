/**
 * 从 LLM 文本输出里健壮地提取 JSON 对象。
 * 应对:```json 围栏、思维链前后缀、智能引号、尾随逗号。
 */
export function extractJsonObject<T = unknown>(raw: string): T | null {
  if (!raw || typeof raw !== 'string') return null;

  // 检查记录有时由 assistant prefill 打开，实际返回里只有闭合标签。
  const marker = /\{|<think(?:ing)?\b|<\/think(?:ing)?>/gi;
  const tag = /<think(?:ing)?\b|<\/think(?:ing)?>/gi;
  let checkPrefill = true;
  let match;
  while ((match = marker.exec(raw))) {
    if (match[0] !== '{') {
      if (!match[0].startsWith('</')) {
        tag.lastIndex = marker.lastIndex;
        let depth = 1;
        while (depth > 0) {
          const nested = tag.exec(raw);
          if (!nested) return null;
          depth += nested[0].startsWith('</') ? -1 : 1;
        }
        marker.lastIndex = tag.lastIndex;
      }
      checkPrefill = false;
      continue;
    }

    const start = match.index;
    const end = objectEnd(raw, start);
    if (checkPrefill) {
      checkPrefill = false;
      // 裸闭合标签前的对象可能是检查草稿。跳过对象内部的字面标签，
      // 后记中新开的思考块也不属于这段 prefill。
      tag.lastIndex = end < 0 ? start + 1 : end;
      if (tag.exec(raw)?.[0].startsWith('</')) {
        marker.lastIndex = tag.lastIndex;
        continue;
      }
    }

    const direct = end < 0 ? null : tryParse<T>(raw.slice(start, end));
    if (direct !== null) return direct;

    // 围栏前的说明偶尔包含 {占位符}。只跳过这种非 JSON 前言，不从残缺对象里捞内层结果。
    if (end >= 0 && /^\{\s*[^"“”}\s]/u.test(raw.slice(start, end))) {
      const fence = /^[^`{}<>]*```(?:json)?\s*(?=\{)/i.exec(raw.slice(end));
      if (fence) {
        marker.lastIndex = end + fence[0].length;
        continue;
      }
    }

    // 引号不规范时，原串算出的右边界也可能有误；修复后再从同一起点配平。
    const body = raw.slice(start, raw.lastIndexOf('}') + 1);
    const cleaned = body
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
    const normalized = cleaned !== body ? parseFirstObject<T>(cleaned) : null;
    return normalized ?? parseFirstObject<T>(escapeStrayQuotes(body))
      ?? (cleaned !== body ? parseFirstObject<T>(escapeStrayQuotes(cleaned)) : null);
  }
  return null;
}

/** 从外层左花括号开始，返回其配对右花括号之后的位置。JSON.parse 负责校验语法。 */
function objectEnd(text: string, start: number): number {
  let depth = 1;
  let inString = false;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return i + 1;
    }
  }
  return -1;
}

function parseFirstObject<T>(body: string): T | null {
  const end = objectEnd(body, 0);
  return end < 0 ? null : tryParse<T>(body.slice(0, end));
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
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = j < s.length ? s[j] : '';
      if (next === '' || next === ':' || next === ',' || next === '}' || next === ']') {
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
