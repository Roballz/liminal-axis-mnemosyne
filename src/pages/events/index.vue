<script setup lang="ts">
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
} from "@/mnemosyne/bridge";
import { activeLibrary } from "@/mnemosyne/db";
import {
  eventView,
  editEvent,
  deleteEvent,
  setEventArchived,
  EVENT_OVERVIEW_MAX_CHARS,
  eventOverviewLength,
  type EventCard,
} from "@/mnemosyne/events";
import {
  manualEventState,
  eventOverview,
  eventPending,
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
  pages = ref<Record<string, number>>({});
const editing = ref(false),
  editId = ref<string | null>(null),
  title = ref(""),
  status = ref("open"),
  overview = ref(""),
  keywords = ref("");
const overviewChars = computed(() => eventOverviewLength(overview.value));
const removing = shallowRef<EventCard | null>(null);
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
  rewriteInstructions = ref("");
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
function openRewrite() {
  if (busy.value || manualEventState.busy || jobState.busy) return;
  rewriteCard.value = archiveMenu.value;
  archiveMenu.value = null;
  rewriteInstructions.value = "";
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
      settings.maxChars,
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
let scope = "",
  request = 0;
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
  const token = ++request,
    observed = hostScope();
  const captured = await syncDaily(),
    data = await eventView(await activeLibrary(), captured);
  if (token !== request || observed !== hostScope()) return;
  view.value = captured;
  cards.value = data.cards;
  scope = observed;
}
function edit(card: EventCard | null) {
  editId.value = card?.chain.id ?? null;
  title.value = card?.meta.title ?? "";
  status.value = card?.meta.status ?? "open";
  overview.value = card ? eventOverview(card) : "";
  keywords.value = card?.meta.keywords.join("、") ?? "";
  editing.value = true;
}
function validView() {
  check(view.value && scope === hostScope(), "聊天已切换，请刷新");
  return view.value;
}
async function save() {
  const card = cards.value.find((c) => c.chain.id === editId.value);
  await editEvent(
    await activeLibrary(),
    validView(),
    editId.value,
    {
      title: title.value,
      status: status.value,
      keywords: keywords.value
        .split(/[,，、\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      overview: overview.value,
      summarized:
        card?.meta.summarized ??
        card?.progress.flatMap((p) => p.memories) ??
        [],
    },
    undefined,
    () => scope === hostScope(),
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
const text = (id: string) =>
  view.value?.memories.find((m) => m.id === id)?.content ?? "";
watch(
  () => dailyState.scope,
  () => {
    request++;
    view.value = null;
    cards.value = [];
    editing.value = false;
    removing.value = null;
    archiveMenu.value = null;
    archiveMode.value = false;
    resetRewrite();
    cancelPress();
  },
);
onMounted(() => run(refresh));
onBeforeUnmount(() => {
  request++;
  resetRewrite();
  cancelPress();
});
</script>
<template>
  <section class="mn-page">
    <div class="mn-event-heading">
      <h2>{{ archiveMode ? "归档事件" : "事件" }}</h2>
      <button v-if="archiveMode" class="mn-back" @click="showArchives(false)">
        返回事件
      </button>
    </div>
    <div class="mn-actions mn-event-toolbar">
      <button :disabled="busy" @click="run(refresh)">刷新</button
      ><button
        :disabled="manualEventState.busy"
        @click="jobState.busy ? stopDailyJob() : run(batch)"
      >
        {{ jobState.busy ? "停止" : "批量整理" }}</button
      ><button
        class="mn-primary"
        :disabled="!view || busy || jobState.busy"
        @click="edit(null)"
      >
        新建事件
      </button>
      <button v-if="!archiveMode" @click="showArchives(true)">归档事件</button>
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
        自动和批量整理仅更新已有链的待处理成员，每条待更新链一次摘要 API
        请求；会产生模型费用。关闭自动更新时可使用“批量整理”。
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
      <label
        >完整请求预算（字符）<input
          v-model.number="settings.maxChars"
          type="number"
          min="1000"
      /></label>
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
    <p v-if="!visibleCards.length" class="mn-empty">
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
        <p class="mn-muted mn-event-keywords">
          {{ card.meta.keywords.join(" · ") || "暂无关键词" }}
        </p>
        <div class="mn-event-meta">
          <span
            >{{ statusName(card.meta.status) }} ·
            {{ card.members.length }} 条关联<span v-if="eventPending(card)">
              · 概要待更新</span
            ></span
          ><span class="mn-actions"
            ><button
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
      <hr />
      <p class="mn-pre">
        <strong>事件概要：</strong
        >{{ eventOverview(card) || "暂无概要，可加入成员后更新" }}
      </p>
      <hr />
      <details>
        <summary>
          <strong><u>完整追加史</u></strong>
        </summary>
        <article
          v-for="member in members(card)"
          :key="member.id"
          class="mn-card"
        >
          <p class="mn-member-preview">
            {{ text(member.memory).slice(0, 100) }}
          </p>
          <details class="mn-member-detail">
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
            <p class="mn-pre">{{ text(member.memory) }}</p>
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
      </details>
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
            @click="openRewrite"
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
        aria-label="重写概要"
        @submit.prevent="confirmRewrite = true"
      >
        <header>
          <h3>重写概要</h3>
          <small>{{ rewriteCard?.meta.title }}</small>
        </header>
        <div class="mn-dialog-body">
          <p>
            写一段说明，告诉 AI
            当前概要哪里不合意、希望保留或突出什么，以及怎样改写。将结合这条链的全部有效成员正文、摘要和当前概要重写。
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
            重写
          </button>
        </footer>
      </form>
    </ModalMask>
    <ConfirmDialog
      v-model:open="confirmRewrite"
      title="确认重写概要"
      top-layer
      confirm-text="确认发送"
      :busy="busy"
      @confirm="generateRewrite"
    >
      将发送本链全部有效成员正文、摘要、当前概要和你的改写要求，调用一次摘要
      API，可能产生费用。返回后先审阅，确认才保存；不会新建事件链。
    </ConfirmDialog>
    <EventResponseReview
      v-if="review"
      :review="review"
      :busy="busy"
      :save-error="reviewError"
      @cancel="cancelReview"
      @confirm="saveRewrite"
    />
    <ModalMask :open="editing" @close="!busy && (editing = false)"
      ><form
        class="mn-dialog"
        role="dialog"
        aria-label="编辑事件"
        @submit.prevent="run(save)"
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
                'mn-warning': overviewChars > EVENT_OVERVIEW_MAX_CHARS,
              }"
            >
              {{ overviewChars }} /
              {{ EVENT_OVERVIEW_MAX_CHARS }}
              字（含标点）。仅记录核心变化及影响关系或转变的重要细节。
            </small></label
          ><label
            >关键词<input v-model="keywords" placeholder="用逗号或顿号分隔"
          /></label>
          <p v-if="error" class="mn-warning">{{ error }}</p>
        </div>
        <footer>
          <button type="button" :disabled="busy" @click="editing = false">
            取消</button
          ><button
            class="mn-primary"
            :disabled="
              busy || !title.trim() || overviewChars > EVENT_OVERVIEW_MAX_CHARS
            "
          >
            保存
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
  flex-wrap: nowrap;
  gap: 6px;
}
.mn-event-toolbar button {
  white-space: nowrap;
  padding: 8px 6px;
  font-size: 12px;
}
.mn-event-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
