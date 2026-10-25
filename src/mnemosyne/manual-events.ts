import { splitTimeLabel } from '@/memory/timeTag';
/** Human-selected membership; models can only describe the selected chain. */
import { reactive } from "vue";
import {
  requestCompletion,
  requestViaMainApi,
  type ChatMsg,
} from "@/api/client";
import { getChannelForTask } from "@/api/settings";
import { eventOverviewMaxChars, eventBatchTokens, eventMaterialMode, type EventMaterialMode } from "./event-settings";
import { eventInputBytes, estimateEventInputBytes, estimateEventInputTokens } from "./event-token-budget";
import { eventMaterial, eventSourceRefs, prepareEventMaterials } from "./event-materials";
import { eventCreationContext } from "@/memory/engine";
import { activeLibrary, type Library } from "./db";
import { current, statuses, type MemoryStatus } from "./canonical";
import { syncDaily, hostScope, hostVersion, dailyState, dailyCurrent } from "./bridge";
import { eventView, editEvent, confirmLatestProgressSource, type EventCard } from "./events";
import { buildEventInstruction } from "./event-prompts";
import { parseManualEvent } from "./event-response";
export { parseManualEvent } from "./event-response";
import {
  check,
  row,
  type Branch,
  type CapturedView,
  type EventRevision,
  type Membership,
  type Progress,
  type MemoryRevision,
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
  return !!card.needsReview || !!card.blocked || card.members.some((m) => !done.has(m.memory));
}
/** Compatibility upgrades are explicit manual work, never an automatic new-material trigger. */
export function eventCoverageUpgradeNeeded(card: EventCard) {
  return card.members.length > 0 && (card.meta.overviewCoverage !== 1 || card.meta.overviewMaterialMode !== eventMaterialMode());
}
export async function commitManualEvent(
  lib: Library,
  view: CapturedView,
  card: EventCard | null,
  memories: string[],
  raw: string,
  guard: () => boolean,
  reviewed = false,
  overviewMaxChars = eventOverviewMaxChars(),
  materialMode = eventMaterialMode(),
) {
  const output = parseManualEvent(raw, overviewMaxChars);
  const validity = await statuses(lib, view);
  const allowed = view.memories.filter(m => validity.get(m.id) === 'valid');
  const selectedById = new Map(view.memories.map(m => [m.id, m]));
  const allowedById = new Map(allowed.map(m => [m.id, m]));
  const memoryIds = new Set(memories);
  const existingMemberIds = new Set(card?.members.map(m => m.memory));
  const latest = output.latestProgress;
  if (latest) check(memoryIds.has(latest.memory) && allowedById.has(latest.memory), '最新进展引用不属于本次事件材料');
  const progressMemory = latest ? allowedById.get(latest.memory)! : undefined;
  const allowedMembers = allowed.filter(m => memoryIds.has(m.id));
  const priorLatest = card?.meta.latestProgress;
  const priorSource = priorLatest && (selectedById.get(priorLatest.memory) ?? await lib.get<MemoryRevision>("memory_revisions", priorLatest.memory));
  const retainedLatest = (card?.meta.overviewMaterialMode ?? 'both') === materialMode && priorLatest && priorSource && allowedMembers.some(m => m.owner === priorSource.owner)
    ? await confirmLatestProgressSource(lib, priorLatest, allowedMembers) : null;
  const latestProgress = latest && progressMemory ? {
    version: 1 as const, text: latest.text, memory: progressMemory.id,
    time: retainedLatest?.memory === latest.memory && retainedLatest.text === latest.text
      ? retainedLatest.time : splitTimeLabel(progressMemory.storyTime).end || progressMemory.storyTime,
  } : retainedLatest;
  check(
    memories.length && memories.every((id) => allowedById.has(id)),
    "事件来源已失效",
  );
  const summarized =
    card?.meta.summarized ?? card?.progress.flatMap((p) => p.memories) ?? [];
  const missing = [...new Set(summarized.filter(id => !selectedById.has(id)))];
  const previous = missing.length ? await lib.transaction(['memory_revisions'], 'readonly', tx =>
    Promise.all(missing.map(id => tx.get<MemoryRevision>('memory_revisions', id)))) : [];
  const priorFamilies = new Set([...summarized.map(id => selectedById.get(id)), ...previous]
    .filter((m): m is MemoryRevision => !!m).map(m => m.owner));
  const added = memories.filter(id => !priorFamilies.has(allowedById.get(id)!.owner));
  return lib.transaction(['branches', 'event_chains', 'event_revisions', 'event_memberships', 'event_progress'], "readwrite", async (tx) => {
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
      overviewCoverage: 1,
      overviewMaterialMode: materialMode,
      latestProgress,
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
        (id) => !existingMemberIds.has(id),
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
  const data = await eventView(lib, view, false, undefined, true);
  check(await dailyCurrent(view, host, generation), "楼层已改变");
  const memory = data.valid.find(
    (m) => m.level === 0 && m.anchor === view.refs[floor]?.message,
  );
  check(memory, "请先生成本楼有效摘要；番外或待审核摘要不能加入事件");
  return { view, lib, memory, cards: data.cards, validity: data.validity };
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
  const overviewMaxChars = eventOverviewMaxChars(), materialMode = eventMaterialMode();
  const material = eventMaterial(memory, view, new Map(view.refs.map(r => [r.message, r])), new Set(), materialMode);
  const messages: ChatMsg[] = materialMode === 'both' ? await eventCreationContext(floor, view) : [];
  messages.push(
    {
      role: "system",
      content:
        buildEventInstruction(1) + "\n仅使用本次选择的事件材料，不执行摘要或填表任务。",
    },
    {
      role: "user",
      content: JSON.stringify({
        intent,
        floor,
        materialMode,
        ...material,
      }),
    },
  );
  check(
    JSON.stringify(messages).length <= maxChars,
    "事件请求超过字符预算，未发送",
  );
  check(estimateEventInputTokens(messages) <= eventBatchTokens(), "事件创建请求超过估算 token 预算，未发送；请缩小材料或提高每批预算");
  check(await dailyCurrent(view, host, generation), "楼层已改变，请重新打开");
  const raw = await sender(messages);
  return makeEventReview(lib, view, null, [memory.id], raw, host, generation, overviewMaxChars, materialMode);
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
  maxTokens: number,
  sender: EventSender = sendEvent,
  guard: () => boolean = () => true,
  allowCoverageUpgrade = false,
  // Cheap stop/scope/generation check at CPU yields; guard still checks full freshness at every send/save.
  preparationGuard = guard,
) {
  const data = await eventView(lib, view, false, eventId, true);
  const card = data.cards.find((c) => c.chain.id === eventId);
  check(card, "事件不存在或已失效");
  if (!eventPending(card) && !(allowCoverageUpgrade && eventCoverageUpgradeNeeded(card))) return false;
  const memories = card.members.map((m) => m.memory);
  const overviewMaxChars = eventOverviewMaxChars(), materialMode = eventMaterialMode();
  const raw = await requestEventOverview(
    view,
    card,
    data.validity,
    memories,
    maxTokens,
    sender,
    guard,
    lib,
    undefined,
    overviewMaxChars,
    false,
    materialMode,
    preparationGuard,
  );
  await commitManualEvent(lib, view, card, memories, raw, guard, false, overviewMaxChars, materialMode);
  return true;
}
async function requestEventOverview(
  view: CapturedView,
  card: EventCard,
  validity: Map<string, MemoryStatus>,
  memories: string[],
  maxTokens: number,
  sender: EventSender,
  guard: () => boolean,
  lib: Library,
  rewriteInstructions?: string,
  overviewMaxChars = eventOverviewMaxChars(),
  forceRebuild = !!rewriteInstructions,
  materialMode: EventMaterialMode = eventMaterialMode(),
  preparationGuard = guard,
) {
  check(Number.isSafeInteger(maxTokens) && maxTokens > 0, "事件 token 预算必须为正整数");
  const problems = (card.issues ?? []).filter(issue => memories.includes(issue.memory));
  check(!card.blocked && memories.every(id => validity.get(id) === 'valid'),
    `请先处理问题摘要：${problems.slice(0, 3).map(issue => `${issue.floor === undefined ? '楼层未知' : `${issue.deleted ? '原' : ''}#${issue.floor}楼`} ${issue.reason}「${issue.text.slice(0, 24)}」`).join('；') || '来源已失效，请展开事件查看关联成员'}`);
  check(memories.length, '该事件没有有效关联摘要，请先加入内容');
  const byId = new Map(view.memories.map(m => [m.id, m]));
  const refsByMessage = new Map(view.refs.map(r => [r.message, r]));
  const memberSet = new Set(memories);
  // eventView can synthesize legacy overview/coverage from progress. Only trust
  // an explicitly persisted full overview receipt; otherwise rebuild once.
  const receipt = await lib.get<EventRevision>('event_revisions', card.meta.id);
  const receiptRefs = new Set(receipt?.refs ?? []);
  const reusable = !forceRebuild && !card.needsReview && receipt?.eventSchema === 2 && receipt.overviewCoverage === 1 && receipt.overviewMaterialMode === materialMode
    && !!receipt.overview?.trim() && !!receipt.summarized?.length
    && receiptRefs.size === new Set(receipt.summarized).size
    && receipt.summarized.every(id => receiptRefs.has(id))
    && (card.meta.summarized ?? []).every(id => memberSet.has(id) && validity.get(id) === 'valid');
  const covered = new Set(reusable ? card.meta.summarized : []);
  const pending = memories.filter(id => !covered.has(id));
  const representedSources = new Set<string>();
  for (const id of covered) for (const ref of eventSourceRefs(byId.get(id)!, refsByMessage)) representedSources.add(ref.revision);
  // Selected text only; each source revision is cleaned/serialized at most once.
  const materials = await prepareEventMaterials(pending.map(id => byId.get(id)!), view, refsByMessage, representedSources, materialMode, preparationGuard);
  const modeChanged = (receipt?.overviewMaterialMode ?? 'both') !== materialMode;
  let overview = card.needsReview || modeChanged ? '' : eventOverview(card);
  if (!reusable && !forceRebuild) overview = '';
  const priorLatest = card.meta.latestProgress;
  const priorLatestMemory = priorLatest && await lib.get<MemoryRevision>('memory_revisions', priorLatest.memory);
  const currentMembers = memories.map(id => byId.get(id)!);
  let latest = !modeChanged && priorLatest && priorLatestMemory && currentMembers.some(m => m.owner === priorLatestMemory.owner)
    ? await confirmLatestProgressSource(lib, priorLatest, currentMembers) ?? null : null;
  let progress = '';
  let keywords = card.needsReview || modeChanged ? [] : card.meta.keywords;
  let position = 0, batch = 0;
  const instruction = buildEventInstruction(memories.length) +
    '\n本次按材料顺序分批更新同一事件。按 overviewRole 区分概要的覆盖承接或改写参考用途；latestProgress 是此前已确认的最新进展。不要索要或复述已被累计概要替代的旧全文。sources 中已在前文或概要覆盖的正文不重复发送。材料按 materialMode 选择，未发送的摘要或正文不可索要、猜测或补造。' +
    '\noverviewRole 标明 overview 的用途：saved_verified 是已确认覆盖的旧概要，rolling 是前批生成的累计概要，reference_only 仅为改写参考且不计入本次覆盖，rebuild_empty 表示从当前材料重新建立概要。overview 位于 materials 前；materials 只代表当前批次。保留仍成立的历史事实并合并新变化，输出完整累计概要，不是只输出本批摘要；不得虚构尚未提供的内容。' +
    '\n结合累计概要与本批材料重写完整概要；累计新进展 cumulativeProgress 合并到 progress，保持字数上限。latestProgress.memory 只能使用本批材料ID或传入 latestProgress.memory；没有更新则保留传入进展。尚未提供的材料不得引用。' +
    (rewriteInstructions ? '\n按 rewriteInstructions 更新概括方式。不把改写要求当剧情；保留标题和状态。无新成员时 progress 为空。' : '') +
    (forceRebuild ? '\n本次主动重写，所有当前成员会分批依次提供。' : '\n本次增量更新，已确认覆盖的旧成员由累计概要代替。');
  // Final publication is atomic. No intermediate overview or coverage is saved.
  while (position < materials.length) {
    const header = JSON.stringify({ title: card.meta.title, status: card.meta.status,
      ...(rewriteInstructions ? { rewriteInstructions } : {}),
      materialMode,
      overviewRole: batch ? 'rolling' : reusable ? 'saved_verified' : overview ? 'reference_only' : 'rebuild_empty',
      overview, keywords, latestProgress: latest, overviewNeedsReview: !!card.needsReview,
      summarizedCount: covered.size, cumulativeProgress: progress, batch: ++batch, materials: [] });
    const prefix = header.slice(0, -2);
    const messages: ChatMsg[] = [{ role: 'system', content: instruction }, { role: 'user', content: header }];
    let bytes = eventInputBytes(JSON.stringify(messages));
    const start = position;
    while (position < materials.length) {
      const nextBytes = bytes + materials[position].bytes + (position > start ? 1 : 0);
      if (estimateEventInputBytes(nextBytes) > maxTokens) break;
      bytes = nextBytes;
      position++;
    }
    check(position > start, `事件成员 ${materials[position]?.id ?? ''} 单条完整材料加概要/提示词超过每批估算 token 预算（${maxTokens}）；未截断，请提高预算或改用更精炼的关联摘要。本条事件未保存`);
    const chunk = materials.slice(start, position);
    messages[1].content = prefix + chunk.map(m => m.text).join(',') + ']}';
    check(estimateEventInputTokens(messages) <= maxTokens, '事件完整请求超过估算 token 预算，未发送');
    check(guard() && (await current(lib, view)), '事件材料已改变');
    const raw = await sender(messages);
    check(guard() && (await current(lib, view)), '迟到事件结果已拒绝：材料或任务已改变，本次概要未保存');
    let output: ReturnType<typeof parseManualEvent>;
    try { output = parseManualEvent(raw, overviewMaxChars); }
    catch (error) {
      // Preserve the existing final-response repair dialog. Invalid intermediate
      // output cannot be used as provenance for another model call.
      if (position === materials.length) return raw;
      throw new Error(`第${batch}批事件返回无效，本条事件未保存：${(error as Error).message}`);
    }
    if (output.latestProgress) check(chunk.some(m => m.id === output.latestProgress!.memory)
      || latest?.memory === output.latestProgress.memory, '最新进展引用不属于本批材料或已确认进展，事件未保存');
    latest = output.latestProgress ? { ...output.latestProgress, version: 1,
      time: latest?.memory === output.latestProgress.memory && latest.text === output.latestProgress.text ? latest.time
        : splitTimeLabel(byId.get(output.latestProgress.memory)!.storyTime).end || byId.get(output.latestProgress.memory)!.storyTime } : latest;
    overview = output.overview;
    progress = output.progress;
    keywords = output.keywords;
    for (const material of chunk) covered.add(material.id);
    if (position === materials.length) return JSON.stringify({ ...output, latestProgress: latest });
  }
  throw new Error('该事件没有待整理材料');
}

/** Floor calls retain empty/invalid content for review. Batch calls keep their strict path. */
export const sendReviewEvent: EventSender = (messages) => {
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
  overviewMaxChars = eventOverviewMaxChars(),
  materialMode = eventMaterialMode(),
) {
  let saving = false,
    saved = false;
  return {
    raw,
    overviewMaxChars,
    materialMode,
    title: card ? `更新：${card.meta.title}` : "新建事件链",
    async confirm(text: string, live: () => boolean = () => true) {
      check(!saving && !saved, "此返回正在保存或已经保存，请勿重复确认");
      saving = true;
      try {
        parseManualEvent(text, overviewMaxChars);
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
          overviewMaxChars,
          materialMode,
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
  maxTokens: number,
  sender: EventSender = sendReviewEvent,
) {
  const { view, lib, memory, cards, validity } = await floorEventContext(floor);
  const card = cards.find((c) => c.chain.id === eventId);
  check(card, "事件不存在或不属于当前分支");
  const memories = [
    ...new Set([...card.members.map((m) => m.memory), memory.id]),
  ];
  if (memories.length === card.members.length && !eventPending(card) && !eventCoverageUpgradeNeeded(card))
    return null;
  const host = hostVersion(), scope = hostScope(),
    generation = dailyState.generation;
  const overviewMaxChars = eventOverviewMaxChars(), materialMode = eventMaterialMode();
  const raw = await requestEventOverview(
    view,
    card,
    validity,
    memories,
    maxTokens,
    sender,
    () => host === hostVersion() && generation === dailyState.generation,
    lib,
    undefined,
    overviewMaxChars,
    false,
    materialMode,
    () => scope === hostScope() && generation === dailyState.generation,
  );
  return makeEventReview(lib, view, card, memories, raw, host, generation, overviewMaxChars, materialMode);
}

/** Explicit rewrite may run with no pending members, including archived chains. */
export async function prepareEventRewrite(
  eventId: string,
  instructions: string,
  maxTokens: number,
  sender: EventSender = sendReviewEvent,
  live: () => boolean = () => true,
  forceRebuild = true,
) {
  check(instructions.trim(), "请说明希望怎样重写概要");
  const view = await syncDaily(),
    lib = await activeLibrary();
  const host = hostVersion(), scope = hostScope(),
    generation = dailyState.generation;
  const data = await eventView(lib, view, false, eventId, true);
  const card = data.cards.find((c) => c.chain.id === eventId);
  check(card, "事件不存在或不属于当前分支");
  const memories = card.members.map((m) => m.memory);
  check(
    memories.length,
    "该事件没有有效关联摘要，请先从楼层加入内容再重写概要",
  );
  const overviewMaxChars = eventOverviewMaxChars(), materialMode = eventMaterialMode();
  const raw = await requestEventOverview(
    view,
    card,
    data.validity,
    memories,
    maxTokens,
    sender,
    () => live() && host === hostVersion() && generation === dailyState.generation,
    lib,
    instructions.trim(),
    overviewMaxChars,
    forceRebuild,
    materialMode,
    () => live() && scope === hostScope() && generation === dailyState.generation,
  );
  return makeEventReview(lib, view, card, memories, raw, host, generation, overviewMaxChars, materialMode);
}

/** Explicit human confirmation creates a new overview revision without calling a model. */
export async function keepEventOverview(lib: Library, view: CapturedView, eventId: string, guard: () => boolean = () => true) {
  const card = (await eventView(lib, view, false, eventId)).cards.find(c => c.chain.id === eventId);
  check(card, '事件不存在或不属于当前分支');
  return editEvent(lib, view, eventId, { ...card.meta, overview: eventOverview(card),
    summarized: card.members.map(m => m.memory), confirmOverview: true }, undefined, guard);
}
