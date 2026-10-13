<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount, nextTick } from 'vue';
import { summaryConfirmationPlan, retainRecoveredSummaries } from '@/mnemosyne/summary-recovery-confirmation';
import { rebuildSummaryOwners } from '@/mnemosyne/summary-review-actions';
import ModalMask from './ModalMask.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import TableTextField from './TableTextField.vue';
import { dailyState, readDailyReview, hostVersion, syncDaily, invalidateDaily, dailyCurrent } from '@/mnemosyne/bridge';
import { activeLibrary } from '@/mnemosyne/db';
import { keepSummaries, type MemoryStatus } from '@/mnemosyne/canonical';
import { check, type CapturedView, type MemoryRevision } from '@/mnemosyne/model';
import { editLeafAt, editSummary, getLeaf } from '@/memory/apply';
import { getContext } from '@/st/context';
import { engineState } from '@/memory/engine';
const props = defineProps<{ disabled?: boolean }>();
const view = shallowRef<CapturedView | null>(null), states = shallowRef(new Map<string, MemoryStatus>());
const loading = ref(false), expanded = ref(false), loadError = ref('');
const busy = ref(false), error = ref(''), notice = ref(''), page = ref(0), confirmUpdate = ref(false);
const editing = shallowRef<MemoryRevision | null>(null), draft = ref('');
const pending = computed(() => view.value?.memories.filter(m => ['needs_review','needs_rebuild'].includes(states.value.get(m.id) ?? '')) ?? []);
const missingSources = computed(() => pending.value.some(m => !!m.sourceRecovery));
const confirmationPlan = computed(() => {
  const ids = new Set(pending.value.map(m => m.id));
  return view.value ? summaryConfirmationPlan(view.value, ids) : { targets: [], exclusions: new Map<string, number>() };
});
const recovered = computed(() => confirmationPlan.value.targets);
const exclusionSummary = computed(() => [...confirmationPlan.value.exclusions].map(([reason, count]) => `${reason}：${count} 条`).join('；'));
const recoveredIds = computed(() => new Set(recovered.value.map(m => m.id)));
const confirmation = shallowRef<{ view: CapturedView; ids: string[]; host: string; generation: number } | null>(null);
const confirmKeep = computed({ get: () => !!confirmation.value, set: open => { if (!open) confirmation.value = null; } });
const locked = computed(() => busy.value || loading.value || dailyState.pending || props.disabled || engineState.running);
let host = '', generation = 0, ticket = 0, disposed = false, stopped = false;
function stopUpdates() { stopped = true; }
function toggleDetails(event: Event) { expanded.value = (event.target as HTMLDetailsElement).open; }
let reloadRequested = false;
async function load() {
  if (busy.value || disposed || dailyState.pending) return;
  // Archive revisions can arrive while IDB is still reading. Keep one active read
  // and then read only the newest revision, rather than retaining parallel full views.
  if (loading.value) { reloadRequested = true; return; }
  loading.value = true;
  try {
    do {
      reloadRequested = false;
      const token = ++ticket, gen = dailyState.generation, rev = dailyState.revision;
      try {
        const result = await readDailyReview();
        if (disposed || token !== ticket || gen !== dailyState.generation || rev !== dailyState.revision || dailyState.pending) continue;
        if (!result) { view.value = null; states.value = new Map(); continue; }
        if (result.host !== hostVersion()) continue;
        view.value = result.view; states.value = result.validity; host = result.host; generation = result.generation;
        loadError.value = '';
        page.value = Math.min(page.value, Math.max(0, Math.ceil(pending.value.length / 10) - 1));
      } catch (e) {
        if (!disposed && token === ticket && gen === dailyState.generation && rev === dailyState.revision) loadError.value = (e as Error).message;
      }
    } while (reloadRequested && !busy.value && !disposed && !dailyState.pending);
  } finally { loading.value = false; }
}
watch(() => [dailyState.revision, dailyState.scope, dailyState.review, dailyState.pending], load, { immediate: true });
watch(() => dailyState.scope, () => {
  ticket++; editing.value = null; confirmation.value = null; view.value = null; states.value = new Map();
  error.value = ''; loadError.value = ''; notice.value = ''; stopped = true; expanded.value = false; page.value = 0;
}, { flush: 'sync' });
onBeforeUnmount(() => { disposed = true; stopped = true; ticket++; });
async function run(action: () => Promise<void>) {
  if (locked.value) return;
  busy.value = true; error.value = ''; notice.value = ''; stopped = false;
  try {
    // Paint the busy state before exact source checks / the archive transaction.
    await nextTick(); await new Promise(resolve => setTimeout(resolve, 0));
    await action();
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; await load(); }
}
const guard = () => !disposed && host === hostVersion() && generation === dailyState.generation;
async function currentView() {
  check(view.value && guard() && await dailyCurrent(view.value, host, generation), '聊天或摘要已改变，请刷新后再处理');
  return view.value;
}
async function keep(ids: string[]) {
  const captured = await currentView();
  await keepSummaries(await activeLibrary(), captured, ids, guard);
  invalidateDaily(); await syncDaily();
  notice.value = `已保留 ${ids.length} 条摘要；相关事件仍按实际摘要版本检查。`;
}
function requestKeep() {
  if (locked.value) return;
  if (recovered.value.length || missingSources.value) openRecovery(recovered.value.map(m => m.id));
  else void run(() => keep(pending.value.map(m => m.id)));
}
function openRecovery(ids: string[]) {
  if (locked.value || !view.value || !ids.length) return;
  confirmation.value = { view: view.value, ids: [...ids], host, generation };
}
async function confirmRecovery() {
  const selected = confirmation.value;
  check(selected, '请重新选择要确认的摘要');
  const current = () => !disposed && confirmation.value === selected && selected.host === hostVersion() && selected.generation === dailyState.generation;
  check(await dailyCurrent(selected.view, selected.host, selected.generation) && current(), '聊天或摘要已改变，请重新核对');
  await retainRecoveredSummaries(selected.view, selected.ids, current);
  confirmation.value = null;
  notice.value = `已人工确认并保留 ${selected.ids.length} 条摘要，未调用模型；其他待审核项仍需单独处理。`;
}
function edit(memory: MemoryRevision) { editing.value = memory; draft.value = memory.content; }
async function saveEdit() {
  const captured = await currentView(), memory = editing.value;
  check(memory && draft.value.trim(), '摘要不能为空');
  if (!memory.level && memory.content === draft.value.trim()) {
    if (memory.sourceRecovery) await retainRecoveredSummaries(captured, [memory.id], guard);
    else await keep([memory.id]);
  }
  else if (memory.level) {
    check(editSummary(memory.hostId, draft.value), '宿主摘要不存在');
    invalidateDaily(); await syncDaily();
  } else {
    const floor = captured.refs.findIndex(r => r.message === memory.anchor), leaf = getLeaf(getContext()?.chat[floor]);
    check(floor >= 0 && leaf?.id === memory.hostId, '原来源已删除，请在仍存在的楼层补写摘要');
    check(editLeafAt(floor, draft.value, leaf.timeStart ?? '', leaf.timeEnd ?? ''), '摘要编辑失败');
    invalidateDaily(); await syncDaily();
  }
  editing.value = null; notice.value = '摘要已保存；上级摘要和事件概要可分别保留或更新。';
}
async function rebuild() {
  confirmUpdate.value = false;
  await currentView();
  const done = await rebuildSummaryOwners(pending.value.map(m => m.owner), view.value!.branch.id, guard, done => {
    host = hostVersion(); generation = dailyState.generation; notice.value = `已更新 ${done} 条摘要`;
  }, () => stopped || disposed);
  notice.value = `${stopped ? '已停止' : '更新完成'}：已保存 ${done} 条摘要。事件概要可单独保留或更新。`;
}
</script>
<template>
  <aside v-if="pending.length || error || loadError || notice || loading" class="mn-card mn-summary-review" aria-label="摘要编辑审核" :aria-busy="busy || loading">
    <template v-if="pending.length">
      <strong>{{ pending.length }} 条摘要待确认</strong>
      <p>正文或下级摘要有变化。小修正可保留现有摘要；内容有变化可手改或更新。旧版本和事件链仍保留。</p>
      <p v-if="missingSources">部分摘要的旧生成基线不在当前核心包中，原文和来源标记已保留。核对当前正文后，可逐条或批量人工确认；旧生成证据缺失的声明仍保留。</p>
      <div class="mn-actions">
        <button :disabled="locked || (missingSources && !recovered.length)" @click="requestKeep">{{ recovered.length || missingSources ? `核对并保留 ${recovered.length} 条现有摘要` : '保留全部现有摘要' }}</button>
        <button :disabled="locked" @click="confirmUpdate = true">更新受影响摘要</button>
        <button v-if="busy" @click="stopUpdates">停止后续更新</button>
      </div>
      <p v-if="exclusionSummary">其中 {{ pending.length - recovered.length }} 条无法在逐楼批次人工确认：{{ exclusionSummary }}。请单独检查来源或下级摘要。</p>
      <details :open="expanded" @toggle="toggleDetails"><summary>逐条查看与处理</summary>
        <template v-if="expanded">
        <article v-for="m in pending.slice(page * 10, (page + 1) * 10)" :key="m.id" class="mn-card">
          <small>L{{ m.level }} · {{ m.sourceRecovery ? '旧生成基线缺失，待人工核对' : states.get(m.id) === 'needs_rebuild' ? '下级摘要有变化' : '来源待确认' }}</small>
          <p class="mn-pre">{{ m.content.slice(0, 300) }}</p>
          <div class="mn-actions"><button :disabled="locked || (!!m.sourceRecovery && !recoveredIds.has(m.id))" @click="m.sourceRecovery ? openRecovery([m.id]) : run(() => keep([m.id]))">{{ m.sourceRecovery ? '核对并保留此摘要' : '保留此摘要' }}</button><button :disabled="locked" @click="edit(m)">{{ m.sourceRecovery ? '核对并手动确认' : '手动修订' }}</button></div>
        </article>
        <div class="mn-actions"><button :disabled="!page" @click="page--">上一页</button><span>{{ page + 1 }}</span><button :disabled="(page + 1) * 10 >= pending.length" @click="page++">下一页</button></div>
        </template>
      </details>
    </template>
    <p v-if="busy || loading" role="status">{{ busy ? '正在处理，请稍候…' : '正在读取最新审核状态…' }}</p>
    <p v-if="error || loadError" role="alert" class="mn-warning">{{ error || loadError }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <ConfirmDialog v-model:open="confirmKeep" title="人工确认并保留摘要" confirm-text="已核对，保留这些摘要" :busy="busy" busy-text="正在保存…" @confirm="run(confirmRecovery)">
      将保留当前分支选定的 {{ confirmation?.ids.length ?? 0 }} 条逐楼摘要，正文不改，不调用模型。确认表示你已核对每条摘要所在楼层及此前的当前正文，并认可摘要适用于这些内容。
      本次以你核对的当前正文为依据；旧生成时引用的摘要和来源保留在旧版本中。
      将另存人工确认版本，旧摘要、原来源记录及已有的生成来源缺失声明继续保留；不会把当前正文当成旧生成证据。其他摘要、上层总结和事件仍按各自版本检查。
    </ConfirmDialog>
    <ConfirmDialog v-model:open="confirmUpdate" title="更新受影响摘要" confirm-text="确认调用模型" :busy="busy" @confirm="run(rebuild)">
      按依赖顺序重新生成待处理摘要，可能多次调用摘要 API。完成的部分逐条保存，停止或失败会保留已完成部分；不会自动重写事件概要。
    </ConfirmDialog>
    <ModalMask :open="!!editing" @close="!busy && (editing = null)">
      <form class="mn-dialog" role="dialog" aria-label="修订待审核摘要" @submit.prevent="run(saveEdit)">
        <header><h3>手动修订摘要</h3></header><div class="mn-dialog-body"><p v-if="editing?.sourceRecovery">请先核对这条摘要所在楼层及此前正文。保存表示你确认摘要适用于这段当前正文，将另存人工确认版本；旧摘要和缺失的原生成来源声明继续保留。</p><p v-else>保存表示确认这份摘要适用于当前来源。上级摘要和事件概要可分别保留或更新。</p><TableTextField v-model="draft" label="修订摘要正文" :disabled="busy"/><p v-if="error" role="alert">{{ error }}</p></div>
        <footer><button type="button" :disabled="busy" @click="editing = null">取消</button><button class="mn-primary" :disabled="busy || !draft.trim()">保存并确认摘要</button></footer>
      </form>
    </ModalMask>
  </aside>
</template>
<style scoped>
.mn-summary-review { margin: 14px 0; }
.mn-summary-review .mn-actions { flex-wrap: wrap; gap: 8px; }
.mn-summary-review p { overflow-wrap: anywhere; }
.mn-summary-review summary { cursor: pointer; margin-top: 12px; }
</style>
