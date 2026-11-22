<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import ModalMask from './ModalMask.vue';
import ReplyBlockerPanel from './ReplyBlockerPanel.vue';
import EventResponseReview from './EventResponseReview.vue';
import { summaryEditPrompt as prompt, resolveSummaryEdit, deferSummaryEdit, editEventGuard, SUMMARY_EDIT_NOTICE } from '@/mnemosyne/summary-edit-prompt';
import { engineState } from '@/memory/engine';
import { prepareEventRewrite, manualEventState, type EventReview } from '@/mnemosyne/manual-events';
import { eventBatchTokens } from '@/mnemosyne/event-settings';
import { syncDaily } from '@/mnemosyne/bridge';

const query = ref(''), limit = ref(40);
const options = computed(() => prompt.events.filter(e => e.title.includes(query.value.trim())));
const names = computed(() => new Map(prompt.events.map(e => [e.id, e.title])));
const result = shallowRef<EventReview | null>(null);
let eventId = '', current = () => false;
watch(() => [prompt.open, prompt.draft?.hostId], () => { query.value = ''; limit.value = 40; result.value = null; });
async function rewrite(id: string) {
  if (prompt.busy || manualEventState.busy) return;
  current = editEventGuard();
  if (!current()) { prompt.error = '聊天或摘要已改变，请重新打开'; return; }
  prompt.busy = manualEventState.busy = true;
  prompt.error = ''; eventId = id;
  try {
    const review = await prepareEventRewrite(id, '按修订后的材料重新生成事件概要，保留仍成立的事实。', eventBatchTokens(), undefined, current);
    if (current()) result.value = review;
  } catch (e) { if (current()) prompt.error = (e as Error).message; }
  finally { prompt.busy = manualEventState.busy = false; }
}
async function saveRewrite(text: string) {
  if (!result.value || prompt.busy) return;
  prompt.busy = true;
  try {
    await result.value.confirm(text, current);
    result.value = null;
    prompt.remainingEvents = prompt.remainingEvents.filter(id => id !== eventId);
    await syncDaily();
    if (current() && !prompt.remainingEvents.length) deferSummaryEdit();
  } catch (e) { prompt.error = (e as Error).message; }
  finally { prompt.busy = false; }
}
</script>
<template>
  <EventResponseReview v-if="prompt.open && result" :review="result" :busy="prompt.busy" :save-error="prompt.error"
    @cancel="result = null; prompt.error = ''" @confirm="saveRewrite"/>
  <ModalMask v-else :open="prompt.open" top-layer @close="!prompt.busy && deferSummaryEdit()">
    <section class="mn-dialog mn-edit-prompt" role="dialog" aria-modal="true" aria-label="编辑后处理摘要" @keydown.esc="!prompt.busy && deferSummaryEdit()">
      <header><h3>{{ prompt.followup ? '更新事件链概要' : prompt.draft ? '修订' + (prompt.draft.level ? '总结' : '摘要') : '编辑后处理摘要' }}</h3>
        <p v-if="prompt.draft">{{ prompt.draft.label }}<span v-if="prompt.total > 1"> · {{ prompt.step }}/{{ prompt.total }}</span></p></header>
      <div class="mn-dialog-body">
        <template v-if="prompt.draft && !prompt.followup">
          <label>{{ prompt.draft.level ? '总结正文' : '摘要正文' }}<textarea v-model="prompt.draft.text" rows="6" :disabled="prompt.busy"/></label>
          <label v-if="prompt.draft.level === 0">在场人物<input v-model="prompt.draft.participants" placeholder="多个人物用顿号分隔" :disabled="prompt.busy"/></label>
          <details v-if="prompt.draft.level === 0"><summary>从属事件链 · {{ prompt.draft.eventIds.map(id => names.get(id)).join('、') || '无' }}</summary>
            <input v-model="query" aria-label="搜索事件链" placeholder="搜索事件链" :disabled="prompt.busy"/>
            <p>移出成员会保留概要。若本楼是最新进展的来源，将同时撤下该条进展。</p>
            <label v-for="e in options.slice(0, limit)" :key="e.id"><input v-model="prompt.draft.eventIds" type="checkbox" :value="e.id" :disabled="prompt.busy"/> {{ e.title }}{{ e.archived ? '（已归档）' : '' }}</label>
            <button v-if="options.length > limit" @click="limit += 40">显示更多</button>
          </details>
        </template>
        <template v-if="!prompt.followup">
          <details v-if="prompt.affected.length"><summary>后续待修订总结 · {{ prompt.affected.length }} 条</summary>
            <p>{{ prompt.affected.join('、') }}</p></details>
          <p v-if="prompt.draft">{{ prompt.hasNext ? '保存当前内容后，将继续修订关联的上层总结。未确认的总结仍保留在待审核列表。' : '确认保存后完成本次修订。' }} AI 生成的草稿可继续修改。</p>
          <p v-if="prompt.draft" class="mn-edit-notice">{{ SUMMARY_EDIT_NOTICE }}</p>
        </template>
        <ReplyBlockerPanel v-if="prompt.blocker" :initial="prompt.blocker" :disabled="prompt.busy" @located="deferSummaryEdit()" />
        <p v-if="prompt.progress" role="status">{{ prompt.progress }}</p>
        <button v-for="id in prompt.remainingEvents" :key="id" :disabled="prompt.busy || manualEventState.busy" @click="rewrite(id)">重写「{{ names.get(id) }}」</button>
        <p v-if="prompt.error" role="alert" class="mn-warning">{{ prompt.error }}</p>
      </div>
      <footer>
        <template v-if="!prompt.followup">
          <button class="mn-primary" :disabled="prompt.busy || engineState.running || !prompt.draft?.text.trim()" @click="resolveSummaryEdit('keep')">{{ prompt.hasNext ? '保存并继续' : '确认保存' }}</button>
          <button v-if="prompt.draft" :disabled="prompt.busy || engineState.running" @click="resolveSummaryEdit('update')">{{ prompt.draft.level ? 'AI 生成总结' : 'AI 生成摘要' }}</button>
        </template>
        <button :disabled="prompt.busy" @click="resolveSummaryEdit('later')">{{ prompt.followup ? '完成，保留现有概要' : '稍后处理' }}</button>
      </footer>
    </section>
  </ModalMask>
</template>
<style scoped>
.mn-edit-prompt { color: var(--bbs-ink); }
.mn-edit-prompt header p, .mn-edit-notice { opacity: .75; font-size: .9em; }
.mn-edit-prompt details { margin-top: 14px; }
.mn-edit-prompt details label { margin: 6px 0; }
.mn-edit-prompt footer { display: flex; flex-wrap: wrap; gap: 8px; }
.mn-edit-prompt button { min-height: 40px; }
</style>
