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
import { sendEvent, sendReviewEvent, type EventSender } from "./manual-events";
import { eventJsonText } from "./event-response";
import { parseStrictJson } from "./json";
import { check, equal, type Branch, type Snapshot } from "./model";
export const backfillState = reactive({
  busy: false,
  status: "",
  completed: 0,
});
let stopped = false;
let cancelPendingReview: (() => void) | undefined;
export function stopTableBackfill() {
  stopped = true;
  cancelPendingReview?.();
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
export interface TableBackfillReview {
  raw: string;
  title: string;
  tables: Awaited<ReturnType<typeof readTables>>;
  example: string;
  validate(text: string): string;
  confirm(text: string, live?: () => boolean): Promise<void>;
}
export async function runTableBackfill(
  ranges: BackfillRange[],
  maxChars = 96000,
  sender?: EventSender,
  batchSize = 20,
  isCurrent: () => boolean = () => true,
  reviewer?: (review: TableBackfillReview) => Promise<boolean>,
) {
  check(!backfillState.busy, "补表正在进行");
  check(Number.isSafeInteger(batchSize) && batchSize > 0, "每批楼数必须为正整数");
  check(ranges.length && new Set(ranges.map(r => r.table)).size === ranges.length, "请选择不重复的表");
  check(isCurrent(), "聊天已改变，请重新打开");
  backfillState.busy = true;
  stopped = false;
  backfillState.completed = 0;
  try {
    const initial = await syncDaily(), lib = await activeLibrary();
    const host = hostVersion(), generation = dailyState.generation;
    const guard = () => !stopped && isCurrent() && host === hostVersion() && generation === dailyState.generation;
    const groups = new Map<string, BackfillRange[]>();
    for (const range of ranges) {
      check(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start && range.end < initial.cutoff, "补表楼层范围无效（楼号从0开始）");
      const key = `${range.start}:${range.end}`;
      groups.set(key, [...(groups.get(key) ?? []), range]);
    }
    for (const group of groups.values()) {
      const range = group[0];
      for (let start = range.start; start <= range.end && !stopped; start += batchSize) {
        const end = Math.min(start + batchSize - 1, range.end);
        check(guard(), "聊天改变，补表停止");
        const view = await capture(lib, initial.branch.id), tables = await readTables(lib, view.branch);
        const valid = await statuses(lib, view);
        const inputs = group.map(r => {
          const input = tables.find(t => t.def.id === r.table);
          check(input && input.def.columns.length, "表已删除或没有字段");
          return { ...input, def: { ...input.def, ai: true }, rows: input.rows.filter(row => row.sources.every(id => valid.get(id) === 'valid')) };
        });
        const prompt = summaryTablesPrompt(inputs), refs = view.refs.slice(start, end + 1);
        const body = refs.map((ref, i) => ({ floor: start + i, role: view.sources.get(ref.revision)?.role,
          body: getContext()?.chat[start + i]?.extra?.bbs_omit ? null : view.sources.get(ref.revision)?.content }));
        const user = prompt.user + "\n【所选正文，null为番外不填写】\n" + JSON.stringify(body);
        const system = prompt.system + "\n这是独立补表，只返回根对象 customTables，包含所有选中的表；不生成摘要或修改其他状态。历史范围可能与已填内容重叠：已有内容不另建、不重复更新或追加；只补充缺失事实。";
        check(system.length + user.length <= maxChars, "补表完整材料超过预算，未发送；请减少每批楼数或可见表内容");
        check((await dailyCurrent(view, host, generation)) && guard(), "补表材料已改变");
        backfillState.status = `${inputs.map(t => t.def.name).join('、')}：#${start} → #${end}`;
        const raw = await (sender ?? (reviewer ? sendReviewEvent : sendEvent))([{ role: 'system', content: system }, { role: 'user', content: user }]);
        if (stopped) break;
        let saving = false, saved = false;
        const parse = (text: string) => {
          const output = parseStrictJson(eventJsonText(text)) as any;
          const plan = parseSummaryTables(output?.customTables, inputs, view.branch.id);
          check(plan, "缺少补表结果");
          return plan;
        };
        const review: TableBackfillReview = {
          raw, title: backfillState.status, tables: inputs,
          example: JSON.stringify({ customTables: inputs.map(t => ({ table_id: t.def.id, add: [], update: [] })) }, null, 2),
          validate(text) { try { parse(text); return ''; } catch (e) { return (e as Error).message; } },
          async confirm(text, live = () => true) {
            check(!saving && !saved, '此返回正在保存或已经保存，请勿重复确认');
            saving = true;
            try {
              check(live() && guard() && await dailyCurrent(view, host, generation), '迟到补表结果已拒绝：聊天、表或来源已改变；请复制草稿后重新打开');
              const plan = parse(text);
              await commitSummaryTables(lib, view, plan, [], () => live() && guard(), { start, end, refs });
              saved = true;
            } finally { saving = false; }
          },
        };
        if (reviewer) {
          const cancelled = new Promise<boolean>(resolve => { cancelPendingReview = () => resolve(false); });
          const accepted = await Promise.race([reviewer(review), cancelled]);
          cancelPendingReview = undefined;
          if (!accepted || stopped) { stopped = true; break; }
          check(saved, '补表返回尚未确认保存');
        } else await review.confirm(raw);
        backfillState.completed++;
        await refreshDailyTables();
      }
    }
    backfillState.status = stopped ? "已停止；成功批次保留，可继续补表" : `补表完成：${backfillState.completed} 个批次`;
  } catch (error) {
    backfillState.status = String((error as Error).message);
    throw error;
  } finally {
    cancelPendingReview = undefined;
    backfillState.busy = false;
  }
}
