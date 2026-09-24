<script setup lang="ts">
import { ref, shallowRef, computed, onBeforeUnmount, watch } from 'vue';
import ModalMask from './ModalMask.vue';
import JsonResponseReview from './JsonResponseReview.vue';
import { dailyBranch, hostScope, hostVersion } from '@/mnemosyne/bridge';
import { activeLibrary } from '@/mnemosyne/db';
import { tableLastFloors, runTableBackfill, stopTableBackfill, backfillState, type TableBackfillReview } from '@/mnemosyne/table-backfill';
import { settings, loadDailySettings, saveDailySettings } from '@/mnemosyne/jobs';
import { check, type TableDef } from '@/mnemosyne/model';
const props = defineProps<{ tables: TableDef[]; disabled?: boolean }>();
const emit = defineEmits<{ done: [] }>();
const open = ref(false), error = ref(''), loading = ref(false), total = ref(0);
const start = ref(0), end = ref(0), batchSize = ref(20);
const choices = ref<{ id: string; name: string; last: number; selected: boolean }[]>([]);
const count = computed(() => Number.isSafeInteger(batchSize.value) && batchSize.value > 0 && end.value >= start.value ? Math.ceil((end.value - start.value + 1) / batchSize.value) : 0);
const review = shallowRef<TableBackfillReview | null>(null), reviewError = ref(''), saving = ref(false);
let scope = '', host = '', ownsJob = false, disposed = false, finishReview: ((accepted: boolean) => void) | undefined;
const live = () => !disposed && scope === hostScope() && host === hostVersion();
function finish(accepted: boolean) {
  const callback = finishReview; finishReview = undefined; review.value = null; reviewError.value = ''; callback?.(accepted);
}
watch(() => backfillState.busy, value => { if (!value) finish(false); });
onBeforeUnmount(() => { disposed = true; if (ownsJob) stopTableBackfill(); finish(false); });
async function show() {
  loading.value = true; error.value = '';
  try {
    scope = hostScope(); host = hostVersion();
    const branch = await dailyBranch(); check(branch, '请先归档当前聊天');
    const progress = await tableLastFloors(await activeLibrary(), branch);
    await loadDailySettings();
    check(live(), '聊天已改变，请重新打开');
    total.value = progress.total; start.value = 0; end.value = total.value - 1; batchSize.value = settings.backfillBatchSize;
    choices.value = props.tables.filter(t => !t.deleted && t.columns.length).map(t => ({ id: t.id, name: t.name, last: progress.floors[t.id] ?? -1, selected: false }));
    open.value = true;
  } catch (e) { error.value = (e as Error).message; }
  finally { loading.value = false; }
}
async function confirmReview(text: string) {
  if (!review.value || saving.value) return;
  const draft = review.value;
  saving.value = true; reviewError.value = '';
  try { await draft.confirm(text, () => live() && review.value === draft); finish(true); }
  catch (e) { reviewError.value = (e as Error).message; }
  finally { saving.value = false; }
}
async function submit() {
  error.value = '';
  try {
    check(live(), '聊天已改变，请重新打开');
    check(Number.isSafeInteger(batchSize.value) && batchSize.value > 0, '每批楼数必须为正整数');
    settings.backfillBatchSize = batchSize.value; await saveDailySettings();
    ownsJob = true;
    await runTableBackfill(choices.value.filter(c => c.selected).map(c => ({ table: c.id, start: start.value, end: end.value })), 96000, undefined, batchSize.value, live,
      draft => new Promise<boolean>(resolve => {
        if (!live()) { resolve(false); return; }
        review.value = draft; reviewError.value = ''; finishReview = resolve;
      }));
    emit('done'); open.value = false;
  } catch (e) { error.value = (e as Error).message; emit('done'); }
  finally { ownsJob = false; }
}
</script>
<template>
  <button :disabled="disabled || loading" @click="backfillState.busy ? stopTableBackfill() : show()">{{ backfillState.busy ? '停止补表' : '批量补表' }}</button>
  <p v-if="error && !open" class="mn-warning" role="alert">{{ error }}</p>
  <ModalMask :open="open" @close="!backfillState.busy && (open = false)">
    <form class="mn-dialog" role="dialog" aria-label="批量补表" @submit.prevent="submit">
      <header><h3>批量补表</h3><p>每批将共用楼层正文和所有选中表一起发送，调用一次摘要 API。返回后可手改，确认通过才一起保存。</p></header>
      <div class="mn-dialog-body">
        <p>楼号从0开始。“最后确认”不保证之前没有缺口；范围重叠时只补缺失内容。</p>
        <fieldset :disabled="backfillState.busy" class="mn-backfill-choice">
          <legend>所有选中表共用范围</legend>
          <div class="mn-backfill-range"><label>从楼号<input v-model.number="start" type="number" min="0" :max="total - 1" required /></label><label>到楼号<input v-model.number="end" type="number" :min="start" :max="total - 1" required /></label></div>
          <label>每批楼数<input v-model.number="batchSize" type="number" min="1" step="1" required /></label>
          <p>预计 {{ count }} 批／{{ count }} 次请求；每批包含全部选中表。可能产生模型费用。</p>
        </fieldset>
        <fieldset v-for="c in choices" :key="c.id" :disabled="backfillState.busy" class="mn-backfill-choice"><label class="mn-check"><input v-model="c.selected" type="checkbox" />{{ c.name }}</label><small>最后确认：{{ c.last < 0 ? '尚未更新' : '#' + c.last }} · 当前共 {{ total }} 楼</small></fieldset>
        <p v-if="!choices.length">没有可补的表，请先建表并设计字段。</p>
        <p role="status">{{ backfillState.status }}</p><p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
      </div>
      <footer><button type="button" :disabled="backfillState.busy" @click="open = false">取消</button><button v-if="backfillState.busy" type="button" @click="stopTableBackfill">停止</button><button v-else class="mn-primary" :disabled="!choices.some(c => c.selected) || !count">确认调用 API 补表</button></footer>
    </form>
  </ModalMask>
  <JsonResponseReview v-if="review" :review="review" :busy="saving" :save-error="reviewError" label="审阅补表返回" editor-label="待保存补表 JSON" :validate="review.validate"
    description="检查或修改本批全部表的 JSON。确认时再次检验，通过后一起保存；修改和确认不再调用 API。取消将停止后续批次，已保存批次保留。" @cancel="finish(false)" @confirm="confirmReview">
    <template #format><p>每张选中的表都需保留一项。无变化时 add 和 update 填空数组；字段名使用下面的字段 ID，已有行用 row_id 更新。</p><pre>{{ review.example }}</pre><details v-for="table in review.tables" :key="table.def.id"><summary>{{ table.def.name }} · 字段和可见行</summary><pre>{{ JSON.stringify({ table_id: table.def.id, columns: table.def.columns, rows: table.rows.map(row => ({ row_id: row.id, values: row.values })) }, null, 2) }}</pre></details></template>
  </JsonResponseReview>
</template>
<style scoped>
.mn-backfill-choice { border: 1px solid var(--bbs-line); border-radius: 12px; padding: 12px; margin: 12px 0; min-width: 0; }
.mn-backfill-range { display: flex; gap: 12px; margin-top: 10px; }
.mn-backfill-range label { flex: 1; min-width: 0; }
</style>
