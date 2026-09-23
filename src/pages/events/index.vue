<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { syncDaily } from '@/mnemosyne/bridge';
import { activeLibrary } from '@/mnemosyne/db';
import { eventView, editEvent, eventProgressState, resolveEventReceipt, type EventCard } from '@/mnemosyne/events';
import { settings, jobState, saveDailySettings, runEvents, stopDailyJob } from '@/mnemosyne/jobs';
import type { CapturedView } from '@/mnemosyne/model';
const confirmAction = (text: string) => window.confirm(text);
const progress = ref<Awaited<ReturnType<typeof eventProgressState>> | null>(null);
const view = ref<CapturedView | null>(null), cards = ref<EventCard[]>([]), error = ref(''), pages = ref<Record<string, number>>({}), selected = ref<Record<string, string>>({});
async function run(fn: () => Promise<unknown>) { error.value = ''; try {
    await fn();
}
catch (e) {
    error.value = String((e as Error).message);
} }
async function refresh() { view.value = await syncDaily(); cards.value = (await eventView(await activeLibrary(), view.value)).cards; progress.value = await eventProgressState(await activeLibrary(), view.value); }
async function edit(card: EventCard | null) {
    const title = prompt('事件标题', card?.meta.title ?? '');
    if (!title)
        return;
    const status = prompt('状态', card?.meta.status ?? 'open');
    if (status === null)
        return;
    const keywords = prompt('关键词（逗号分隔）', card?.meta.keywords.join(',') ?? '');
    if (keywords === null)
        return;
    await editEvent(await activeLibrary(), view.value!, card?.chain.id ?? null, { title, status, keywords: keywords.split(',').map(s => s.trim()).filter(Boolean) });
    await refresh();
}
async function link(card: EventCard, memory: string, active: boolean) {
    if (!memory)
        return;
    await editEvent(await activeLibrary(), view.value!, card.chain.id, card.meta, { memory, active, kind: 'progress' });
    await refresh();
}
function members(card: EventCard) { const p = pages.value[card.chain.id] ?? 0; return card.members.slice(p * 10, p * 10 + 10); }
function text(id: string) { return view.value?.memories.find(m => m.id === id)?.content ?? ''; }
function sources(id: string) { const m = view.value?.memories.find(m => m.id === id); return m?.inputRefs.map(r => view.value?.sources.get(r.revision)?.content ?? '历史版本').join('\n\n') || m?.declaration; }
onMounted(() => run(refresh));
</script>
<template>
 <section class="mn-page"><h2>事件</h2>
  <details class="mn-card"><summary>独立事件任务与召回设置</summary>
   <p>事件请求仅发送本批材料及当前合法范围全量事件目录；不重新总结或结算状态。开启后使用摘要渠道（未指定则主 API），会产生模型费用。</p>
   <label><input v-model="settings.eventsEnabled" type="checkbox" />启用自动事件整理</label>
   <label>触发间隔（聊天消息楼，不是轮数）<input v-model.number="settings.interval" type="number" min="1" /></label>
   <label>保留最近楼数（延迟，0 表示不保留）<input v-model.number="settings.delay" type="number" min="0" /></label>
   <label>每批最多摘要条数<input v-model.number="settings.batchSize" type="number" min="1" max="200" /></label>
   <label>完整请求预算（字符，保守计量）<input v-model.number="settings.maxChars" type="number" min="1000" /></label>
   <label>每轮最多扩展事件链<input v-model.number="settings.chains" type="number" min="0" /></label>
   <label>每链概述节选字符数<input v-model.number="settings.excerptChars" type="number" min="0" /></label>
   <label>事件总注入预算（字符，额外计入上下文）<input v-model.number="settings.totalChars" type="number" min="0" /></label>
   <label>每链额外摘要（0 或 1）<input v-model.number="settings.extra" type="number" min="0" max="1" /></label>
   <button @click="run(saveDailySettings)">保存设置</button>
  </details>
  <div class="mn-actions"><button @click="run(refresh)">刷新</button><button :disabled="jobState.busy" @click="run(async()=>{await runEvents();await refresh()})">补齐未整理范围（调用模型）</button><button :disabled="!jobState.busy" @click="stopDailyJob">停止</button><button :disabled="!view" @click="run(()=>edit(null))">手动新建事件</button></div>
  <p role="status">{{jobState.status}} · 已处理 {{jobState.completed}} 条 · 请求 {{jobState.chars}} 字符</p>
  <p v-if="progress">持久进度：共 {{progress.total}} 条 · 完成 {{progress.completed}} · 待确认 {{progress.needsReview}} · 来源变化待复查 {{progress.needsRecheck}}</p>
  <details v-if="progress?.receipts.length" class="mn-card"><summary>待确认批次（不会自动反复调用模型）</summary>
   <p>请先用下方事件卡人工关联；确认后，尚未关联的材料记为无事件。原 AI 回执保留。</p>
   <button v-for="receipt in progress.receipts" :key="receipt.id" @click="run(async()=>{if(confirmAction('确认这批已人工整理，未关联部分为无事件？')){await resolveEventReceipt(await activeLibrary(),view!,receipt.id);await refresh()}})">确认已人工整理 {{receipt.memories.length}} 条</button>
  </details>
  <p>补齐固定为点击时的截止范围，逐批保存。目录过大会暂停；关闭页面不承诺后台执行。</p>
  <p v-if="error" role="alert" class="mn-warning">{{error}}</p>
  <details v-for="card in cards" :key="card.chain.id" class="mn-card">
   <summary><strong>{{card.meta.title}}</strong> · {{card.meta.status}} · {{card.members.length}} 条关联<br />{{card.progress.map(p=>p.text).join(' ').slice(0,100)}}<br />最近进展：{{card.progress.at(-1)?.text.slice(0,80)||'暂无'}}</summary>
   <button @click="run(()=>edit(card))">修改标题 / 状态 / 关键词</button>
   <p>关键词：{{card.meta.keywords.join('、')}}</p><small>{{card.chain.id}}</small>
   <details><summary>完整追加简史</summary><p v-for="p in card.progress" :key="p.id" class="mn-pre">{{p.text}}</p><p>来源失效或人工移除关联后，受影响段不进入有效简史/召回；历史记录仍保留。</p></details>
   <article v-for="member in members(card)" :key="member.id" class="mn-card">
    <p>{{text(member.memory).slice(0,80)}} <small>{{member.kind}} {{member.locked?'人工锁定':''}}</small></p>
    <details><summary>完整摘要 / 来源</summary><small>{{member.memory}}</small><p class="mn-pre">{{text(member.memory)}}</p><p class="mn-pre">{{sources(member.memory)}}</p></details>
    <button @click="run(()=>link(card,member.memory,false))">移除关联（保留历史）</button>
   </article>
   <div class="mn-actions"><button :disabled="!(pages[card.chain.id]??0)" @click="pages[card.chain.id]--">上一页</button><span>{{(pages[card.chain.id]??0)+1}}</span><button :disabled="((pages[card.chain.id]??0)+1)*10>=card.members.length" @click="pages[card.chain.id]=(pages[card.chain.id]??0)+1">下一页</button></div>
   <label>手动关联摘要版本<select v-model="selected[card.chain.id]"><option value="">选择摘要</option><option v-for="m in view?.memories" :key="m.id" :value="m.id">L{{m.level}} {{m.content.slice(0,50)}}</option></select></label>
   <button @click="run(()=>link(card,selected[card.chain.id],true))">添加并人工锁定</button>
  </details>
 </section>
</template>
