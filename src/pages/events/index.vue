<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue';
import { syncDaily } from '@/mnemosyne/bridge';
import { activeLibrary } from '@/mnemosyne/db';
import {
  eventView,
  editEvent,
  eventProgressState,
  resolveEventReceipt,
  type EventCard,
} from '@/mnemosyne/events';
import { settings, jobState, saveDailySettings, runEvents, stopDailyJob } from '@/mnemosyne/jobs';
import type { CapturedView } from '@/mnemosyne/model';
const notice = ref('');
const confirmAction = (text: string) => window.confirm(text);
const progress = ref<Awaited<ReturnType<typeof eventProgressState>> | null>(null);
const view = shallowRef<CapturedView | null>(null),
  cards = shallowRef<EventCard[]>([]),
  error = ref(''),
  pages = ref<Record<string, number>>({}),
  selected = ref<Record<string, string>>({});
async function run(fn: () => Promise<unknown>) {
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = String((e as Error).message);
  }
}
async function refresh() {
  view.value = await syncDaily();
  cards.value = (await eventView(await activeLibrary(), view.value)).cards;
  progress.value = await eventProgressState(await activeLibrary(), view.value);
}
async function edit(card: EventCard | null) {
  const title = prompt('事件标题', card?.meta.title ?? '');
  if (!title) return;
  const status = prompt('状态', card?.meta.status ?? 'open');
  if (status === null) return;
  const keywords = prompt('关键词（逗号分隔）', card?.meta.keywords.join(',') ?? '');
  if (keywords === null) return;
  await editEvent(await activeLibrary(), view.value!, card?.chain.id ?? null, {
    title,
    status,
    keywords: keywords
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });
  await refresh();
}
async function link(card: EventCard, memory: string, active: boolean) {
  if (!memory) return;
  await editEvent(await activeLibrary(), view.value!, card.chain.id, card.meta, {
    memory,
    active,
    kind: 'progress',
  });
  await refresh();
}
function members(card: EventCard) {
  const p = pages.value[card.chain.id] ?? 0;
  return card.members.slice(p * 10, p * 10 + 10);
}
function text(id: string) {
  return view.value?.memories.find((m) => m.id === id)?.content ?? '';
}
function sources(id: string) {
  const m = view.value?.memories.find((m) => m.id === id);
  return (
    m?.inputRefs.map((r) => view.value?.sources.get(r.revision)?.content ?? '历史版本').join('\n\n') ||
    m?.declaration
  );
}
onMounted(() => run(refresh));
</script>
<template>
  <section class="mn-page">
    <h2>事件</h2>
    <details class="mn-card">
      <summary>独立事件任务与召回设置</summary>
      <p>
        事件请求仅发送本批材料及当前合法范围全量事件目录；不重新总结或结算状态。开启后使用摘要渠道（未指定则主
        API），会产生模型费用。
      </p>
      <label><input v-model="settings.eventsEnabled" type="checkbox" />启用自动事件整理</label>
      <label
        >自动整理触发间隔（消息楼数）<input v-model.number="settings.interval" type="number" min="1" /></label
      ><small
        >距离上次成功整理范围新增多少楼，才启动自动任务。User 和 Assistant 各算一楼；40 楼通常约 20
        轮。</small
      >
      <label>最近多少楼暂不自动整理<input v-model.number="settings.delay" type="number" min="0" /></label
      ><small
        >只延后事件整理，不隐藏或删除正文/摘要。例如设 6，就暂不处理最后 6 楼；0
        表示整理到当前。手动补齐不受此延迟限制。</small
      >
      <label
        >一次事件请求最多处理的摘要条数<input
          v-model.number="settings.batchSize"
          type="number"
          min="1"
          max="200" /></label
      ><small
        >按有效、尚未整理的 L0
        摘要计数，不含高层摘要。触发间隔负责“何时启动”，批量上限负责“单次发多少”；旧资料积压、缺摘要和重摘会让条数不等于间隔÷2。手动补齐连续分批；自动每次最多一批。</small
      >
      <label
        >完整请求预算（字符，保守计量）<input v-model.number="settings.maxChars" type="number" min="1000"
      /></label>
      <h3>召回后的事件补充</h3>
      <p>
        先按原有向量 / BM25 / RRF / rerank
        选出摘要或原文，再为命中所属事件补上有界概述。同链只包装一次；不会独立检索所有事件，也不替换原本命中。
      </p>
      <label>一次召回最多补充几条事件链<input v-model.number="settings.chains" type="number" min="0" /></label
      ><small
        >例如设 2，即便命中了 5 条链，也最多给 2 条链补充链名、概述节选等。0
        关闭事件补充，原召回继续工作。</small
      >
      <label>每链概述节选字符数<input v-model.number="settings.excerptChars" type="number" min="0" /></label>
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
        注入深度”设置的位置；知识库内容也在此召回块中。事件整理的单独 API 请求不代表另开一套召回注入。
      </p>
      <button
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
    <div class="mn-actions">
      <button @click="run(refresh)">刷新</button
      ><button
        :disabled="jobState.busy"
        @click="
          run(async () => {
            await runEvents();
            await refresh();
          })
        "
      >
        补齐未整理范围（调用模型）</button
      ><button :disabled="!jobState.busy" @click="stopDailyJob">停止</button
      ><button :disabled="!view" @click="run(() => edit(null))">手动新建事件</button>
    </div>
    <p role="status">
      {{ jobState.status }} · 已处理 {{ jobState.completed }} 条 · 请求 {{ jobState.chars }} 字符
    </p>
    <p v-if="progress">
      持久进度：共 {{ progress.total }} 条 · 完成 {{ progress.completed }} · 待确认
      {{ progress.needsReview }} · 来源变化待复查 {{ progress.needsRecheck }}
    </p>
    <details v-if="progress?.receipts.length" class="mn-card">
      <summary>待确认批次（不会自动反复调用模型）</summary>
      <p>请先用下方事件卡人工关联；确认后，尚未关联的材料记为无事件。原 AI 回执保留。</p>
      <button
        v-for="receipt in progress.receipts"
        :key="receipt.id"
        @click="
          run(async () => {
            if (confirmAction('确认这批已人工整理，未关联部分为无事件？')) {
              await resolveEventReceipt(await activeLibrary(), view!, receipt.id);
              await refresh();
            }
          })
        "
      >
        确认已人工整理 {{ receipt.memories.length }} 条
      </button>
    </details>
    <p>补齐固定为点击时的截止范围，逐批保存。目录过大会暂停；关闭页面不承诺后台执行。</p>
    <p v-if="error" role="alert" class="mn-warning">{{ error }}</p>
    <details v-for="card in cards" :key="card.chain.id" class="mn-card">
      <summary>
        <strong>{{ card.meta.title }}</strong> · {{ card.meta.status }} ·
        {{ card.members.length }} 条关联<br />{{
          card.progress
            .map((p) => p.text)
            .join(' ')
            .slice(0, 100)
        }}<br />最近进展：{{ card.progress.at(-1)?.text.slice(0, 80) || '暂无' }}
      </summary>
      <button @click="run(() => edit(card))">修改标题 / 状态 / 关键词</button>
      <p>关键词：{{ card.meta.keywords.join('、') }}</p>
      <small>{{ card.chain.id }}</small>
      <details>
        <summary>完整追加简史</summary>
        <p v-for="p in card.progress" :key="p.id" class="mn-pre">{{ p.text }}</p>
        <p>来源失效或人工移除关联后，受影响段不进入有效简史/召回；历史记录仍保留。</p>
      </details>
      <article v-for="member in members(card)" :key="member.id" class="mn-card">
        <p>
          {{ text(member.memory).slice(0, 80) }}
          <small>{{ member.kind }} {{ member.locked ? '人工锁定' : '' }}</small>
        </p>
        <details>
          <summary>完整摘要 / 来源</summary>
          <small>{{ member.memory }}</small>
          <p class="mn-pre">{{ text(member.memory) }}</p>
          <p class="mn-pre">{{ sources(member.memory) }}</p>
        </details>
        <button @click="run(() => link(card, member.memory, false))">移除关联（保留历史）</button>
      </article>
      <div class="mn-actions">
        <button :disabled="!(pages[card.chain.id] ?? 0)" @click="pages[card.chain.id]--">上一页</button
        ><span>{{ (pages[card.chain.id] ?? 0) + 1 }}</span
        ><button
          :disabled="((pages[card.chain.id] ?? 0) + 1) * 10 >= card.members.length"
          @click="pages[card.chain.id] = (pages[card.chain.id] ?? 0) + 1"
        >
          下一页
        </button>
      </div>
      <label
        >手动关联摘要版本<select v-model="selected[card.chain.id]">
          <option value="">选择摘要</option>
          <option v-for="m in view?.memories" :key="m.id" :value="m.id">
            L{{ m.level }} {{ m.content.slice(0, 50) }}
          </option>
        </select></label
      >
      <button @click="run(() => link(card, selected[card.chain.id], true))">添加并人工锁定</button>
    </details>
  </section>
</template>
