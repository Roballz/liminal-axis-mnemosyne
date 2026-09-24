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
import { eventView, editEvent, type EventCard } from "./events";
import { buildEventInstruction } from "./event-prompts";
import { parseManualEvent } from "./event-response";
export { parseManualEvent } from "./event-response";
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
export async function commitManualEvent(
  lib: Library,
  view: CapturedView,
  card: EventCard | null,
  memories: string[],
  raw: string,
  guard: () => boolean,
  reviewed = false,
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
      title: reviewed ? output.title : (card?.meta.title ?? output.title),
      status: reviewed ? output.status : (card?.meta.status ?? output.status),
      keywords: output.keywords,
      overview: output.overview,
      summarized: memories,
      refs: memories,
      created: Date.now(),
    } as EventRevision);
    if (!card || reviewed)
      for (const memory of memories.filter(
        (id) => !card?.members.some((m) => m.memory === id),
      ))
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
export async function prepareFloorEvent(
  floor: number,
  intent: string,
  maxChars: number,
  sender: EventSender = sendReviewEvent,
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
        buildEventInstruction() +
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
  return makeEventReview(lib, view, null, [memory.id], raw, host, generation);
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
  const raw = await requestEventOverview(
    view,
    card,
    memories,
    maxChars,
    sender,
    guard,
    lib,
  );
  await commitManualEvent(lib, view, card, memories, raw, guard);
  return true;
}
async function requestEventOverview(
  view: CapturedView,
  card: EventCard,
  memories: string[],
  maxChars: number,
  sender: EventSender,
  guard: () => boolean,
  lib: Library,
  rewriteInstructions?: string,
) {
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
    {
      role: "system",
      content:
        buildEventInstruction() +
        (rewriteInstructions
          ? "\n本次按用户 rewriteInstructions 重写已有事件概要，结合当前概要和全部成员正文重新提炼。保留事实，不把改写要求当已发生剧情；保留已有标题和状态。没有待整理的新成员时 progress 填空字符串，不把重新措辞当成新进展。"
          : ""),
    },
    {
      role: "user",
      content: JSON.stringify({
        title: card.meta.title,
        status: card.meta.status,
        ...(rewriteInstructions
          ? { rewriteInstructions, keywords: card.meta.keywords }
          : {}),
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
  return raw;
}

/** Floor calls retain empty/invalid content for review. Batch calls keep their strict path. */
const sendReviewEvent: EventSender = (messages) => {
  const channel = getChannelForTask("summary"),
    options = { reviewResponse: true };
  return channel
    ? requestCompletion(channel, messages, options)
    : requestViaMainApi(messages, options);
};
export type EventReview = ReturnType<typeof makeEventReview>;
function makeEventReview(
  lib: Library,
  view: CapturedView,
  card: EventCard | null,
  memories: string[],
  raw: string,
  host: string,
  generation: number,
) {
  let saving = false,
    saved = false;
  return {
    raw,
    title: card ? `更新：${card.meta.title}` : "新建事件链",
    async confirm(text: string, live: () => boolean = () => true) {
      check(!saving && !saved, "此返回正在保存或已经保存，请勿重复确认");
      saving = true;
      try {
        parseManualEvent(text);
        check(
          live() && (await dailyCurrent(view, host, generation)),
          "聊天、楼层或事件已改变，此返回不能写入；请复制草稿后重新打开",
        );
        const id = await commitManualEvent(
          lib,
          view,
          card,
          memories,
          text,
          () =>
            live() &&
            host === hostVersion() &&
            generation === dailyState.generation,
          true,
        );
        saved = true;
        return id;
      } finally {
        saving = false;
      }
    },
  };
}
export async function prepareFloorEventUpdate(
  floor: number,
  eventId: string,
  maxChars: number,
  sender: EventSender = sendReviewEvent,
) {
  const { view, lib, memory, cards } = await floorEventContext(floor);
  const card = cards.find((c) => c.chain.id === eventId);
  check(card, "事件不存在或不属于当前分支");
  const memories = [
    ...new Set([...card.members.map((m) => m.memory), memory.id]),
  ];
  if (memories.length === card.members.length && !eventPending(card))
    return null;
  const host = hostVersion(),
    generation = dailyState.generation;
  const raw = await requestEventOverview(
    view,
    card,
    memories,
    maxChars,
    sender,
    () => host === hostVersion() && generation === dailyState.generation,
    lib,
  );
  return makeEventReview(lib, view, card, memories, raw, host, generation);
}

/** Explicit rewrite may run with no pending members, including archived chains. */
export async function prepareEventRewrite(
  eventId: string,
  instructions: string,
  maxChars: number,
  sender: EventSender = sendReviewEvent,
) {
  check(instructions.trim(), "请说明希望怎样重写概要");
  const view = await syncDaily(),
    lib = await activeLibrary();
  const host = hostVersion(),
    generation = dailyState.generation;
  const card = (await eventView(lib, view)).cards.find(
    (c) => c.chain.id === eventId,
  );
  check(card, "事件不存在或不属于当前分支");
  const memories = card.members.map((m) => m.memory);
  check(
    memories.length,
    "该事件没有有效关联摘要，请先从楼层加入内容再重写概要",
  );
  const raw = await requestEventOverview(
    view,
    card,
    memories,
    maxChars,
    sender,
    () => host === hostVersion() && generation === dailyState.generation,
    lib,
    instructions.trim(),
  );
  return makeEventReview(lib, view, card, memories, raw, host, generation);
}
