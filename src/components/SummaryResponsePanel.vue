<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import ModalMask from './ModalMask.vue';
import TableTextField from './TableTextField.vue';
import { eventJsonText } from '@/mnemosyne/event-response';
import { summaryResponses, summaryResponseUi, summaryResponseError, type SummaryResponse, type SummaryAttempt } from '@/memory/summary-response';
import { recoverSummaryResponse, engineState } from '@/memory/engine';
import { hostScope, dailyState } from '@/mnemosyne/bridge';
import { derivedMeta } from '@/memory/store';
defineProps<{ historyOnly?: boolean; dialogOnly?: boolean }>();
const scope = computed(() => { void dailyState.generation; void derivedMeta.rev; return hostScope(); });
const records = computed(() => summaryResponses.filter(r => r.scope === scope.value));
const selected = computed({
  get: () => {
    const record = records.value.find(r => r.id === summaryResponseUi.selectedId);
    const attempt = record?.attempts[summaryResponseUi.attempt];
    return record && attempt ? { record, attempt } : null;
  },
  set: (value: { record: SummaryResponse; attempt: SummaryAttempt } | null) => {
    summaryResponseUi.selectedId = value?.record.id ?? 0;
    summaryResponseUi.attempt = value ? value.record.attempts.indexOf(value.attempt) : 0;
  },
});
const saving = ref(false), saveError = ref('');
const panel = ref<HTMLElement | null>(null);
watch(selected, async value => { saveError.value = ''; if (value) { await nextTick(); panel.value?.focus?.({ preventScroll: true }); } });
function trapFocus(event: KeyboardEvent) {
  const targets = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), summary') ?? [])]
    .filter(el => el.getClientRects().length);
  if (!targets.length) return;
  const index = targets.findIndex(el => event.composedPath().includes(el));
  if (index < 0 || (!event.shiftKey && index === targets.length - 1) || (event.shiftKey && index === 0)) {
    event.preventDefault(); targets[event.shiftKey ? targets.length - 1 : 0]?.focus();
  }
}
const draft = computed({
  get: () => selected.value?.attempt.draft ?? eventJsonText(selected.value?.attempt.raw ?? ''),
  set: text => { if (selected.value) selected.value.attempt.draft = text; },
});
const error = computed(() => selected.value ? summaryResponseError(selected.value.record, draft.value) : '');
watch(scope, () => { selected.value = null; saveError.value = ''; });
function open(record: SummaryResponse, attempt: SummaryAttempt) {
  if (saving.value) return;
  if (attempt.draft === undefined) attempt.draft = eventJsonText(attempt.raw ?? '');
  selected.value = { record, attempt }; saveError.value = '';
}
async function confirm() {
  const target = selected.value;
  if (!target || saving.value || engineState.running || target.record.applied || error.value) return;
  saving.value = true; saveError.value = '';
  try {
    await recoverSummaryResponse(target.record, draft.value);
    if (selected.value?.record.id === target.record.id) selected.value = null;
  } catch (e) { saveError.value = (e as Error).message; }
  finally { saving.value = false; }
}
const labels = { api: 'API 请求失败（未取得正文）', empty: '返回为空', parse: '解析失败', validation: '校验或写入失败', ready: '待确认，尚未写入', ok: '已应用' };
</script>
<template>
  <details v-if="!dialogOnly && records.length" class="bbs-response-history">
    <summary>摘要返回记录（{{ records.length }} 次请求）</summary>
    <p>仅本次插件会话保留最多 20 次请求的每次尝试，优先保留未应用返回；关闭窗口不会丢失，刷新页面会清空。可在设置中开启“成功后预览编辑”（默认关闭）；失败返回始终可复用。</p>
    <article v-for="record in records" :key="record.id">
      <strong>{{ record.title }}</strong>
      <span v-if="record.running"> · 处理中</span>
      <span v-else-if="record.applied"> · 已应用，返回只读</span>
      <div v-for="(attempt, index) in record.attempts" :key="index">
        <button @click="open(record, attempt)">第 {{ index + 1 }} 次 · {{ record.applied && attempt.kind === 'ready' ? '已确认应用' : labels[attempt.kind] }} · 查看{{ !record.applied && attempt.raw !== null ? ' / 编辑复用' : '' }}</button>
      </div>
    </article>
  </details>
  <ModalMask v-if="!historyOnly" :open="!!selected" top-layer>
    <form v-if="selected" ref="panel" tabindex="-1" @keydown.tab="trapFocus" class="mn-dialog bbs-summary-response" role="dialog" aria-modal="true" aria-label="审阅摘要返回"
      @submit.prevent="confirm" @keydown.esc.stop.prevent="!saving && (selected = null)">
      <header><h3>审阅摘要返回</h3><small>{{ selected.record.title }}</small></header>
      <div class="mn-dialog-body">
        <p v-if="selected.record.applied">本次请求已经应用。这里保留各次返回供诊断，不会重复覆盖摘要。</p>
        <p v-else>可修改返回 JSON，确认后使用同一次请求的来源重新校验并写入，不再调用 API。来源或目标已改变时会拒绝旧结果。</p>
        <p v-if="selected.attempt.error" class="bbs-error">原始失败：{{ selected.attempt.error }}</p>
        <p v-if="selected.attempt.raw === null">API 请求未提供正文，无法复用返回。请检查 API 错误后重新生成。</p>
        <template v-else>
          <label>待应用 JSON<TableTextField v-model="draft" label="待应用摘要 JSON" :disabled="saving || selected.record.running || selected.record.applied" /></label>
          <p v-if="!selected.record.applied" role="status">{{ error || '格式通过；确认时还会校验来源和表格版本' }}</p>
          <details><summary>AI 返回正文（原样 · {{ selected.attempt.raw.length }} 字符）</summary>
            <p>仅接口提供的输出正文，不含独立思考内容、请求密钥或网络响应头。</p>
            <pre>{{ selected.attempt.raw || '（返回正文为空）' }}</pre>
          </details>
        </template>
        <p v-if="saveError" class="bbs-error" role="alert">{{ saveError }}</p>
      </div>
      <footer>
        <button type="button" :disabled="saving" @click="selected = null">关闭（不保存，保留草稿）</button>
        <button v-if="!selected.record.applied && selected.attempt.raw !== null" class="mn-primary"
          :disabled="saving || engineState.running || selected.record.running || !!error">{{ saving ? '正在应用…' : '确认应用（不调用 API）' }}</button>
      </footer>
    </form>
  </ModalMask>
</template>
<style scoped>
.bbs-response-history { margin: 14px 0; padding: 12px; border: 1px solid var(--bbs-line); border-radius: 10px; }
.bbs-response-history article { margin-top: 12px; }
.bbs-response-history p { font-size: 12px; }
.bbs-summary-response { width: min(680px, calc(100vw - 28px)); }
.bbs-summary-response :deep(textarea) { min-height: 240px; font-family: var(--bbs-font-mono); }
.bbs-summary-response pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 280px; overflow: auto; }
.bbs-summary-response details { margin: 12px 0; }
</style>
