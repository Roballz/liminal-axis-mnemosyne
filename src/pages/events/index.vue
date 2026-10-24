<script setup lang="ts">
import Icon from "@/components/Icon.vue";
import { openMemberships, membershipUi } from "@/mnemosyne/event-membership-ui";
import { EVENT_PROGRESS_MAX_CHARS } from '@/memory/limits';
import SummaryReviewPanel from "@/components/SummaryReviewPanel.vue";
import { apiSettings } from "@/api/settings";
import {
  computed,
  onMounted,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from "vue";
import ModalMask from "@/components/ModalMask.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import BbsSelect from "@/components/BbsSelect.vue";
import TableTextField from "@/components/TableTextField.vue";
import EventResponseReview from "@/components/EventResponseReview.vue";
import {
  syncDaily,
  hostScope,
  hostVersion,
  dailyState,
  dailyCurrent,
} from "@/mnemosyne/bridge";
import { activeLibrary } from "@/mnemosyne/db";
import { previewEventResync, commitEventResync, type EventResyncPlan } from "@/mnemosyne/event-resync";
import {
  eventView,
  editEvent,
  deleteEvent,
  setEventArchived,
  eventOverviewLength,
  type EventCard,
} from "@/mnemosyne/events";
import {
  manualEventState,
  eventOverview,
  eventPending,
  eventCoverageUpgradeNeeded,
  keepEventOverview,
  prepareEventRewrite,
  type EventReview,
} from "@/mnemosyne/manual-events";
import {
  settings,
  jobState,
  saveDailySettings,
  runEvents,
  stopDailyJob,
} from "@/mnemosyne/jobs";
import { check, type CapturedView } from "@/mnemosyne/model";
const view = shallowRef<CapturedView | null>(null),
  cards = shallowRef<EventCard[]>([]);
const error = ref(""),
  notice = ref(""),
  busy = ref(false),
  loading = ref(false),
  storedCount = ref(0),
  pages = ref<Record<string, number>>({});
const expandedCards = ref<Record<string, boolean>>({}),
  expandedHistory = ref<Record<string, boolean>>({}),
  expandedMembers = ref<Record<string, boolean>>({});
function setExpanded(event: Event, state: Record<string, boolean>, id: string) {
  if (event.target === event.currentTarget) state[id] = (event.currentTarget as HTMLDetailsElement).open;
}
const editing = ref(false),
  editId = ref<string | null>(null),
  title = ref(""),
  status = ref("open"),
  overview = ref(""),
  latestText = ref(""),
  latestMemory = ref(""),
  keywords = ref("");
const progressSources = computed(() => {
  const card = cards.value.find(c => c.chain.id === editId.value);
  return (card?.members ?? []).flatMap(member => {
    const source = formView?.memories.find(m => m.id === member.memory);
    if (!source) return [];
    const floor = formView!.refs.findIndex(r => r.message === source.anchor);
    return [{ value: source.id, label: `#${floor} ${source.storyTime} ${source.content.slice(0, 40)}` }];
  });
});
const overviewChars = computed(() => eventOverviewLength(overview.value));
const removing = shallowRef<EventCard | null>(null);
const resyncPlan = shallowRef<EventResyncPlan | null>(null);
let resyncHost = "", resyncGeneration = 0, resyncLibrary: Awaited<ReturnType<typeof activeLibrary>> | undefined;
async function previewResync() {
  const captured = validView(), lib = await activeLibrary();
  const host = hostVersion(), generation = dailyState.generation;
  const plan = await previewEventResync(lib, captured);
  check(!disposed && await dailyCurrent(captured, host, generation) && lib === await activeLibrary(), "聊天已改变，请重新预览");
  resyncHost = host; resyncGeneration = generation; resyncLibrary = lib;
  resyncPlan.value = plan;
}
async function confirmResync() {
  const plan = resyncPlan.value, lib = await activeLibrary();
  const live = () => !disposed && resyncPlan.value === plan && scope === hostScope() && resyncHost === hostVersion() && resyncGeneration === dailyState.generation;
  check(plan && live() && lib === resyncLibrary, "聊天已改变，请重新预览");
  const count = await commitEventResync(lib, plan, live);
  if (live()) {
    resyncPlan.value = null;
    notice.value = `已重新继承 ${count} 条父事件链`;
    await refresh();
  }
}
const archiveMode = ref(false),
  archiveMenu = shallowRef<EventCard | null>(null);
const visibleCards = computed(() =>
  cards.value.filter((card) => !!card.chain.archived === archiveMode.value),
);
let pressTimer: ReturnType<typeof setTimeout> | undefined,
  held = false,
  pressX = 0,
  pressY = 0;
function cancelPress() {
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = undefined;
}
function startPress(event: PointerEvent, card: EventCard) {
  cancelPress();
  held = false;
  if (
    event.button !== 0 ||
    busy.value ||
    (event.target as HTMLElement).closest("button") ||
    (event.currentTarget as HTMLElement).parentElement?.hasAttribute("open")
  )
    return;
  pressX = event.clientX;
  pressY = event.clientY;
  pressTimer = setTimeout(() => {
    held = true;
    archiveMenu.value = card;
  }, 500);
}
function movePress(event: PointerEvent) {
  if (Math.abs(event.clientX - pressX) + Math.abs(event.clientY - pressY) > 12)
    cancelPress();
}
function clickCard(event: MouseEvent) {
  cancelPress();
  if (held) {
    held = false;
    event.preventDefault();
    event.stopPropagation();
  }
}
function openArchiveMenu(card: EventCard) {
  cancelPress();
  if (!busy.value) archiveMenu.value = card;
}
function showArchives(value: boolean) {
  cancelPress();
  archiveMenu.value = null;
  archiveMode.value = value;
  pages.value = {};
}
async function archiveSelected() {
  const card = archiveMenu.value;
  check(card, "未选择事件");
  await setEventArchived(
    await activeLibrary(),
    validView(),
    card.chain.id,
    !card.chain.archived,
    () => scope === hostScope(),
  );
  archiveMenu.value = null;
  await refresh();
}
const rewriteCard = shallowRef<EventCard | null>(null),
  rewriteInstructions = ref(""),
  rewriteAll = ref(true);
const confirmRewrite = ref(false),
  review = shallowRef<EventReview | null>(null),
  reviewError = ref("");
let rewriteTicket = 0,
  rewriteHost = "";
function cancelReview() {
  const owned = !!review.value;
  review.value = null;
  reviewError.value = "";
  if (owned && !busy.value) manualEventState.busy = false;
}
function resetRewrite() {
  rewriteTicket++;
  rewriteCard.value = null;
  confirmRewrite.value = false;
  cancelReview();
}
function openRewrite(card?: EventCard) {
  if (busy.value || manualEventState.busy || jobState.busy) return;
  rewriteCard.value = card ?? archiveMenu.value;
  rewriteAll.value = !card;
  archiveMenu.value = null;
  rewriteInstructions.value = card ? "根据当前成员摘要更新事件概要，保留仍成立的事实，修正已变化的内容。" : "";
  rewriteHost = hostVersion();
  error.value = "";
}
async function generateRewrite() {
  if (
    busy.value ||
    manualEventState.busy ||
    jobState.busy ||
    !rewriteCard.value
  )
    return;
  const token = ++rewriteTicket;
  busy.value = true;
  manualEventState.busy = true;
  confirmRewrite.value = false;
  error.value = "";
  try {
    check(
      scope === hostScope() && rewriteHost === hostVersion(),
      "聊天或楼层已改变，请重新打开",
    );
    const result = await prepareEventRewrite(
      rewriteCard.value.chain.id,
      rewriteInstructions.value,
      settings.overviewBatchTokens,
      undefined,
      () => !disposed && token === rewriteTicket && scope === hostScope(),
      rewriteAll.value,
    );
    if (token === rewriteTicket && scope === hostScope()) {
      review.value = result;
      reviewError.value = "";
      rewriteCard.value = null;
    }
  } catch (e) {
    if (token === rewriteTicket) error.value = (e as Error).message;
  } finally {
    busy.value = false;
    manualEventState.busy = !!review.value;
  }
}
async function saveRewrite(text: string) {
  if (busy.value || !review.value) return;
  const result = review.value,
    token = rewriteTicket;
  const live = () =>
    token === rewriteTicket && review.value === result && scope === hostScope();
  busy.value = true;
  reviewError.value = "";
  try {
    await result.confirm(text, live);
    if (live()) {
      review.value = null;
      notice.value = "概要已重写";
      await refresh();
    }
  } catch (e) {
    if (live()) reviewError.value = (e as Error).message;
    else if (token === rewriteTicket) error.value = (e as Error).message;
  } finally {
    busy.value = false;
    manualEventState.busy = !!review.value;
  }
}
const statusOptions = [
  { value: "open", label: "进行中" },
  { value: "resolved", label: "已结束" },
  { value: "dormant", label: "暂搁" },
];
const statusName = (s: string) =>
  statusOptions.find((o) => o.value === s)?.label ?? s;
let viewHost = "", viewGeneration = 0, formView: CapturedView | null = null, formHost = "", formGeneration = 0;
let scope = "",
  request = 0,
  reloadQueued = false,
  disposed = false;
function queueRefresh() {
  reloadQueued = true;
  drainRefresh();
}
function drainRefresh() {
  if (disposed || busy.value || loading.value || !reloadQueued) return;
  reloadQueued = false;
  void refresh();
}
watch(busy, (value) => { if (!value) drainRefresh(); });
async function run(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = String((e as Error).message);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  if (loading.value) { reloadQueued = true; return; }
  const token = ++request, observed = hostScope();
  const live = () => !disposed && token === request && observed === hostScope();
  loading.value = true;
  error.value = "";
  try {
    const captured = await syncDaily(), lib = await activeLibrary();
    const host = hostVersion(), generation = dailyState.generation, capturedRevision = dailyState.revision;
    const data = await eventView(lib, captured, false, undefined, true);
    if (!live()) return;
    const valid = await dailyCurrent(captured, host, generation) && lib === await activeLibrary();
    if (!live()) return;
    if (!valid || host !== hostVersion() || generation !== dailyState.generation) { reloadQueued = true; return; }
    viewHost = host; viewGeneration = generation;
    view.value = captured;
    cards.value = data.cards;
    storedCount.value = data.storedCount;
    scope = observed;
    // syncDaily may notify this page itself; the validated result already includes it.
    if (capturedRevision === dailyState.revision) reloadQueued = false;
  } catch (e) {
    if (live()) error.value = `事件读取未完成：${(e as Error).message}`;
  } finally {
    loading.value = false;
    drainRefresh();
  }
}

function edit(card: EventCard | null) {
  formView = view.value; formHost = viewHost; formGeneration = viewGeneration;
  editId.value = card?.chain.id ?? null;
  title.value = card?.meta.title ?? "";
  status.value = card?.meta.status ?? "open";
  overview.value = card ? eventOverview(card) : "";
  latestText.value = card?.meta.latestProgress?.text ?? "";
  latestMemory.value = card?.meta.latestProgress?.memory ?? card?.members.at(-1)?.memory ?? "";
  keywords.value = card?.meta.keywords.join("、") ?? "";
  editing.value = true;
}
function validView() {
  check(view.value && scope === hostScope() && viewHost === hostVersion() && viewGeneration === dailyState.generation, "聊天或摘要已改变，请刷新");
  return view.value;
}
async function save(confirmOverview = true) {
  check(formView && formHost === hostVersion() && formGeneration === dailyState.generation, "编辑期间聊天或摘要已改变，请复制草稿后重新打开");
  const card = cards.value.find((c) => c.chain.id === editId.value);
  await editEvent(
    await activeLibrary(),
    formView,
    editId.value,
    {
      title: title.value,
      status: status.value,
      keywords: keywords.value
        .split(/[,，、\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      overview: overview.value,
      // Preserve an untouched legacy/invalid field while editing other metadata.
      ...(latestText.value.trim() === (card?.meta.latestProgress?.text ?? '') &&
          (!latestText.value.trim() || latestMemory.value === card?.meta.latestProgress?.memory)
        ? {} : { latestProgress: latestText.value.trim() ? {
          version: 1 as const, text: latestText.value.trim(), memory: latestMemory.value, time: '',
        } : null }),
      confirmOverview,
      summarized: confirmOverview ? card?.members.map(m => m.memory) ?? [] : card?.meta.summarized ?? card?.progress.flatMap(p => p.memories) ?? [],
    },
    undefined,
    () => scope === hostScope() && formHost === hostVersion() && formGeneration === dailyState.generation,
  );
  editing.value = false;
  if (!editId.value) showArchives(false);
  await refresh();
}
async function remove() {
  check(removing.value, "未选择事件");
  await deleteEvent(
    await activeLibrary(),
    validView(),
    removing.value.chain.id,
    () => scope === hostScope(),
  );
  removing.value = null;
  await refresh();
}
async function unlink(card: EventCard, memory: string) {
  await editEvent(
    await activeLibrary(),
    validView(),
    card.chain.id,
    card.meta,
    { memory, active: false, kind: "progress" },
    () => scope === hostScope(),
  );
  await refresh();
}
async function batch() {
  if (jobState.busy) {
    stopDailyJob();
    return;
  }
  await runEvents();
  await refresh();
}
const members = (card: EventCard) =>
  card.members.slice(
    (pages.value[card.chain.id] ?? 0) * 10,
    ((pages.value[card.chain.id] ?? 0) + 1) * 10,
  );
const memberText = computed(() => new Map([
  ...cards.value.flatMap(c => c.memberDetails ?? []), ...(view.value?.memories ?? []),
].map(m => [m.id, m.content])));
const text = (id: string) => memberText.value.get(id) ?? "";
watch(() => dailyState.revision, queueRefresh);
watch(
  () => dailyState.scope,
  () => {
    request++;
    view.value = null;
    cards.value = [];
    storedCount.value = 0;
    pages.value = {};
    expandedCards.value = {}; expandedHistory.value = {}; expandedMembers.value = {};
    error.value = "";
    notice.value = "";
    editing.value = false;
    removing.value = null;
    resyncPlan.value = null;
    archiveMenu.value = null;
    archiveMode.value = false;
    resetRewrite();
    cancelPress();
    queueRefresh();
  },
  { flush: "sync" },
);
onMounted(queueRefresh);
onBeforeUnmount(() => {
  disposed = true;
  reloadQueued = false;
  request++;
  resetRewrite();
  cancelPress();
});
</script>
<template>
  <section class="mn-page">
    <SummaryReviewPanel />
    <div class="mn-event-heading">
      <h2>{{ archiveMode ? "归档事件" : "事件" }}</h2>
      <div class="mn-event-heading-actions">
        <button class="bbs-add-mini mn-event-icon" type="button" title="刷新" aria-label="刷新" :disabled="busy || loading" @click="queueRefresh">
          <Icon name="refresh" :size="18" />
        </button>
        <button v-if="view?.branch.fork" class="bbs-add-mini mn-event-icon" type="button" title="重新继承" aria-label="重新继承" :disabled="busy || loading || jobState.busy || manualEventState.busy" @click="run(previewResync)">
          <Icon name="download" :size="18" />
        </button>
        <button class="bbs-add-mini mn-event-icon" type="button" title="新建事件" aria-label="新建事件" :disabled="!view || busy || jobState.busy" @click="edit(null)">
          <Icon name="plus" :size="18" />
        </button>
      </div>
    </div>
    <div class="mn-actions mn-event-toolbar">
      <button :disabled="manualEventState.busy" @click="jobState.busy ? stopDailyJob() : run(batch)">
        {{ jobState.busy ? "停止" : "批量更新" }}
      </button>
      <button :disabled="!view || busy || loading || jobState.busy || manualEventState.busy || membershipUi.loading" @click="openMemberships()">批量摘要</button>
      <button v-if="!archiveMode" class="mn-primary mn-event-archive" @click="showArchives(true)">归档事件</button>
      <button v-else class="mn-back" @click="showArchives(false)">返回事件</button>
    </div>
    <p v-if="!archiveMode" class="mn-muted">
      在聊天楼层卡片上指定事件链。AI
      只更新你已归链内容的概要和关键词。长按折叠卡片可归档或重写概要，也可右键或按
      Shift+F10。
    </p>
    <p v-else class="mn-muted">
      归档只收起卡片，仍参与召回。点击标题看详情，长按标题可取消归档。
    </p>
    <p role="status">{{ jobState.status }}</p>
    <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
    <details v-if="!archiveMode" class="mn-card">
      <summary>事件概要自动更新与召回设置</summary>
      <p>
        自动和批量更新已有链的待处理成员；长链按预算依次请求多批，会产生模型费用。已整理部分用概要替代旧摘要和正文。
        每条链全部成功后才保存；停止或失败保留该链原概要，其他已完成链不回退。关闭自动更新时可使用“批量更新”。
      </p>
      <label
        ><input
          v-model="settings.eventsEnabled"
          type="checkbox"
        />自动更新事件概要和关键词</label
      >
      <label
        >更新间隔（消息楼数）<input
          v-model.number="settings.interval"
          type="number"
          min="1"
      /></label>
      <small
        >距最近已保存进展新增多少楼后，检查并更新概要待处理的事件链。User 和
        Assistant 各算一楼。</small
      >
      <label>生成概要发送的材料<BbsSelect v-model="settings.overviewMaterialMode" :options="[
        { value: 'summary', label: '仅摘要' }, { value: 'body', label: '仅正文' }, { value: 'both', label: '摘要+正文' }
      ]" aria-label="生成概要发送的材料" /></label>
      <small>默认摘要+正文。只影响发送的材料文本；成员ID、来源标识和原有剧情时间保留。切换后可手动更新重建覆盖，不会仅因切换自动调用模型；缺失所选材料时明确提示，不偷偷换模式。新建事件选单一材料时不附带原摘要生成的历史上下文，避免混入未选文本；摘要+正文保留原创建上下文。</small>
      <label
        >事件概要上限（字，含标点）<input
          v-model.number="settings.overviewMaxChars" type="number" min="1" max="20000" step="1"
      /></label>
      <small>默认1000字；新建、更新、重写和手动编辑均按此上限校验，已有概要不会自动裁剪。</small>
      <label
        >每批估算输入预算（token）<input
          v-model.number="settings.overviewBatchTokens" type="number" min="1000" max="1000000" step="1000"
      /></label>
      <small>默认80000，包含累计概要、待处理摘要/正文、提示词和安全余量。token 为保守估算，不保证等于服务商计数；模型上下文还需容纳渠道配置的输出额度。单条完整材料超预算会停止并提示，不截断正文。旧版已有事件链会自动沿用，成员和历史不变；首次更新缺少可靠覆盖记录的旧链时，会从当前全部成员分批重建。来源变化或主动重写也会重建。仅缺旧版覆盖记录不会触发自动付费更新，可手动点“批量更新”完成接入。</small>
      <h3>召回后的事件补充</h3>
      <p>
        先按原有向量 / BM25 / RRF / rerank
        选出摘要或原文，再为命中所属事件补上有界概述。同链只包装一次；不会独立检索所有事件，也不替换原本命中。
      </p>
      <label
        >一次召回最多补充几条事件链<input
          v-model.number="settings.chains"
          type="number"
          min="0" /></label
      ><small
        >例如设 2，即便命中了 5 条链，也最多给 2 条链补充链名、概述节选等。0
        关闭事件补充，原召回继续工作。</small
      >
      <label
        >每链概述节选字符数<input
          v-model.number="settings.excerptChars"
          type="number"
          min="0"
      /></label>
      <label
        >事件总注入预算（字符，额外计入上下文）<input
          v-model.number="settings.totalChars"
          type="number"
          min="0"
      /></label>
      <label
        >每条事件链额外补一条进展摘要<input
          v-model.number="settings.extra"
          type="number"
          min="0"
          max="1" /></label
      ><small
        >1：命中旧进展时，可多带一条当前截止范围内的最新进展；已命中或已在近期全文窗口就不重复。0：只补概述节选，不补摘要。</small
      >
      <p class="mn-muted">
        事件与原摘要 / 原文召回合并到同一个系统提示，使用“混合召回 →
        注入深度”设置的位置；知识库内容也在此召回块中。事件整理的单独 API
        请求不代表另开一套召回注入。
      </p>
      <button
        class="mn-primary"
        @click="
          run(async () => {
            await saveDailySettings();
            notice = '设置已保存';
          })
        "
      >
        保存设置
      </button>
      <p role="status">{{ notice }}</p>
    </details>
    <p v-if="loading" role="status" class="mn-muted">正在读取当前聊天的事件…</p>
    <p v-else-if="!view && !error" role="status" class="mn-muted">事件列表尚未读取，请点击刷新。</p>
    <p v-if="view && storedCount > cards.length" class="mn-warning" role="status">
      当前分支已保存 {{ storedCount }} 条事件，其中 {{ storedCount - cards.length }} 条因来源或历史视图校验暂未显示。
      请先导出核心包保留记录，再在档案 / 迁移页查看待审核项的来源差异，无需重复创建事件链。
    </p>
    <p v-if="view && !loading && !error && !visibleCards.length && storedCount === cards.length" class="mn-empty">
      {{
        archiveMode
          ? "暂无归档事件。"
          : cards.length
            ? "事件已全部收起，可进入归档事件查看。"
            : "还没有事件链。可从聊天楼层创建，也可先在这里新建空链。"
      }}
    </p>
    <details
      v-for="card in visibleCards"
      :key="`${archiveMode}:${card.chain.id}`"
      class="mn-card mn-event-card"
      :open="!!expandedCards[card.chain.id]"
      @toggle="setExpanded($event, expandedCards, card.chain.id)"
      :class="{ 'mn-archive-card': archiveMode }"
    >
      <summary
        @pointerdown="startPress($event, card)"
        @pointermove="movePress"
        @pointerup="cancelPress"
        @pointercancel="cancelPress"
        @pointerleave="cancelPress"
        @click.capture="clickCard"
        @contextmenu.prevent="openArchiveMenu(card)"
        @keydown.shift.f10.prevent="openArchiveMenu(card)"
        @keydown.esc="cancelPress"
      >
        <strong class="mn-event-title">{{ card.meta.title }}</strong>
        <small v-if="apiSettings.ui.showInternalIds" class="mn-muted">{{ card.chain.id }}</small>
        <p class="mn-muted mn-event-keywords">
          {{ card.meta.keywords.join(" · ") || "暂无关键词" }}
        </p>
        <div class="mn-event-meta">
          <span
            >{{ statusName(card.meta.status) }} ·
            {{ card.members.length }} 条关联<span v-if="eventPending(card)">
              · 概要待更新</span><span v-else-if="eventCoverageUpgradeNeeded(card)"> · 可重建分批覆盖</span></span
          ><span class="mn-actions"
            ><button :disabled="busy || jobState.busy || manualEventState.busy || membershipUi.loading" @click.stop.prevent="openMemberships({ eventId: card.chain.id })">批量加入</button>
            <button
              :disabled="busy || jobState.busy"
              @click.stop.prevent="edit(card)"
            >
              编辑</button
            ><button
              :disabled="busy || jobState.busy"
              @click.stop.prevent="removing = card"
            >
              删除
            </button></span
          >
        </div>
      </summary>
      <template v-if="expandedCards[card.chain.id]">
      <hr />
      <div v-if="eventPending(card) || eventCoverageUpgradeNeeded(card)" class="mn-card">
        <p v-if="card.blocked">关联摘要待审核，请先处理。</p>
        <p v-else-if="!card.members.length">暂无关联摘要，请先加入摘要。</p>
        <p v-else-if="card.needsReview">概要来源已变化，请更新概要。</p>
        <p v-else-if="eventPending(card)">概要待更新，可手动修改或使用 AI 更新。</p>
        <p v-else>当前概要已保留，可更新覆盖记录。</p>
        <details v-if="card.issues?.length">
          <summary>查看问题摘要（{{ card.issues.length }}）</summary>
          <p v-for="issue in card.issues" :key="issue.memory">
            <strong>{{ issue.floor === undefined ? '楼层未知' : `${issue.deleted ? '原' : ''}#${issue.floor}楼` }}</strong>
            · {{ issue.reason }}<br />{{ issue.text.slice(0, 60) || '摘要内容缺失' }}
          </p>
        </details>
        <div class="mn-actions mn-overview-actions">
          <button :disabled="busy || jobState.busy || card.blocked" @click="run(async () => { await keepEventOverview(await activeLibrary(), validView(), card.chain.id, () => viewHost === hostVersion() && viewGeneration === dailyState.generation); await refresh(); })">保留当前</button>
          <button :disabled="busy || jobState.busy" @click="edit(card)">手动更新</button>
          <button :disabled="busy || jobState.busy || card.blocked || manualEventState.busy" @click="openRewrite(card)">AI更新</button>
        </div>
      </div>
      <p class="mn-pre">
        <strong>事件概要：</strong
        >{{ eventOverview(card) || "暂无概要，可加入成员后更新" }}
      </p>
      <p class="mn-pre"><strong>最新进展：</strong>{{ card.meta.latestProgress ? [card.meta.latestProgress.time, card.meta.latestProgress.text].filter(Boolean).join(' · ') : card.meta.latestProgress === null ? '暂无明确进展' : '尚未填写，可在编辑中补充' }}</p>
      <hr />
      <details :open="!!expandedHistory[card.chain.id]" @toggle="setExpanded($event, expandedHistory, card.chain.id)">
        <summary>
          <strong><u>完整追加史</u></strong>
        </summary>
        <template v-if="expandedHistory[card.chain.id]">
        <article
          v-for="member in members(card)"
          :key="member.id"
          class="mn-card"
        >
          <p class="mn-member-preview">
            <strong v-if="card.issues?.some(issue => issue.memory === member.memory)">⚠ {{ card.issues.find(issue => issue.memory === member.memory)?.reason }} · </strong>
            {{ text(member.memory).slice(0, 100) }}
          </p>
          <details class="mn-member-detail" :open="!!expandedMembers[member.id]" @toggle="setExpanded($event, expandedMembers, member.id)">
            <summary>
              <span>完整摘要</span>
              <button
                class="mn-unlink"
                :disabled="busy || jobState.busy"
                @click.stop.prevent="run(() => unlink(card, member.memory))"
              >
                移除关联
              </button>
            </summary>
            <p v-if="expandedMembers[member.id]" class="mn-pre">{{ text(member.memory) }}</p>
          </details>
        </article>
        <div class="mn-actions">
          <button
            :disabled="!(pages[card.chain.id] ?? 0)"
            @click="pages[card.chain.id]--"
          >
            上一页</button
          ><span>{{ (pages[card.chain.id] ?? 0) + 1 }}</span
          ><button
            :disabled="
              ((pages[card.chain.id] ?? 0) + 1) * 10 >= card.members.length
            "
            @click="pages[card.chain.id] = (pages[card.chain.id] ?? 0) + 1"
          >
            下一页
          </button>
        </div>
        </template>
      </details>
      </template>
    </details>
    <ModalMask :open="!!archiveMenu" @close="!busy && (archiveMenu = null)">
      <section
        class="mn-dialog mn-archive-menu"
        role="dialog"
        aria-label="事件归档操作"
        aria-modal="true"
      >
        <header>
          <h3>{{ archiveMenu?.meta.title }}</h3>
        </header>
        <div class="mn-dialog-body">
          <p>
            {{
              archiveMenu?.chain.archived
                ? "取消归档后移回事件主页，内容和召回保持不变。"
                : "归档后移入归档事件，仍参与召回，可随时移回主页。"
            }}
          </p>
          <button
            class="mn-primary"
            :disabled="busy"
            @click="run(archiveSelected)"
          >
            {{ archiveMenu?.chain.archived ? "取消归档" : "归档" }}
          </button>
          <button
            :disabled="busy || manualEventState.busy || jobState.busy"
            @click="openRewrite()"
          >
            重写概要
          </button>
          <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
        </div>
        <footer>
          <button :disabled="busy" @click="archiveMenu = null">取消</button>
        </footer>
      </section>
    </ModalMask>
    <ModalMask :open="!!rewriteCard" @close="!busy && (rewriteCard = null)">
      <form
        class="mn-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="rewriteAll ? '重写概要' : '更新概要'"
        @submit.prevent="confirmRewrite = true"
      >
        <header>
          <h3>{{ rewriteAll ? "重写概要" : "更新概要" }}</h3>
          <small>{{ rewriteCard?.meta.title }}</small>
        </header>
        <div class="mn-dialog-body">
          <p>
            写一段说明，告诉 AI
            当前概要希望保留或突出什么，以及怎样概括。{{ rewriteAll ? "本次重写会从全部有效成员分批重新提炼。" : "本次更新用概要替代已整理材料，只补入新增成员；旧版覆盖不明、材料模式改变或来源改变时分批重建。" }}
          </p>
          <TableTextField
            v-model="rewriteInstructions"
            label="概要改写要求"
            :disabled="busy"
          />
          <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
        </div>
        <footer>
          <button type="button" :disabled="busy" @click="rewriteCard = null">
            取消
          </button>
          <button
            class="mn-primary"
            :disabled="
              busy ||
              !rewriteInstructions.trim() ||
              manualEventState.busy ||
              jobState.busy
            "
          >
            {{ rewriteAll ? "重写" : "更新" }}
          </button>
        </footer>
      </form>
    </ModalMask>
    <ConfirmDialog
      v-model:open="confirmRewrite"
      :title="rewriteAll ? '确认重写概要' : '确认更新概要'"
      top-layer
      confirm-text="确认发送"
      :busy="busy"
      @confirm="generateRewrite"
    >
      {{ rewriteAll ? "将从本链全部有效成员的所选材料分批重写" : "将用当前概要和未覆盖成员材料分批更新；旧版覆盖不明或来源改变时重建" }}，附上你的要求，按预算分批调用摘要 API，可能产生多次费用。返回后先审阅，确认才保存；不会新建事件链。
    </ConfirmDialog>
    <EventResponseReview
      v-if="review"
      :review="review"
      :busy="busy"
      :save-error="reviewError"
      @cancel="cancelReview"
      @confirm="saveRewrite"
    />
    <ModalMask :open="!!resyncPlan" @close="!busy && (resyncPlan = null)">
      <section v-if="resyncPlan" class="mn-dialog" role="dialog" aria-label="重新继承父事件链">
        <h3>重新继承父事件链</h3>
        <p>按已保存的分叉点（前 {{ resyncPlan.parent.cutoff }} 条消息）检查，包含归档事件。优先按关联材料的楼层与来源核对，可补回因较晚创建或整理而被旧规则漏掉的事件；楼层证据不符时回退历史版本。补齐缺失事件，替换未修改的继承事件；子分支自己修改过的事件会跳过。</p>
        <p>父档案、聊天正文与摘要保持原样，不调用模型。</p>
        <ul style="max-height: 45vh; overflow-y: auto">
          <li v-for="(item, index) in resyncPlan.entries" :key="index">
            {{ item.action === 'add' ? '新增' : item.action === 'replace' ? '补齐／更新' : '跳过' }}：{{ item.title }}{{ item.archived ? '（已归档）' : '' }} — {{ item.reason }}
          </li>
        </ul>
        <p v-if="!resyncPlan.entries.length">父档案没有可继承的事件。</p>
        <p v-if="error" class="mn-error" role="alert">{{ error }}</p>
        <div class="mn-actions">
          <button :disabled="busy" @click="resyncPlan = null">取消</button>
          <button :disabled="busy || !resyncPlan.cards.length" @click="run(confirmResync)">确认继承 {{ resyncPlan.cards.length }} 条</button>
        </div>
      </section>
    </ModalMask>
    <ModalMask :open="editing" @close="!busy && (editing = false)"
      ><form
        class="mn-dialog"
        role="dialog"
        aria-label="编辑事件"
        @submit.prevent="run(() => save(true))"
      >
        <header>
          <h3>{{ editId ? "编辑事件" : "新建事件" }}</h3>
        </header>
        <div class="mn-dialog-body">
          <label>标题<input v-model="title" required maxlength="300" /></label
          ><label
            >状态<BbsSelect
              v-model="status"
              :options="statusOptions"
              aria-label="事件状态" /></label
          ><label
            >概要<TableTextField v-model="overview" label="事件概要" />
            <small
              :class="{
                'mn-warning': overviewChars > settings.overviewMaxChars,
              }"
            >
              {{ overviewChars }} /
              {{ settings.overviewMaxChars }}
              字（含标点）。仅记录核心变化及影响关系或转变的重要细节。
            </small></label
          ><label>最新进展（{{ EVENT_PROGRESS_MAX_CHARS }}字内）<textarea v-model="latestText" rows="2" :maxlength="EVENT_PROGRESS_MAX_CHARS" :disabled="!progressSources.length" placeholder="简述最近一次实质进展" /></label>
          <label v-if="progressSources.length">进展对应摘要<BbsSelect v-model="latestMemory" :options="progressSources" aria-label="进展对应摘要" /><small>进展时间取自所选摘要，单独显示，不占进展小结字数。</small></label>
          <small v-else>加入关联摘要后，可填写最新进展。</small>
          <label
            >关键词<input v-model="keywords" placeholder="用逗号或顿号分隔"
          /></label>
          <p v-if="error" class="mn-warning">{{ error }}</p>
        </div>
        <footer>
          <button type="button" :disabled="busy" @click="editing = false">
            取消</button
          ><button v-if="editId" type="button" :disabled="busy" @click="run(() => save(false))">只保存编辑，稍后确认</button><button
            class="mn-primary"
            :disabled="
              busy || !title.trim() || overviewChars > settings.overviewMaxChars
            "
          >
            保存并确认概要
          </button>
        </footer>
      </form></ModalMask
    >
    <ConfirmDialog
      :open="!!removing"
      title="删除事件链"
      confirm-text="确认删除"
      :busy="busy"
      @cancel="removing = null"
      @confirm="run(remove)"
      >将完整删除“{{
        removing?.meta.title
      }}”及其概要、关联和进展记录，无法撤销；聊天正文和摘要保留。</ConfirmDialog
    >
  </section>
</template>
<style scoped>
.mn-event-toolbar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  min-width: 0;
  gap: 8px;
  margin: 10px 0;
}
.mn-event-toolbar button {
  min-width: 0;
  white-space: nowrap;
  padding: 8px 6px;
  font-size: 12px;
}
.mn-page .mn-event-archive {
  background: #2563eb;
  color: #fff;
  border-color: transparent;
}
.mn-event-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  gap: 8px;
}
.mn-event-heading h2 {
  min-width: 0;
  overflow-wrap: anywhere;
}
.mn-event-heading-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.mn-page .mn-event-icon {
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink-muted);
}
.mn-event-card > summary {
  -webkit-touch-callout: none;
  user-select: none;
}
.mn-archive-card:not([open]) .mn-event-keywords,
.mn-archive-card:not([open]) .mn-event-meta {
  display: none;
}
.mn-archive-menu {
  max-width: 380px;
}
.mn-archive-menu .mn-dialog-body > button {
  width: 100%;
  margin-top: 12px;
}
.mn-event-title {
  display: inline;
  font-size: 16px;
}
.mn-event-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.mn-event-meta .mn-actions {
  flex-wrap: nowrap;
  margin: 0;
}
.mn-event-meta button {
  padding: 5px 9px;
}
.mn-overview-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.mn-overview-actions button {
  min-width: 0;
  padding: 6px 4px;
  font-size: 13px;
  white-space: nowrap;
}
.mn-event-card hr {
  border: 0;
  height: 1px;
  background: linear-gradient(to right, var(--bbs-line-strong), transparent);
  margin: 12px 0;
}
.mn-member-preview {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mn-member-detail {
  min-width: 0;
}
.mn-member-detail > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
}
.mn-member-detail > summary::-webkit-details-marker {
  display: none;
}
.mn-member-detail > summary::before {
  content: "▸";
  color: var(--bbs-ink-soft);
}
.mn-member-detail[open] > summary::before {
  content: "▾";
}
.mn-page .mn-unlink {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11px;
  padding: 3px 8px;
  min-height: 30px;
  line-height: 1.5;
  border-radius: 7px;
  color: var(--bbs-ink-soft);
}
.mn-member-detail > .mn-pre {
  width: 100%;
  overflow-wrap: anywhere;
}
</style>
