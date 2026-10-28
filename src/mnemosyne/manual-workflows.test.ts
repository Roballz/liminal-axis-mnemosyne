import "fake-indexeddb/auto";
import { beforeEach, afterEach, test, expect, vi } from "vitest";
import { Library, Transaction, activateLibrary, freshLibraryName } from "./db";
import { bindDaily, syncDaily, invalidateDaily } from "./bridge";
import { memory } from "@/memory/store";
import { createEmptyMemory } from "@/memory/types";
import type { STContext } from "@/st/context";
import { apiSettings } from "@/api/settings";
import { buildEventInstruction, EVENT_OVERVIEW_PROMPT, EVENT_LATEST_PROGRESS_PROMPT, EVENT_OUTPUT_PROTOCOL } from "./event-prompts";
import { eventResponseError } from "./event-response";
import { capture, statuses } from "./canonical";
import { eventView, editEvent, deleteEvent, setEventArchived } from "./events";
import {
  commitManualEvent,
  joinFloorEvent,
  updateEventOverview,
  eventPending,
  parseManualEvent,
  prepareFloorEvent,
  prepareFloorEventUpdate,
  prepareEventRewrite,
  type EventSender,
} from "./manual-events";
import { newTable, saveTable, readTables, applyRows } from "./tables";
import {
  tableLastFloors,
  runTableBackfill,
  stopTableBackfill,
  backfillState,
  TABLE_BACKFILL_MAX_CHARS,
} from "./table-backfill";
import { runEvents, stopDailyJob, settings, jobState } from "./jobs";
import { exportLibrary, restoreLibrary } from "./migration";
import type { Branch, MemoryRevision, Snapshot, TableDef, TableRow } from "./model";
const answer = JSON.stringify({
  title: "一天约会",
  status: "open",
  keywords: ["约会"],
  overview: "早饭、花灯、灯会是同一天约会。",
  progress: "约会有新进展。",
});
let lib: Library, ctx: STContext, dispose: (() => void) | undefined;
const originalEventPrompt = apiSettings.prompts.eventOverview;
const originalLatestPrompt = apiSettings.prompts.eventLatestProgress;
const originalInterval = settings.interval;
beforeEach(async () => {
  apiSettings.prompts.eventOverview = "";
  apiSettings.prompts.eventLatestProgress = "";
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  Object.assign(memory, createEmptyMemory());
  ctx = {
    chat: Array.from({ length: 6 }, (_, i) => ({
      name: i % 2 ? "角色" : "用户",
      is_user: !(i % 2),
      is_system: false,
      mes: `正文细节${i}：${["早餐", "早餐", "做花灯", "做花灯", "逛灯会", "逛灯会"][i]}`,
      extra:
        i % 2
          ? {
              bbs_leaf: {
                id: `leaf${i}`,
                text: `摘要${i}`,
                delta: {},
                createdAt: 1,
                v: 1,
                swipe: 0,
              },
            }
          : {},
    })),
    chatMetadata: {},
    characters: [{ name: "合成角色", avatar: "test.png" }],
    characterId: 0,
    getCurrentChatId: () => "synthetic",
    saveChat: vi.fn().mockResolvedValue(undefined),
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    eventTypes: {},
    eventSource: { on: vi.fn(), off: vi.fn() },
    setExtensionPrompt: vi.fn(),
    name1: "用户",
    name2: "角色",
  } as unknown as STContext;
  vi.stubGlobal("window", { SillyTavern: { getContext: () => ctx } });
  lib = await Library.open(freshLibraryName());
  await activateLibrary(lib);
  dispose = bindDaily();
  settings.eventsEnabled = false;
  settings.overviewMaxChars = 500;
  settings.overviewBatchTokens = 80000;
  settings.overviewMaterialMode = "both";
});
afterEach(() => {
  apiSettings.prompts.eventOverview = originalEventPrompt;
  apiSettings.prompts.eventLatestProgress = originalLatestPrompt;
  settings.interval = originalInterval;
  settings.overviewMaxChars = 1000;
  settings.overviewMaterialMode = "both";
  dispose?.();
  lib.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function chain() {
  const v = await syncDaily();
  return commitManualEvent(
    lib,
    v,
    null,
    [v.memories[0].id],
    answer,
    () => true,
  );
}
test('blocked batch explains skips and explicit update identifies the offending floor', async () => {
  const id = await chain();
  ctx.chat[1].mes += '来源被编辑';
  const sender = vi.fn(async () => answer);
  await runEvents(true, sender);
  expect(sender).not.toHaveBeenCalled();
  expect(jobState.status).toContain('1 条来源异常已跳过');
  expect(jobState.status).toContain('一天约会');
  await expect(updateEventOverview(lib, await syncDaily(), id, 80000, sender)).rejects.toThrow('#1楼');
  expect(sender).not.toHaveBeenCalled();
});
async function table() {
  const v = await syncDaily(),
    def = newTable(v, "约会记录");
  def.ai = false;
  def.columns = [
    {
      id: "detail",
      name: "细节",
      type: "text",
      mode: "append",
      description: "记录细节",
      prompt: "保留地点",
    },
  ];
  await saveTable(lib, v, def);
  return (await lib.get<TableDef>("custom_table_defs", def.id))!;
}
test("manual chain holds three separate floors and joins never call a model or duplicate membership", async () => {
  const id = await chain();
  expect(await joinFloorEvent(3, id)).toBe(true);
  expect(await joinFloorEvent(3, id)).toBe(false);
  expect(await joinFloorEvent(5, id)).toBe(true);
  let v = await syncDaily(),
    card = (await eventView(lib, v)).cards[0];
  expect(card.members).toHaveLength(3);
  expect(eventPending(card)).toBe(true);
  const sender = vi.fn(async (messages) => {
    const prompt = JSON.stringify(messages);
    expect(prompt).toContain("不超过600字");
    expect(prompt).toContain("主动舍弃琐碎小事");
    for (const text of [
      "摘要3",
      "摘要5",
      "正文细节3",
      "正文细节5",
    ])
      expect(prompt).toContain(text);
    expect(prompt).not.toContain("摘要1");
    expect(prompt).not.toContain("正文细节1");
    return answer;
  });
  await updateEventOverview(lib, v, id, 48000, sender);
  v = await syncDaily();
  card = (await eventView(lib, v)).cards[0];
  expect(eventPending(card)).toBe(false);
  expect(await updateEventOverview(lib, v, id, 48000, sender)).toBe(false);
  expect(sender).toHaveBeenCalledTimes(1);
  expect(await lib.all("event_chains")).toHaveLength(1);
  expect(card.progress).toHaveLength(2);
  expect(card.progress[1].memories).toHaveLength(2);
});
test.each([true, false])(
  "batch/automatic routine (manual=%s) uses the custom prompt and only updates selected chains",
  async (manual) => {
    await chain();
    await joinFloorEvent(3, (await lib.all("event_chains"))[0].id);
    apiSettings.prompts.eventOverview = "合成批量规则：强调约定和关系改变。";
    apiSettings.prompts.eventLatestProgress = "合成进展写法：保留关键行动与后续待办。";
    if (!manual) {
      settings.interval = 1;
      ctx.chat.push(
        {
          name: "用户",
          is_user: true,
          is_system: false,
          mes: "接下来呢",
          extra: {},
        },
        {
          name: "角色",
          is_user: false,
          is_system: false,
          mes: "新的回合",
          extra: {},
        },
      );
    }
    const sender = vi.fn(async (messages: { role: 'system' | 'user' | 'assistant'; content: string }[]) => {
      expect(messages.map(m => m.role)).toEqual(['system', 'user']);
      const prompt = messages.map(m => m.content).join('\n');
      expect(prompt).toContain(apiSettings.prompts.eventOverview);
      expect(prompt).toContain(apiSettings.prompts.eventLatestProgress);
      expect(prompt).not.toContain(EVENT_LATEST_PROGRESS_PROMPT);
      expect(prompt).toContain('"overview"');
      expect(prompt).toContain("不超过600字");
      return answer;
    });
    await runEvents(manual, sender);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await lib.all("event_chains")).toHaveLength(1);
    const card = (await eventView(lib, await syncDaily())).cards[0];
    expect(card.members).toHaveLength(2);
    expect(eventPending(card)).toBe(false);
  },
);
test("custom event writing replaces the default for create/update, blank restores default, output protocol remains", async () => {
  expect(buildEventInstruction()).toContain(EVENT_OVERVIEW_PROMPT.replace('{{overviewTarget}}', '600').replace('{{summaryCount}}', '1'));
  expect(buildEventInstruction()).toContain(EVENT_LATEST_PROGRESS_PROMPT);
  expect(EVENT_LATEST_PROGRESS_PROMPT).toContain('latestProgress.text 不超过100字');
  apiSettings.prompts.eventOverview = "合成自定义：用三句话概括关系转折。";
  apiSettings.prompts.eventLatestProgress = "合成进展：用一句话写新证据和未决点。";
  const createSender = vi.fn(async (messages) => {
    const instruction = messages.find(
      (m: { role: string; content: string }) =>
        m.role === "system" && m.content.includes("事件任务输出约定"),
    ).content;
    expect(instruction).toContain(apiSettings.prompts.eventOverview);
    expect(instruction).toContain(apiSettings.prompts.eventLatestProgress);
    expect(instruction).not.toContain(EVENT_LATEST_PROGRESS_PROMPT);
    expect(instruction).not.toContain("主动舍弃琐碎小事");
    expect(instruction).toContain("不超过600字");
    expect(instruction).toContain('"progress"');
    expect(instruction).toContain(EVENT_OUTPUT_PROTOCOL);
    expect(instruction).toContain('progress 不超过80字');
    expect(instruction).toContain('100字以内的最新进展小结');
    return answer;
  });
  const draft = await prepareFloorEvent(1, "整天约会", 200000, createSender);
  const id = await draft.confirm(draft.raw);
  await joinFloorEvent(3, id);
  apiSettings.prompts.eventOverview = "合成新规则：重点交代承诺和兑现。";
  apiSettings.prompts.eventLatestProgress = "合成新进展规则：突出关键决定和结果。";
  const updateSender = vi.fn(async (messages) => {
    expect(messages[0].content).toContain(apiSettings.prompts.eventOverview);
    expect(messages[0].content).toContain(apiSettings.prompts.eventLatestProgress);
    expect(messages[0].content).not.toContain('用一句话写新证据');
    expect(messages[0].content).not.toContain("用三句话");
    expect(messages[0].content).toContain("不超过600字");
    return answer;
  });
  await updateEventOverview(lib, await syncDaily(), id, 48000, updateSender);
  expect(createSender).toHaveBeenCalledTimes(1);
  expect(updateSender).toHaveBeenCalledTimes(1);
  apiSettings.prompts.eventOverview = " \n ";
  apiSettings.prompts.eventLatestProgress = " \n ";
  expect(buildEventInstruction()).toContain(EVENT_OVERVIEW_PROMPT.replace('{{overviewTarget}}', '600').replace('{{summaryCount}}', '1'));
  expect(buildEventInstruction()).toContain(EVENT_LATEST_PROGRESS_PROMPT);
});
test("stopping an overview request does not publish late output or lose queued members", async () => {
  const id = await chain();
  await joinFloorEvent(3, id);
  await runEvents(true, async () => {
    stopDailyJob();
    return answer;
  });
  expect(
    (await eventView(lib, await syncDaily())).cards[0].meta.summarized,
  ).toHaveLength(1);
  expect(await lib.all("event_progress")).toHaveLength(1);
});
test("archiving during an overview request preserves the archive flag and still commits the overview", async () => {
  const id = await chain();
  await joinFloorEvent(3, id);
  const view = await syncDaily();
  await updateEventOverview(lib, view, id, 48000, async () => {
    await setEventArchived(lib, view, id, true);
    return answer;
  });
  const card = (await eventView(lib, await syncDaily())).cards[0];
  expect(card.chain.archived).toBe(true);
  expect(eventPending(card)).toBe(false);
  expect(card.members).toHaveLength(2);
});
test("manual create uses native summary materials without changing summaries", async () => {
  const before = ctx.chat[1].extra!.bbs_leaf;
  const sender = vi.fn(async (messages) => {
    const p = JSON.stringify(messages);
    expect(p).toContain("正文细节1");
    expect(p).toContain("把这一天当成一个整体");
    expect(p).toContain("不超过600字");
    expect(p).toContain("对人物关系或重要转变有实质影响");
    return answer;
  });
  const draft = await prepareFloorEvent(
    1,
    "把这一天当成一个整体",
    200000,
    sender,
  );
  expect(await lib.all("event_chains")).toHaveLength(0);
  await draft.confirm(draft.raw);
  expect(sender).toHaveBeenCalledTimes(1);
  expect(ctx.chat[1].extra!.bbs_leaf).toBe(before);
  expect(await lib.all("event_chains")).toHaveLength(1);
});
test.each(["", '{"title":"半截', '{"title":invalid}', "{}", answer])(
  "manual response %j reaches review without event writes; corrections are validated locally and saved once",
  async (raw) => {
    const sender = vi.fn(async () => raw);
    const review = await prepareFloorEvent(1, "整天约会", 200000, sender);
    expect(review.raw).toBe(raw);
    expect(await lib.all("event_chains")).toHaveLength(0);
    expect(await lib.all("event_memberships")).toHaveLength(0);
    await expect(review.confirm('{"title":"不完整"}')).rejects.toThrow(
      "status",
    );
    expect(await lib.all("event_chains")).toHaveLength(0);
    const corrected = JSON.stringify({
      ...JSON.parse(answer),
      title: "人工校正标题",
      status: "resolved",
    });
    const first = review.confirm(corrected);
    await expect(review.confirm(corrected)).rejects.toThrow("重复确认");
    const id = await first;
    await expect(review.confirm(corrected)).rejects.toThrow("重复确认");
    const card = (await eventView(lib, await syncDaily())).cards[0];
    expect(card.chain.id).toBe(id);
    expect(card.meta.title).toBe("人工校正标题");
    expect(card.meta.status).toBe("resolved");
    expect(card.members).toHaveLength(1);
    expect(card.progress).toHaveLength(1);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(review.raw).toBe(raw);
  },
);
test("review diagnoses empty, truncated, syntax, duplicate and field errors without weakening strict validation", () => {
  expect(eventResponseError(" ")).toContain("返回正文为空");
  expect(eventResponseError('{"title":"unfinished')).toContain("疑似输出截断");
  expect(eventResponseError('{\n title: "bad"}')).toContain("第 2 行");
  expect(eventResponseError('{"title":"a","title":"b"}')).toContain(
    "重复字段 title",
  );
  expect(eventResponseError("[]")).toContain("最外层");
  for (const [field, value] of [
    ["status", "已结束"],
    ["keywords", "约会"],
    ["overview", null],
    ["progress", []],
  ])
    expect(
      eventResponseError(
        JSON.stringify({ ...JSON.parse(answer), [field as string]: value }),
      ),
    ).toContain(field);
  expect(
    eventResponseError(
      JSON.stringify({ ...JSON.parse(answer), overview: "字".repeat(501) }),
    ),
  ).toContain("500字");
  expect(parseManualEvent("  ```json\n" + answer + "\n```  ").title).toBe(
    "一天约会",
  );
});
test("immediate update stages membership, includes all pending bodies, and publishes only after review", async () => {
  const id = await chain();
  await joinFloorEvent(3, id);
  const before = await lib.all("event_revisions");
  const sender = vi.fn(async (messages) => {
    const prompt = JSON.stringify(messages);
    for (const floor of [3, 5]) expect(prompt).toContain(`正文细节${floor}`);
    expect(prompt).not.toContain("正文细节1");
    return '{"overview":"bad';
  });
  const review = (await prepareFloorEventUpdate(5, id, 48000, sender))!;
  expect(review.raw).toContain("bad");
  expect(await lib.all("event_revisions")).toEqual(before);
  expect(await lib.all("event_memberships")).toHaveLength(2);
  await expect(review.confirm(review.raw)).rejects.toThrow("JSON");
  expect(await lib.all("event_memberships")).toHaveLength(2);
  await review.confirm(answer);
  const card = (await eventView(lib, await syncDaily())).cards[0];
  expect(card.members).toHaveLength(3);
  expect(eventPending(card)).toBe(false);
  expect(card.progress).toHaveLength(2);
  expect(card.progress[1].memories).toHaveLength(2);
  expect(await prepareFloorEventUpdate(5, id, 48000, sender)).toBeNull();
  expect(sender).toHaveBeenCalledTimes(1);
});
test("discarded update and stale create reviews cannot publish or call the model again", async () => {
  const id = await chain();
  const discarded = await prepareFloorEventUpdate(
    3,
    id,
    48000,
    async () => answer,
  );
  expect(discarded).not.toBeNull();
  expect(await lib.all("event_memberships")).toHaveLength(1);
  const review = await prepareFloorEvent(
    5,
    "另一个事件",
    200000,
    async () => answer,
  );
  ctx.chat[5].mes = "审阅期间改写正文";
  await expect(review.confirm(answer)).rejects.toThrow("已改变");
  expect(await lib.all("event_chains")).toHaveLength(1);
  expect(await lib.all("event_revisions")).toHaveLength(1);
});
test("a valid reply can still be inspected after an in-flight host change but cannot be committed", async () => {
  const review = await prepareFloorEvent(1, "整天约会", 200000, async () => {
    ctx.getCurrentChatId = () => "other-chat";
    return answer;
  });
  expect(review.raw).toBe(answer);
  await expect(review.confirm(answer)).rejects.toThrow("已改变");
  expect(await lib.all("event_chains")).toHaveLength(0);
});
test("explicit rewrite works for an archived fully summarized chain, sends instructions and bodies, then waits for confirmation", async () => {
  const id = await chain();
  await setEventArchived(lib, await syncDaily(), id, true);
  const before = (await eventView(lib, await syncDaily())).cards[0];
  expect(eventPending(before)).toBe(false);
  apiSettings.prompts.eventOverview = "合成自定义写法";
  apiSettings.prompts.eventLatestProgress = "合成重写进展：突出未完成的约定。";
  const output = JSON.stringify({
    ...JSON.parse(answer),
    overview: "改写后的核心关系变化",
    progress: "",
  });
  const sender = vi.fn(async (messages) => {
    const body = JSON.parse(messages.at(-1).content);
    expect(body.overviewRole).toBe("reference_only"); expect(body.summarizedCount).toBe(0);
    const prompt = JSON.stringify(messages);
    for (const part of [
      "合成自定义写法",
      apiSettings.prompts.eventLatestProgress,
      "突出承诺，别逐站罗列",
      "正文细节1",
      before.meta.overview!,
    ])
      expect(prompt).toContain(part);
    return output;
  });
  const review = await prepareEventRewrite(
    id,
    "突出承诺，别逐站罗列",
    48000,
    sender,
  );
  expect((await eventView(lib, await syncDaily())).cards[0].meta.id).toBe(
    before.meta.id,
  );
  expect(await lib.all("event_revisions")).toHaveLength(1);
  await review.confirm(review.raw);
  const after = (await eventView(lib, await syncDaily())).cards[0];
  expect(after.chain.id).toBe(id);
  expect(after.chain.archived).toBe(true);
  expect(after.meta.overview).toBe("改写后的核心关系变化");
  expect(after.members).toEqual(before.members);
  expect(after.progress).toEqual(before.progress);
  expect(await lib.all("event_revisions")).toHaveLength(2);
  expect(sender).toHaveBeenCalledTimes(1);
});
test("rewrite without instructions, valid members or sufficient budget does not send a request", async () => {
  const id = await chain(),
    sender = vi.fn(async () => answer);
  await expect(prepareEventRewrite(id, " ", 48000, sender)).rejects.toThrow(
    "说明",
  );
  await expect(prepareEventRewrite(id, "简洁", 1, sender)).rejects.toThrow(
    "预算",
  );
  const empty = await editEvent(lib, await syncDaily(), null, {
    title: "空链",
    status: "open",
    keywords: [],
  });
  await expect(
    prepareEventRewrite(empty, "简洁", 48000, sender),
  ).rejects.toThrow("没有有效关联摘要");
  expect(sender).not.toHaveBeenCalled();
});
test("append progress accepts 100 characters, rejects 101 before saving and still permits empty rewrites", async () => {
  const progress = '进'.repeat(99) + '🌸';
  const output = (text: string) => JSON.stringify({ ...JSON.parse(answer), progress: text });
  const view = await syncDaily();
  await expect(commitManualEvent(lib, view, null, [view.memories[0].id], output(progress + '超'), () => true)).rejects.toThrow('最多100字');
  expect(await lib.all('event_chains')).toHaveLength(0);
  const id = await commitManualEvent(lib, view, null, [view.memories[0].id], output(progress), () => true);
  expect((await lib.all<any>('event_progress'))[0].text).toBe(progress);
  await joinFloorEvent(3, id);
  const pending = await syncDaily(), before = await lib.all('event_revisions');
  await expect(updateEventOverview(lib, pending, id, 48000, async () => output(progress + '超'))).rejects.toThrow('最多100字');
  expect(await lib.all('event_revisions')).toEqual(before);
  expect(await lib.all('event_progress')).toHaveLength(1);
  await updateEventOverview(lib, pending, id, 48000, async () => output(''));
  expect(eventPending((await eventView(lib, await syncDaily())).cards[0])).toBe(false);
  expect(await lib.all('event_progress')).toHaveLength(1);
});
test("overview limit accepts 500 Unicode characters and rejects overlong creation/update without publishing", async () => {
  const atLimit = "核".repeat(499) + "🌸";
  const output = (overview: string) =>
    JSON.stringify({ ...JSON.parse(answer), overview });
  const view = await syncDaily();
  await expect(
    commitManualEvent(
      lib,
      view,
      null,
      [view.memories[0].id],
      output(atLimit + "。"),
      () => true,
    ),
  ).rejects.toThrow("500字");
  expect(await lib.all("event_chains")).toHaveLength(0);
  expect(await lib.all("event_revisions")).toHaveLength(0);
  expect(parseManualEvent(output("  " + atLimit + "  ")).overview).toBe(
    atLimit,
  );
  const id = await commitManualEvent(
    lib,
    view,
    null,
    [view.memories[0].id],
    output(atLimit),
    () => true,
  );
  await joinFloorEvent(3, id);
  const pending = await syncDaily();
  const before = await lib.all("event_revisions");
  await expect(
    updateEventOverview(lib, pending, id, 48000, async () =>
      output(atLimit + "。"),
    ),
  ).rejects.toThrow("500字");
  expect(await lib.all("event_revisions")).toEqual(before);
  expect(await lib.all("event_progress")).toHaveLength(1);
  let card = (await eventView(lib, await syncDaily())).cards[0];
  expect(card.meta.overview).toBe(atLimit);
  expect(card.members).toHaveLength(2);
  expect(eventPending(card)).toBe(true);
  await updateEventOverview(lib, pending, id, 48000, async () =>
    output(atLimit),
  );
  card = (await eventView(lib, await syncDaily())).cards[0];
  expect(eventPending(card)).toBe(false);
  expect(card.meta.overview).toBe(atLimit);
});
test("manual overview edits enforce the limit while legacy long overviews still allow membership changes", async () => {
  const view = await syncDaily();
  await expect(
    editEvent(lib, view, null, {
      title: "过长",
      status: "open",
      keywords: [],
      overview: "字".repeat(501),
    }),
  ).rejects.toThrow("500字");
  const id = await chain();
  // Simulate a pre-limit imported overview; there is no automatic migration/truncation.
  const revision = (await lib.all("event_revisions", "owner", id))[0];
  const legacy = { ...revision, overview: "旧".repeat(700) };
  await lib.transaction(["event_revisions"], "readwrite", (tx) =>
    tx.put("event_revisions", legacy),
  );
  await joinFloorEvent(3, id);
  let current = await syncDaily();
  let card = (await eventView(lib, current)).cards[0];
  expect(card.meta.overview).toHaveLength(700);
  await expect(
    editEvent(lib, current, id, { ...card.meta, overview: "字".repeat(501) }),
  ).rejects.toThrow("500字");
  await editEvent(lib, current, id, card.meta, {
    memory: card.members[1].memory,
    active: false,
    kind: "progress",
  });
  current = await syncDaily();
  card = (await eventView(lib, current)).cards[0];
  expect(card.members).toHaveLength(1);
  expect(card.meta.overview).toHaveLength(700);
  await editEvent(lib, current, id, {
    ...card.meta,
    overview: "核".repeat(500),
  });
  expect(
    (await eventView(lib, await syncDaily())).cards[0].meta.overview,
  ).toHaveLength(500);
});
test("bad model output and a switched chat leave overview pending", async () => {
  const id = await chain();
  await joinFloorEvent(3, id);
  const view = await syncDaily();
  await expect(
    updateEventOverview(lib, view, id, 48000, async () => "{}"),
  ).rejects.toThrow("标题");
  let current = true;
  await expect(
    updateEventOverview(
      lib,
      view,
      id,
      48000,
      async () => {
        current = false;
        return answer;
      },
      () => current,
    ),
  ).rejects.toThrow("迟到");
  expect(await lib.all("event_progress")).toHaveLength(1);
  expect(() => parseManualEvent('{"title":"x","status":"madeup"}')).toThrow(
    "状态",
  );
});
test("manual overview edits retain history; removing membership retains dependent overview for review; delete removes only selected chain", async () => {
  const id = await chain();
  let view = await syncDaily();
  const other = await editEvent(lib, view, null, {
    title: "另一个事件",
    status: "open",
    keywords: [],
  });
  view = await syncDaily();
  const card = (await eventView(lib, view)).cards.find(
    (c) => c.chain.id === id,
  )!;
  await editEvent(lib, view, id, { ...card.meta, overview: "人工概要" });
  view = await syncDaily();
  expect(
    (await eventView(lib, view)).cards.find((c) => c.chain.id === id)!.meta
      .overview,
  ).toBe("人工概要");
  await editEvent(
    lib,
    view,
    id,
    { ...card.meta },
    { memory: card.members[0].memory, active: false, kind: "progress" },
  );
  view = await syncDaily();
  expect(
    (await eventView(lib, view)).cards.find((c) => c.chain.id === id)!.meta
      .overview,
  ).toBe(JSON.parse(answer).overview);
  expect((await eventView(lib, view)).cards.find(c => c.chain.id === id)!.needsReview).toBe(true);
  await deleteEvent(lib, view, id);
  expect(await lib.all("event_revisions", "owner", id)).toHaveLength(0);
  expect(await lib.all("event_memberships", "owner", id)).toHaveLength(0);
  expect(await lib.all("event_progress", "owner", id)).toHaveLength(0);
  expect(await lib.get("event_chains", other)).toBeDefined();
  expect(await lib.all("memory_revisions")).toHaveLength(3);
});
test("manual backfill runs while automatic filling is disabled, sends original detail not summaries and persists progress", async () => {
  const def = await table();
  const sender = vi.fn(async (messages) => {
    const prompt = JSON.stringify(messages);
    expect(prompt).toContain("正文细节0");
    expect(prompt).toContain("正文细节3");
    expect(prompt).not.toContain("摘要1");
    expect(prompt).toContain("已有内容不另建");
    return JSON.stringify({
      customTables: [
        { table_id: def.id, add: [{ detail: "早餐与花灯" }], update: [] },
      ],
    });
  });
  await runTableBackfill([{ table: def.id, start: 0, end: 3 }], 96000, sender);
  expect(sender).toHaveBeenCalledTimes(1);
  const v = await syncDaily(),
    progress = await tableLastFloors(lib, v.branch);
  expect(progress.floors[def.id]).toBe(3);
  expect(progress.total).toBe(6);
  expect(
    (await lib.all<TableRow>("custom_table_rows"))[0].bodySources,
  ).toHaveLength(4);
  expect((await lib.get<TableDef>("custom_table_defs", def.id))!.ai).toBe(
    false,
  );
  const pack = await exportLibrary(lib);
  expect(pack.version).toBe(15);
  const restored = await restoreLibrary(pack, false);
  expect(
    (await restored.all<TableRow>("custom_table_rows"))[0].bodySources,
  ).toHaveLength(4);
  restored.close();
});
test("no-change overlap keeps row count and advances confirmed range without rewriting existing append text", async () => {
  const def = await table();
  const empty = JSON.stringify({
    customTables: [{ table_id: def.id, add: [], update: [] }],
  });
  await runTableBackfill(
    [{ table: def.id, start: 0, end: 3 }],
    96000,
    async () => empty,
  );
  await runTableBackfill(
    [{ table: def.id, start: 2, end: 5 }],
    96000,
    async () => empty,
  );
  expect(await lib.all("custom_table_rows")).toHaveLength(0);
  expect(
    (await tableLastFloors(lib, (await syncDaily()).branch)).floors[def.id],
  ).toBe(5);
  expect(await lib.all("table_receipts")).toHaveLength(2);
});
test("backfill stop or malformed response cannot advance progress", async () => {
  const def = await table();
  const ranges = [{ table: def.id, start: 0, end: 3 }];
  await runTableBackfill(ranges, 96000, async () => {
    stopTableBackfill();
    return "{}";
  });
  expect(await lib.all("table_receipts")).toHaveLength(0);
  await expect(
    runTableBackfill(ranges, 96000, async () => "{}"),
  ).rejects.toThrow("customTables");
  expect(await lib.all("table_receipts")).toHaveLength(0);
});
test("editing backfilled source invalidates raw dependent table rows and last floor evidence", async () => {
  const def = await table();
  await runTableBackfill(
    [{ table: def.id, start: 0, end: 3 }],
    96000,
    async () =>
      JSON.stringify({
        customTables: [
          { table_id: def.id, add: [{ detail: "旧正文事实" }], update: [] },
        ],
      }),
  );
  ctx.chat[0].mes = "改变后的正文";
  invalidateDaily();
  const v = await syncDaily();
  expect(await readTables(lib, v.branch)).toHaveLength(0); // Table creation also lies after the rewritten source prefix.
  expect((await tableLastFloors(lib, v.branch)).floors[def.id]).toBeUndefined();
});
test("backfill rejects late response after host change and invalid floor ranges before paying", async () => {
  const def = await table(),
    sender = vi.fn(async () => "{}");
  await expect(
    runTableBackfill([{ table: def.id, start: -1, end: 4 }], 96000, sender),
  ).rejects.toThrow("范围");
  expect(sender).not.toHaveBeenCalled();
  await expect(
    runTableBackfill([{ table: def.id, start: 0, end: 3 }], 96000, async () => {
      ctx.chat[0].mes = "请求中变更";
      return "{}";
    }),
  ).rejects.toThrow("迟到");
  expect(await lib.all("table_receipts")).toHaveLength(0);
});

test("hiding and showing a backfilled row preserves provenance; explicit content edits can replace it", async () => {
  const def = await table();
  await runTableBackfill(
    [{ table: def.id, start: 0, end: 1 }],
    96000,
    async () =>
      JSON.stringify({
        customTables: [
          { table_id: def.id, add: [{ detail: "旧事实" }], update: [] },
        ],
      }),
  );
  const record = (await lib.all<TableRow>("custom_table_rows"))[0];
  for (const hidden of [true, false])
    await applyRows(
      lib,
      await syncDaily(),
      def,
      [{ row_id: record.id, values: {}, hidden }],
      false,
    );
  expect(
    (await lib.get<TableRow>("custom_table_rows", record.id))!.bodySources,
  ).toHaveLength(2);
  await applyRows(
    lib,
    await syncDaily(),
    def,
    [{ row_id: record.id, values: { detail: "人工确认事实" } }],
    false,
  );
  expect(
    (await lib.get<TableRow>("custom_table_rows", record.id))!.bodySources,
  ).toHaveLength(0);
});
test("event overview and pending membership survive v4 export/restore and reject malformed raw receipts", async () => {
  const id = await chain();
  await joinFloorEvent(3, id);
  const pack = await exportLibrary(lib),
    restored = await restoreLibrary(pack, false);
  const cards = (
    await eventView(
      restored,
      await capture(restored, (await syncDaily()).branch.id),
    )
  ).cards;
  expect(cards[0].meta.overview).toContain("早饭");
  expect(eventPending(cards[0])).toBe(true);
  restored.close();
  const def = await table();
  await runTableBackfill(
    [{ table: def.id, start: 0, end: 1 }],
    96000,
    async () =>
      JSON.stringify({
        customTables: [{ table_id: def.id, add: [], update: [] }],
      }),
  );
  const corrupt = await exportLibrary(lib);
  (corrupt.data.table_receipts[0] as any).end = 999;
  await expect(restoreLibrary(corrupt, false)).rejects.toThrow("范围非法");
});
test("a failed table batch does not undo a previously committed table or advance the failed table", async () => {
  const one = await table(),
    two = await table();
  let calls = 0;
  await expect(
    runTableBackfill(
      [
        { table: one.id, start: 0, end: 1 },
        { table: two.id, start: 2, end: 3 },
      ],
      96000,
      async () => {
        if (++calls === 2) throw new Error("模拟 API 失败");
        return JSON.stringify({
          customTables: [{ table_id: one.id, add: [], update: [] }],
        });
      },
    ),
  ).rejects.toThrow("模拟 API 失败");
  const progress = await tableLastFloors(lib, (await syncDaily()).branch);
  expect(progress.floors[one.id]).toBe(1);
  expect(progress.floors[two.id]).toBeUndefined();
});

test.each(['', '{"customTables":', '{"customTables":[]}'])('joint backfill retains invalid raw output (%s); hand correction commits both tables without another request', async raw => {
  const one = await table(), two = await table();
  const before = await syncDaily(), memories = await lib.all('memory_revisions');
  const sender = vi.fn(async messages => {
    const user = messages[1].content;
    expect(user.split('正文细节0').length - 1).toBe(1);
    expect(user).toContain(one.id); expect(user).toContain(two.id);
    return raw;
  });
  await runTableBackfill([one,two].map(t => ({ table:t.id,start:0,end:1 })), 96000, sender, 2, () => true, async review => {
    expect(review.raw).toBe(raw); expect(review.validate(raw)).not.toBe('');
    expect(await lib.all('table_receipts')).toHaveLength(0);
    const missing = JSON.stringify({ customTables:[{table_id:one.id,add:[{detail:'手工补充'}],update:[]}] });
    await expect(review.confirm(missing)).rejects.toThrow('完整');
    expect(await lib.all('custom_table_rows')).toHaveLength(0);
    const fixed = JSON.stringify({ customTables:[one,two].map(t => ({table_id:t.id,add:[{detail:'手工补充'}],update:[]})) });
    expect(review.validate(fixed)).toBe(''); await review.confirm(fixed);
    await expect(review.confirm(fixed)).rejects.toThrow('已经保存');
    return true;
  });
  expect(sender).toHaveBeenCalledTimes(1); expect(await lib.all('table_receipts')).toHaveLength(2); expect(await lib.all('custom_table_rows')).toHaveLength(2);
  expect(await lib.all('memory_revisions')).toEqual(memories);
  expect([...await statuses(lib, await capture(lib,before.branch.id))].every(([,s]) => s === 'valid')).toBe(true);
});
test('configured shared batches wait for valid confirmation too; cancelling later batch preserves both tables first batch', async () => {
  const one = await table(), two = await table();
  const raw = JSON.stringify({customTables:[one,two].map(t => ({table_id:t.id,add:[],update:[]}))});
  const sender = vi.fn(async () => raw); let reviews = 0;
  await runTableBackfill([one,two].map(t => ({table:t.id,start:0,end:5})), 96000, sender, 2, () => true, async review => {
    expect(review.validate(review.raw)).toBe('');
    if (++reviews === 2) { expect(await lib.all('table_receipts')).toHaveLength(2); return false; }
    expect(await lib.all('table_receipts')).toHaveLength(0); await review.confirm(review.raw); return true;
  });
  expect(sender).toHaveBeenCalledTimes(2);
  const progress = await tableLastFloors(lib,(await syncDaily()).branch);
  expect(progress.floors[one.id]).toBe(1); expect(progress.floors[two.id]).toBe(1);
  await expect(runTableBackfill([{table:one.id,start:0,end:1}],96000,sender,0)).rejects.toThrow('正整数');
  expect(sender).toHaveBeenCalledTimes(2);
});
function backfillBody(messages: Parameters<EventSender>[0]) {
  return JSON.parse(messages[1].content.split('\n【所选正文，null为番外不填写】\n')[1]) as
    { floor: number; role: string; body: string | null }[];
}

test('backfill fixed batches advance without repeating bodies, reuse archived sources and include newly committed rows', async () => {
  const def = await table();
  await syncDaily(); // Measure an already archived chat; setup reads are not batch work.
  const reads = vi.spyOn(Transaction.prototype, 'get'), committed = vi.fn();
  const floors: number[][] = [];
  const sender = vi.fn(async (messages: Parameters<EventSender>[0]) => {
    floors.push(backfillBody(messages).map(body => body.floor));
    const batch = floors.length;
    for (let previous = 1; previous < batch; previous++)
      expect(messages[1].content).toContain(`已保存批次${previous}`);
    expect(committed).toHaveBeenCalledTimes(batch - 1);
    return JSON.stringify({ customTables: [{ table_id: def.id, add: [{ detail: `已保存批次${batch}` }], update: [] }] });
  });
  await runTableBackfill([{ table: def.id, start: 0, end: 5 }], undefined, sender, 2, () => true, undefined, committed);
  expect(floors).toEqual([[0, 1], [2, 3], [4, 5]]);
  expect(reads.mock.calls.filter(([store]) => store === 'source_revisions' || store === 'source_bodies')).toEqual([]);
  expect(committed.mock.calls.map(([progress]) => progress)).toEqual([
    { tables: [def.id], start: 0, end: 1, completed: 1 },
    { tables: [def.id], start: 2, end: 3, completed: 2 },
    { tables: [def.id], start: 4, end: 5, completed: 3 },
  ]);
  expect(backfillState.completed).toBe(3);
  expect((await lib.all<TableRow>('custom_table_rows')).map(record => record.values.detail).sort())
    .toEqual(['已保存批次1', '已保存批次2', '已保存批次3']);
});

test('backfill rereads foreign summary recovery metadata between batches without an epoch change', async () => {
  const def = await table(), before = await syncDaily(), memoryId = before.memories[0].id;
  const detail = '待人工核对的摘要派生表行';
  await applyRows(lib, before, def, [{ row_id: null, values: { detail } }], false, [memoryId]);
  await syncDaily();
  const other = await Library.open(lib.db.name);
  const raw = JSON.stringify({ customTables: [{ table_id: def.id, add: [], update: [] }] });
  let calls = 0, reviews = 0;
  const sender = vi.fn(async (messages: Parameters<EventSender>[0]) => {
    const batch = calls++;
    expect(backfillBody(messages).map(body => body.floor)).toEqual(batch === 0 ? [0, 1] : [2, 3]);
    if (batch === 0) expect(messages[1].content).toContain(detail);
    else expect(messages[1].content).not.toContain(detail);
    return raw;
  });
  try {
    await runTableBackfill([{ table: def.id, start: 0, end: 3 }], undefined, sender, 2, () => true, async review => {
      await review.confirm(raw);
      if (reviews++ === 0) {
        const branch = await other.get<Branch>('branches', before.branch.id);
        await other.transaction(['memory_revisions'], 'readwrite', async tx => {
          const memory = (await tx.get<MemoryRevision>('memory_revisions', memoryId))!;
          await tx.put('memory_revisions', { ...memory,
            sourceRecovery: { version: 1, reason: 'missing_basis', snapshot: before.snapshot.id },
          } as MemoryRevision);
        });
        expect(await other.get<Branch>('branches', before.branch.id)).toEqual(branch);
      }
      return true;
    });
    expect(sender).toHaveBeenCalledTimes(2);
    expect(backfillState.completed).toBe(2);
    // Filtering model input must preserve the user's stored row and its provenance.
    const record = (await lib.all<TableRow>('custom_table_rows'))[0];
    expect(record.values.detail).toBe(detail);
    expect(record.sources).toEqual([memoryId]);
  } finally { other.close(); }
});

test('backfill exceeding a later batch budget pauses without resizing it and preserves committed progress', async () => {
  ctx.chat[2].mes = '第二批材料甲'.repeat(600);
  ctx.chat[3].mes = '第二批材料乙'.repeat(600);
  const def = await table(), committed = vi.fn();
  const sender = vi.fn(async () => JSON.stringify({
    customTables: [{ table_id: def.id, add: [{ detail: '已保存第0至1楼' }], update: [] }],
  }));
  await expect(runTableBackfill([{ table: def.id, start: 0, end: 5 }], 5000, sender, 2, () => true, undefined, committed))
    .rejects.toThrow('超过预算');
  expect(sender).toHaveBeenCalledTimes(1);
  expect(committed.mock.calls).toEqual([[{ tables: [def.id], start: 0, end: 1, completed: 1 }]]);
  expect(backfillState.completed).toBe(1);
  const budget = backfillState.budget!;
  const body = [2, 3].map(floor => ({ floor, role: ctx.chat[floor].is_user ? 'user' : 'assistant', body: ctx.chat[floor].mes }));
  expect(budget).toMatchObject({ start: 2, end: 3, limitChars: 5000, bodyChars: JSON.stringify(body).length });
  expect(budget.totalChars).toBe(budget.bodyChars + budget.tableChars + budget.instructionChars);
  expect(budget.totalChars).toBeGreaterThan(5000);
  // A one-floor retry would fit, but changing the user's batch is not automatic.
  expect(budget.totalChars - budget.bodyChars + JSON.stringify(body.slice(0, 1)).length).toBeLessThanOrEqual(5000);
  const progress = await tableLastFloors(lib, (await syncDaily()).branch);
  expect(progress.floors[def.id]).toBe(1);
  expect((await lib.all<TableRow>('custom_table_rows'))[0].values.detail).toBe('已保存第0至1楼');
});

test('backfill uses its complete request allowance above 96000 table characters and reports exact material sizes', async () => {
  const def = await table();
  await applyRows(lib, await syncDaily(), def, [{ row_id: null, values: { detail: '合成表内容'.repeat(22000) } }], false);
  const sender = vi.fn(async (messages: Parameters<EventSender>[0]) => {
    const budget = backfillState.budget!;
    expect(budget.tableChars).toBeGreaterThan(96000);
    expect(budget.bodyChars).toBe(JSON.stringify(backfillBody(messages)).length);
    expect(budget.totalChars).toBe(messages.reduce((total, message) => total + message.content.length, 0));
    expect(budget.totalChars).toBe(budget.bodyChars + budget.tableChars + budget.instructionChars);
    expect(budget.limitChars).toBe(TABLE_BACKFILL_MAX_CHARS);
    expect(budget.totalChars).toBeLessThanOrEqual(budget.limitChars);
    return JSON.stringify({ customTables: [{ table_id: def.id, add: [], update: [] }] });
  });
  await runTableBackfill([{ table: def.id, start: 0, end: 1 }], undefined, sender, 2);
  expect(sender).toHaveBeenCalledTimes(1);
});

test.each(['cancel', 'request failure'] as const)('backfill %s cannot report an uncommitted batch as successful', async outcome => {
  const def = await table(), committed = vi.fn();
  const sender = vi.fn(async () => {
    if (outcome === 'request failure') throw new Error('合成请求失败');
    return JSON.stringify({ customTables: [{ table_id: def.id, add: [{ detail: '未确认' }], update: [] }] });
  });
  const job = runTableBackfill([{ table: def.id, start: 0, end: 5 }], undefined, sender, 2, () => true,
    async () => false, committed);
  if (outcome === 'request failure') await expect(job).rejects.toThrow('合成请求失败');
  else await job;
  expect(sender).toHaveBeenCalledTimes(1);
  expect(committed).not.toHaveBeenCalled();
  expect(backfillState.completed).toBe(0);
  expect(await lib.all('custom_table_rows')).toEqual([]);
  expect(await lib.all('table_receipts')).toEqual([]);
});

test('backfill refuses a late confirmation after the archive head changes without a host edit', async () => {
  const def = await table(), before = await syncDaily(), committed = vi.fn();
  const raw = JSON.stringify({ customTables: [{ table_id: def.id, add: [], update: [] }] });
  const sender = vi.fn(async () => raw);
  await expect(runTableBackfill([{ table: def.id, start: 0, end: 1 }], undefined, sender, 2, () => true, async review => {
    await lib.transaction(['branches', 'history_snapshots'], 'readwrite', async tx => {
      const branch = (await tx.get<Branch>('branches', before.branch.id))!;
      const snapshot = (await tx.get<Snapshot>('history_snapshots', branch.head))!;
      const replacement = { ...snapshot, id: `${snapshot.id}-changed-head`, previous: snapshot.id };
      await tx.add('history_snapshots', replacement);
      await tx.put('branches', { ...branch, head: replacement.id, epoch: branch.epoch + 1 });
    });
    await review.confirm(raw);
    return true;
  }, committed)).rejects.toThrow('迟到');
  expect(sender).toHaveBeenCalledTimes(1);
  expect(committed).not.toHaveBeenCalled();
  expect(await lib.all('table_receipts')).toEqual([]);
});

test('backfill rejects a late result after switching to a restored library with identical branch IDs', async () => {
  const def = await table(), committed = vi.fn(), originalName = lib.db.name;
  const restored = await restoreLibrary(await exportLibrary(lib), false);
  const raw = JSON.stringify({ customTables: [{ table_id: def.id, add: [{ detail: '迟到结果' }], update: [] }] });
  const sender = vi.fn(async () => raw);
  try {
    await expect(runTableBackfill([{ table: def.id, start: 0, end: 1 }], undefined, sender, 2, () => true, async review => {
      await activateLibrary(restored);
      await review.confirm(raw);
      return true;
    }, committed)).rejects.toThrow('迟到');
    expect(sender).toHaveBeenCalledTimes(1);
    expect(committed).not.toHaveBeenCalled();
    expect(await restored.all('table_receipts')).toEqual([]);
  } finally {
    lib = await Library.open(originalName);
    await activateLibrary(lib);
    restored.close();
  }
  expect(await lib.all('table_receipts')).toEqual([]);
  expect(backfillState.completed).toBe(0);
});

test('backfill publishes durable progress even if the following projection refresh fails', async () => {
  const def = await table(), committed = vi.fn();
  const bridge = await import('./bridge');
  vi.spyOn(bridge, 'refreshDailyTables').mockRejectedValueOnce(new Error('合成刷新失败'));
  const sender = vi.fn(async () => JSON.stringify({
    customTables: [{ table_id: def.id, add: [{ detail: '已落库' }], update: [] }],
  }));
  await expect(runTableBackfill([{ table: def.id, start: 0, end: 5 }], undefined, sender, 2, () => true, undefined, committed))
    .rejects.toThrow('合成刷新失败');
  expect(sender).toHaveBeenCalledTimes(1);
  expect(committed.mock.calls).toEqual([[{ tables: [def.id], start: 0, end: 1, completed: 1 }]]);
  expect(backfillState.completed).toBe(1);
  expect((await lib.all<TableRow>('custom_table_rows'))[0].values.detail).toBe('已落库');
  expect((await tableLastFloors(lib, (await syncDaily()).branch)).floors[def.id]).toBe(1);
});

test('editing a table while reviewing its response rejects the old response without a second API call', async () => {
  const def = await table(), raw = JSON.stringify({customTables:[{table_id:def.id,add:[],update:[]}]});
  const sender = vi.fn(async () => raw);
  await runTableBackfill([{table:def.id,start:0,end:1}],96000,sender,2,()=>true,async review => {
    const latest = (await readTables(lib,(await syncDaily()).branch))[0].def;
    await saveTable(lib,await syncDaily(),{...latest,name:'改名的自定义表'});
    await expect(review.confirm(raw)).rejects.toThrow('迟到'); return false;
  });
  expect(sender).toHaveBeenCalledTimes(1); expect(await lib.all('table_receipts')).toHaveLength(0);
});

test('all event model paths and independent backfill clean source payloads without changing archives or raw guards', async () => {
  const previous = { start: apiSettings.bodyStartTag, end: apiSettings.bodyEndTag, strip: apiSettings.customStripTags };
  try {
    apiSettings.bodyStartTag = 'globalTime'; apiSettings.bodyEndTag = 'endTime'; apiSettings.customStripTags = ['smalltalk'];
    const time = '2086年04月23日·🌸·星期二·10:49·薄云晴·16°C·{拍摄日}';
    for (const message of ctx.chat) message.mes = `外部前缀<globalTime>${time}</globalTime>${message.mes}<smalltalk>秘密小剧场</smalltalk><endTime>2086/04/23 10:55</endTime>外部尾缀`;
    const view = await syncDaily();
    const archived = JSON.stringify([...view.sources]);
    const refs = JSON.stringify(view.refs);
    const checkMessages = (messages: unknown) => {
      const prompt = JSON.stringify(messages);
      expect(prompt).toContain(time); expect(prompt).toContain('正文细节');
      for (const noise of ['秘密小剧场', '外部前缀', '外部尾缀']) expect(prompt).not.toContain(noise);
    };
    const { prepareEventBatch, commitEventBatch } = await import('./events');
    const batch = (await prepareEventBatch(lib, view, 20, 200000))!;
    checkMessages(batch.prompt);
    // Policy changes alter only model input, never operation identity or raw source refs.
    apiSettings.bodyStartTag = 'unusedStart';
    const sameOperation = (await prepareEventBatch(lib, view, 20, 200000))!;
    expect(sameOperation.operation).toBe(batch.operation);
    apiSettings.bodyStartTag = 'globalTime';
    await commitEventBatch(lib, batch, { decisions: batch.memories.map(m => ({ memory: m.id, result: 'none' })), events: [] });
    expect(await prepareEventBatch(lib, await syncDaily(), 20, 200000)).toBeNull();
    const sender = vi.fn(async messages => { checkMessages(messages); return answer; });
    const draft = await prepareFloorEvent(1, '约会', 200000, sender);
    const id = await draft.confirm(draft.raw);
    await joinFloorEvent(3, id);
    await updateEventOverview(lib, await syncDaily(), id, 200000, sender);
    const rewritten = await prepareEventRewrite(id, '精简', 200000, sender);
    const def = await table();
    await runTableBackfill([{ table: def.id, start: 0, end: 3 }], 200000, async messages => {
      checkMessages(messages); return JSON.stringify({ customTables: [{ table_id: def.id, add: [], update: [] }] });
    });
    const after = await syncDaily();
    expect(JSON.stringify([...after.sources])).toBe(archived);
    expect(JSON.stringify(after.refs)).toBe(refs);
    expect(ctx.chat[1].mes).toContain('秘密小剧场');
    // Even edits solely to stripped text remain raw provenance changes and reject late output.
    ctx.chat[1].mes = ctx.chat[1].mes.replace('秘密小剧场', '已编辑小剧场');
    await syncDaily();
    await expect(rewritten.confirm(rewritten.raw)).rejects.toThrow();
  } finally {
    apiSettings.bodyStartTag = previous.start; apiSettings.bodyEndTag = previous.end; apiSettings.customStripTags = previous.strip;
  }
});


test("discarding a rewrite during its first batch stops subsequent calls and saves nothing", async () => {
  for (const message of ctx.chat) message.mes += "长".repeat(4000);
  const id = await chain();
  await joinFloorEvent(3, id); await joinFloorEvent(5, id);
  const before = await lib.all("event_revisions");
  let live = true;
  const sender = vi.fn(async () => { live = false; return answer; });
  await expect(prepareEventRewrite(id, "突出关键转折", 14000, sender, () => live)).rejects.toThrow("迟到");
  expect(sender).toHaveBeenCalledTimes(1);
  expect(await lib.all("event_revisions")).toEqual(before);
});

test("overview settings are snapshotted through a model request and its review", async () => {
  settings.overviewMaxChars = 1200;
  const text = "核".repeat(1199) + "🌸";
  const output = JSON.stringify({ ...JSON.parse(answer), overview: text });
  const review = await prepareFloorEvent(1, "合成测试", 200000, async messages => {
    expect(JSON.stringify(messages)).toContain("不超过600字");
    expect(JSON.stringify(messages)).not.toContain("不超过1200字");
    settings.overviewMaxChars = 100;
    return output;
  });
  expect(review.overviewMaxChars).toBe(1200);
  await review.confirm(review.raw);
  expect((await eventView(lib, await syncDaily())).cards[0].meta.overview).toBe(text);
});


test("AI update review reuses covered input while explicit rewrite rereads it", async () => {
  const id = await chain(); await joinFloorEvent(3, id);
  const incremental = vi.fn(async messages => {
    const body = JSON.parse(messages.at(-1).content);
    expect(body.materials).toHaveLength(1); expect(body.materials[0].summary).toBe("摘要3");
    expect(JSON.stringify(body)).not.toContain("正文细节1");
    return answer;
  });
  const review = await prepareEventRewrite(id, "保留关键转变", 80000, incremental, () => true, false);
  await review.confirm(review.raw);
  const rewritten = await prepareEventRewrite(id, "主动重新提炼", 80000, async messages => {
    expect(JSON.parse(messages.at(-1)!.content).materials).toHaveLength(2);
    expect(JSON.stringify(messages)).toContain("正文细节1");
    return answer;
  });
  expect(rewritten.raw).toContain("overview");
});

test("automatic run does not migrate unchanged old chains, manual batch explicitly can", async () => {
  const id = await chain();
  const old = (await lib.all<any>("event_revisions"))[0]; delete old.overviewCoverage;
  await lib.transaction(["event_revisions"], "readwrite", tx => tx.put("event_revisions", old));
  settings.interval = 1;
  ctx.chat.push({ name: "用户", is_user: true, is_system: false, mes: "新的无关提问", extra: {} });
  const sender = vi.fn(async () => answer);
  await runEvents(false, sender); expect(sender).not.toHaveBeenCalled();
  await runEvents(true, sender); expect(sender).toHaveBeenCalledTimes(1);
  const card = (await eventView(lib, await syncDaily())).cards[0];
  expect(card.chain.id).toBe(id); expect(card.meta.overviewCoverage).toBe(1);
});

test.each(['summary', 'body', 'both'] as const)("creation %s mode has no excluded text hidden in native context", async mode => {
  settings.overviewMaterialMode = mode;
  ctx.chat[1].mes = 'CREATE_BODY_SENTINEL'; ctx.chat[1].extra!.bbs_leaf!.text = 'CREATE_SUMMARY_SENTINEL';
  ctx.chat[1].extra!.bbs_leaf!.timeStart = '2088/01/02 10:00'; ctx.chat[1].extra!.bbs_leaf!.timeEnd = '2088/01/02 11:00';
  const review = await prepareFloorEvent(1, '建立合成事件', 200000, async messages => {
    const full = JSON.stringify(messages), material = JSON.parse(messages.at(-1)!.content);
    expect(full.includes('CREATE_BODY_SENTINEL')).toBe(mode !== 'summary');
    expect(full.includes('CREATE_SUMMARY_SENTINEL')).toBe(mode !== 'body');
    expect(material.id).toBeTruthy(); expect(material.storyTime).toBe('2088/01/02 10:00 - 2088/01/02 11:00');
    settings.overviewMaterialMode = mode === 'summary' ? 'body' : 'summary';
    return answer;
  });
  expect(review.materialMode).toBe(mode); await review.confirm(review.raw);
  expect((await eventView(lib, await syncDaily())).cards[0].meta.overviewMaterialMode).toBe(mode);
});


test("multi-chain updates do not reload all source bodies after each event-only commit", async () => {
  for (let i = 0; i < 3; i++) { const id = await chain(); await joinFloorEvent(3, id); }
  const initial = await syncDaily(), reads = vi.spyOn(Transaction.prototype, 'get');
  try {
    const sender = vi.fn(async () => answer);
    await runEvents(true, sender);
    expect(sender).toHaveBeenCalledTimes(3);
    expect(reads.mock.calls.filter(([store]) => store === 'source_bodies').length).toBeLessThanOrEqual(initial.refs.length);
    expect((await eventView(lib, await syncDaily())).cards.every(card => !eventPending(card))).toBe(true);
  } finally { reads.mockRestore(); }
});
