/** Event-only diagnostics; archive/import JSON rules remain unchanged. */
import { check } from "./model";
import { parseStrictJson } from "./json";
import { checkEventOverview } from "./events";

export function eventJsonText(raw: string) {
  return raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\s*```$/i, "$1");
}
export function parseManualEvent(raw: string) {
  const text = eventJsonText(raw);
  check(
    text,
    "返回正文为空：没有收到可用的输出文本。可手动填写完整 JSON，或取消后检查 API 设置。",
  );
  // Native syntax diagnostics give a position; the strict parser also rejects duplicate keys.
  try {
    JSON.parse(text);
  } catch (error) {
    const message = (error as Error).message;
    const position = /position (\d+)/i.exec(message);
    const prefix = position
      ? text.slice(0, Number(position[1])).split("\n")
      : null;
    const where = prefix
      ? `（第 ${prefix.length} 行，第 ${prefix.at(-1)!.length + 1} 列）`
      : "";
    const truncated = /end of|unterminated|EOF/i.test(message)
      ? " 疑似输出截断或缺少闭合引号/括号；仅凭正文不能确定是否达到模型输出上限。"
      : "";
    throw new Error(`JSON 语法错误${where}：${message}${truncated}`);
  }
  const v = parseStrictJson(text) as any;
  check(
    v && typeof v === "object" && !Array.isArray(v),
    "最外层必须是一个 JSON 对象，不能是列表、字符串或 null。",
  );
  check(
    typeof v.title === "string" && v.title.trim() && v.title.length <= 300,
    "title（事件标题）必须是非空文本，最多300字符。",
  );
  check(
    ["open", "resolved", "dormant"].includes(v.status),
    "status（事件状态）必须填 open（进行中）、resolved（已结束）或 dormant（暂搁）。",
  );
  check(
    Array.isArray(v.keywords) &&
      v.keywords.length <= 100 &&
      v.keywords.every(
        (k: unknown) => typeof k === "string" && k.length <= 100,
      ),
    'keywords（关键词）必须是文本数组，如 ["约会", "约定"]；最多100项，每项100字符。',
  );
  check(
    typeof v.overview === "string" && v.overview.trim(),
    "overview（事件概要）必须是非空文本。",
  );
  checkEventOverview(v.overview);
  check(
    typeof v.progress === "string" && v.progress.length <= 4000,
    'progress（追加进展）必须是文本，最多4000字符；没有进展可填空字符串 ""。',
  );
  return {
    title: v.title,
    status: v.status,
    keywords: v.keywords as string[],
    overview: v.overview.trim(),
    progress: v.progress,
  };
}
export function eventResponseError(text: string): string {
  try {
    parseManualEvent(text);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}
