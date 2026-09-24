/** Human-selected membership; models can only describe the selected chain. */
import { reactive } from "vue";
import {
  requestCompletion,
  requestViaMainApi,
  type ChatMsg,
} from "@/api/client";
import { getChannelForTask } from "@/api/settings";
import { eventCreationContext } from "@/memory/engine";
import { activeLibrary, type Library } from "./db";
import { current } from "./canonical";
import { syncDaily, hostVersion, dailyState, dailyCurrent } from "./bridge";
import {
  eventView,
  editEvent,
  checkEventOverview,
  EVENT_OVERVIEW_MAX_CHARS,
  type EventCard,
} from "./events";
import { parseStrictJson } from "./json";
import {
  STORES,
  check,
  row,
  type Branch,
  type CapturedView,
  type EventRevision,
  type Membership,
  type Progress,
} from "./model";
export const manualEventState = reactive({ busy: false });
export type EventSender = (messages: ChatMsg[]) => Promise<string>;
export const sendEvent: EventSender = (messages) => {
  const channel = getChannelForTask("summary");
  return channel
    ? requestCompletion(channel, messages)
    : requestViaMainApi(messages);
};
export function eventOverview(card: EventCard) {
  return card.meta.overview ?? card.progress.map((p) => p.text).join("\n");
}
export function eventPending(card: EventCard) {
  const done = new Set(
    card.meta.summarized ?? card.progress.flatMap((p) => p.memories),
  );
  return card.members.some((m) => !done.has(m.memory));
}
const INSTRUCTION = `用户已决定事件边界，绝对不要拆链、合链或另建事件，不修改摘要、人物、物品或表格。
把用户所指的整体事项作为一条链，例如同一天约会的早餐、做花灯、逛街、灯会属于用户指定的同一约会整体。
仅输出 JSON：{"title":"标题","status":"open|resolved|dormant","keywords":["关键词"],"overview":"整条事件的精炼当前概要","progress":"仅本次新增内容的一段进展"}。
overview 必须不超过${EVENT_OVERVIEW_MAX_CHARS}字（含标点、数字、字母），建议250～450字，内容少时更短。只记录事件的核心变化、关键决定与结果，以及对人物关系或重要转变有实质影响的细节；必要时保留解释这些变化的前因后果。
主动舍弃琐碎小事、逐站行程、重复对话、装饰性动作和无后续影响的细节，不写流水账，不为凑字数扩写。更新时重新提炼整条链的核心，不在旧概要后机械追加。
概要忠于已给材料，不编造动机、未来或结局。输出前核对字数，超出则继续精简为完整语句。无新增进展时 progress 可为空。`;
export function parseManualEvent(raw: string) {
  const v = parseStrictJson(
    raw.replace(/^```(?:json)?\s*|\s*```$/g, ""),
  ) as any;
  check(
    v && typeof v.title === "string" && v.title.trim() && v.title.length <= 300,
    "事件标题无效",
  );
  check(["open", "resolved", "dormant"].includes(v.status), "事件状态无效");
  check(
    Array.isArray(v.keywords) &&
      v.keywords.length <= 100 &&
      v.keywords.every(
        (k: unknown) => typeof k === "string" && k.length <= 100,
      ),
    "事件关键词无效",
  );
  check(
    typeof v.overview === "string" &&
      !!v.overview.trim() &&
      typeof v.progress === "string" &&
      v.progress.length <= 4000,
    "概要或进展无效",
  );
  checkEventOverview(v.overview);
  v.overview = v.overview.trim();
  return v as {
    title: string;
    status: string;
    keywords: string[];
    overview: string;
    progress: string;
  };
}
export async function commitManualEvent(
  lib: Library,
  view: CapturedView,
  card: EventCard | null,
  memories: string[],
  raw: string,
  guard: () => boolean,
) {
  const output = parseManualEvent(raw);
  const allowed = (await eventView(lib, view)).valid;
  check(
    memories.length && memories.every((id) => allowed.some((m) => m.id === id)),
    "事件来源已失效",
  );
  const summarized =
    card?.meta.summarized ?? card?.progress.flatMap((p) => p.memories) ?? [];
  const added = memories.filter((id) => !summarized.includes(id));
  return lib.transaction(STORES, "readwrite", async (tx) => {
    const branch = await tx.get<Branch>("branches", view.branch.id);
    check(
      guard() &&
        branch &&
        branch.epoch === view.branch.epoch &&
        branch.head === view.branch.head &&
        branch.view === view.branch.view,
      "迟到事件结果已拒绝",
    );
    const id = card?.chain.id ?? row("ev").id;
    if (card)
      check(
        (await tx.get("event_chains", id))?.branch === branch.id,
        "事件已删除",
      );
    else
      await tx.add("event_chains", {
        id,
        schema: 1,
        story: branch.story,
        branch: branch.id,
        created: Date.now(),
      } as any);
    branch.epoch++;
    const base = {
      story: branch.story,
      branch: branch.id,
      owner: id,
      snapshot: view.snapshot.id,
      cutoff: view.cutoff,
      epoch: branch.epoch,
    };
    await tx.add("event_revisions", {
      ...row("er"),
      ...base,
      eventSchema: 2,
      title: card?.meta.title ?? output.title,
      status: card?.meta.status ?? output.status,
      keywords: output.keywords,
      overview: output.overview,
      summarized: memories,
      refs: memories,
      created: Date.now(),
    } as EventRevision);
    if (!card)
      for (const memory of memories)
        await tx.add("event_memberships", {
          ...row("link"),
          ...base,
          memory,
          kind: "progress",
          origin: "manual",
          locked: true,
          active: true,
        } as Membership);
    if (output.progress.trim() && added.length)
      await tx.add("event_progress", {
        ...row("ep"),
        ...base,
        text: output.progress,
        memories: added,
        operation: row("manualoverview").id,
      } as Progress);
    check(guard(), "聊天改变，事件未提交");
    await tx.put("branches", branch);
    return id;
  });
}
export async function floorEventContext(floor: number) {
  const view = await syncDaily(),
    lib = await activeLibrary();
  const host = hostVersion(),
    generation = dailyState.generation;
  const data = await eventView(lib, view);
  check(await dailyCurrent(view, host, generation), "楼层已改变");
  const memory = data.valid.find(
    (m) => m.level === 0 && m.anchor === view.refs[floor]?.message,
  );
  check(memory, "请先生成本楼有效摘要；番外或待审核摘要不能加入事件");
  return { view, lib, memory, cards: data.cards };
}
export async function createFloorEvent(
  floor: number,
  intent: string,
  maxChars: number,
  sender: EventSender = sendEvent,
) {
  check(intent.trim(), "请说明要建立怎样的事件链");
  const { view, lib, memory } = await floorEventContext(floor);
  const host = hostVersion(),
    generation = dailyState.generation;
  const messages = await eventCreationContext(floor, view);
  messages.push(
    {
      role: "system",
      content:
        INSTRUCTION +
        "\n前面的摘要格式仅供理解材料；这次只输出事件 JSON，不执行其他填表任务。",
    },
    {
      role: "user",
      content: JSON.stringify({
        intent,
        floor,
        body: view.sources.get(view.refs[floor].revision)?.content,
        summary: memory.content,
      }),
    },
  );
  check(
    JSON.stringify(messages).length <= maxChars,
    "事件请求超过字符预算，未发送",
  );
  check(await dailyCurrent(view, host, generation), "楼层已改变，请重新打开");
  const raw = await sender(messages);
  check(await dailyCurrent(view, host, generation), "迟到事件结果已拒绝");
  return commitManualEvent(
    lib,
    view,
    null,
    [memory.id],
    raw,
    () => host === hostVersion() && generation === dailyState.generation,
  );
}
export async function joinFloorEvent(floor: number, eventId: string) {
  const { view, lib, memory, cards } = await floorEventContext(floor);
  const host = hostVersion(),
    generation = dailyState.generation;
  const card = cards.find((c) => c.chain.id === eventId);
  check(card, "事件不存在或不属于当前分支");
  if (card.members.some((m) => m.memory === memory.id)) return false;
  await editEvent(
    lib,
    view,
    eventId,
    card.meta,
    { memory: memory.id, active: true, kind: "progress" },
    () => host === hostVersion() && generation === dailyState.generation,
  );
  return true;
}
export async function updateEventOverview(
  lib: Library,
  view: CapturedView,
  eventId: string,
  maxChars: number,
  sender: EventSender = sendEvent,
  guard: () => boolean = () => true,
) {
  const card = (await eventView(lib, view)).cards.find(
    (c) => c.chain.id === eventId,
  );
  check(card, "事件不存在或已失效");
  if (!eventPending(card)) return false;
  const memories = card.members.map((m) => m.memory);
  const materials = memories.map((id) => {
    const m = view.memories.find((m) => m.id === id)!;
    const refs = [
      ...m.inputRefs,
      ...view.refs.filter((r) => r.message === m.anchor),
    ];
    return {
      id,
      summary: m.content,
      sources: [
        ...new Map(
          refs.map((r) => [
            r.revision,
            { ...r, body: view.sources.get(r.revision)?.content },
          ]),
        ).values(),
      ],
    };
  });
  const messages: ChatMsg[] = [
    { role: "system", content: INSTRUCTION },
    {
      role: "user",
      content: JSON.stringify({
        title: card.meta.title,
        status: card.meta.status,
        overview: eventOverview(card),
        summarized:
          card.meta.summarized ?? card.progress.flatMap((p) => p.memories),
        materials,
      }),
    },
  ];
  check(
    JSON.stringify(messages).length <= maxChars,
    "该事件完整材料超过预算，未截断或发送；请调整预算",
  );
  check(guard() && (await current(lib, view)), "事件材料已改变");
  const raw = await sender(messages);
  check(guard() && (await current(lib, view)), "迟到事件结果已拒绝");
  await commitManualEvent(lib, view, card, memories, raw, guard);
  return true;
}
