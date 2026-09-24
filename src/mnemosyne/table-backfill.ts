import { reactive } from "vue";
import { getContext } from "@/st/context";
import { activeLibrary, type Library } from "./db";
import { snapshotRefs, capture, statuses } from "./canonical";
import {
  dailyState,
  hostVersion,
  syncDaily,
  dailyCurrent,
  refreshDailyTables,
} from "./bridge";
import {
  readTables,
  summaryTablesPrompt,
  parseSummaryTables,
  commitSummaryTables,
} from "./tables";
import { sendEvent, type EventSender } from "./manual-events";
import { parseStrictJson } from "./json";
import { check, equal, type Branch, type Snapshot } from "./model";
export const backfillState = reactive({
  busy: false,
  status: "",
  completed: 0,
});
let stopped = false;
export function stopTableBackfill() {
  stopped = true;
  backfillState.status = "等待当前请求返回后停止，尚未提交结果不应用";
}
/** Last confirmed floor, not a claim that earlier gaps have been filled. */
export async function tableLastFloors(lib: Library, branch: Branch) {
  return lib.transaction(
    [
      "table_receipts",
      "history_snapshots",
      "manifest_blocks",
      "memory_revisions",
    ],
    "readonly",
    async (tx) => {
      const snapshot = await tx.get<Snapshot>("history_snapshots", branch.head);
      check(snapshot, "快照缺失");
      const refs = await snapshotRefs(tx, snapshot),
        result: Record<string, number> = {};
      for (const receipt of await tx.all<any>(
        "table_receipts",
        "branch",
        branch.id,
      )) {
        if (receipt.result !== "success") continue;
        let floor = -1;
        if (receipt.bodySources) {
          if (
            !equal(
              receipt.bodySources,
              refs.slice(receipt.start, receipt.end + 1),
            )
          )
            continue;
          floor = receipt.end;
        } else
          for (const id of receipt.sources) {
            const memory = await tx.get<any>("memory_revisions", id);
            if (
              memory &&
              memory.inputRefs.every((r: any) =>
                refs.some((ref) => equal(ref, r)),
              )
            )
              floor = Math.max(
                floor,
                refs.findIndex((r) => r.message === memory.anchor),
              );
          }
        if (floor >= 0)
          result[receipt.owner] = Math.max(result[receipt.owner] ?? -1, floor);
      }
      return { floors: result, total: refs.length };
    },
  );
}
export interface BackfillRange {
  table: string;
  start: number;
  end: number;
}
export async function runTableBackfill(
  ranges: BackfillRange[],
  maxChars = 96000,
  sender: EventSender = sendEvent,
) {
  check(!backfillState.busy, "补表正在进行");
  check(
    ranges.length && new Set(ranges.map((r) => r.table)).size === ranges.length,
    "请选择不重复的表",
  );
  backfillState.busy = true;
  stopped = false;
  backfillState.completed = 0;
  try {
    const initial = await syncDaily(),
      lib = await activeLibrary();
    const host = hostVersion(),
      generation = dailyState.generation;
    const guard = () =>
      !stopped &&
      host === hostVersion() &&
      generation === dailyState.generation;
    for (const range of ranges)
      check(
        Number.isInteger(range.start) &&
          Number.isInteger(range.end) &&
          range.start >= 0 &&
          range.end >= range.start &&
          range.end < initial.cutoff,
        "补表楼层范围无效（楼号从0开始）",
      );
    for (const range of ranges) {
      // Small fixed source batches; successful batches retain their own receipts on failure/stop.
      for (
        let start = range.start;
        start <= range.end && !stopped;
        start += 20
      ) {
        const end = Math.min(start + 19, range.end);
        check(guard(), "聊天改变，补表停止");
        const view = await capture(lib, initial.branch.id);
        const input = (await readTables(lib, view.branch)).find(
          (t) => t.def.id === range.table,
        );
        check(input && input.def.columns.length, "表已删除或没有字段");
        const valid = await statuses(lib, view);
        input.rows = input.rows.filter((r) =>
          r.sources.every((id) => valid.get(id) === "valid"),
        );
        // Manual backfill explicitly authorizes this request even with automatic filling disabled.
        const manual = { ...input, def: { ...input.def, ai: true } };
        const prompt = summaryTablesPrompt([manual]);
        const refs = view.refs.slice(start, end + 1);
        const body = refs.map((ref, i) => ({
          floor: start + i,
          role: view.sources.get(ref.revision)?.role,
          body: getContext()?.chat[start + i]?.extra?.bbs_omit
            ? null
            : view.sources.get(ref.revision)?.content,
        }));
        const user =
          prompt.user +
          "\n【所选正文，null为番外不填写】\n" +
          JSON.stringify(body);
        const system =
          prompt.system +
          "\n这是独立补表，只返回根对象 customTables，不生成摘要或修改其他状态。历史范围可能与已填内容重叠：已有内容不另建、不重复更新或追加；只补充缺失事实。";
        check(
          system.length + user.length <= maxChars,
          "补表完整材料超过预算，未发送；请缩小范围或减少可见表内容",
        );
        check(
          (await dailyCurrent(view, host, generation)) && guard(),
          "补表材料已改变",
        );
        backfillState.status = `${input.def.name}：#${start} → #${end}`;
        const raw = await sender([
          { role: "system", content: system },
          { role: "user", content: user },
        ]);
        if (stopped) break;
        check(
          (await dailyCurrent(view, host, generation)) && guard(),
          "迟到补表结果已拒绝",
        );
        const output = parseStrictJson(
          raw.replace(/^```(?:json)?\s*|\s*```$/g, ""),
        ) as any;
        const plan = parseSummaryTables(
          output.customTables,
          [manual],
          view.branch.id,
        );
        check(plan, "缺少补表结果");
        await commitSummaryTables(lib, view, plan, [], guard, {
          start,
          end,
          refs,
        });
        backfillState.completed++;
      }
    }
    backfillState.status = stopped
      ? "已停止；成功批次保留，可继续补表"
      : `补表完成：${backfillState.completed} 个批次`;
    await refreshDailyTables();
  } catch (error) {
    backfillState.status = String((error as Error).message);
    throw error;
  } finally {
    backfillState.busy = false;
  }
}
