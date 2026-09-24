<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount } from 'vue';
import ModalMask from './ModalMask.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import TableTextField from './TableTextField.vue';
import { dailyState, dailyBranch, hostVersion, syncDaily, invalidateDaily, dailyCurrent } from '@/mnemosyne/bridge';
import { activeLibrary } from '@/mnemosyne/db';
import { capture, statuses, keepSummaries, type MemoryStatus } from '@/mnemosyne/canonical';
import { check, type CapturedView, type MemoryRevision } from '@/mnemosyne/model';
import { editLeafAt, editSummary, getLeaf } from '@/memory/apply';
import { getContext } from '@/st/context';
import { engineState, regenerateFloor, regenerateHigherSummary } from '@/memory/engine';
const props = defineProps<{ disabled?: boolean }>();
const view = shallowRef<CapturedView | null>(null), states = shallowRef(new Map<string, MemoryStatus>());
const busy = ref(false), error = ref(''), notice = ref(''), page = ref(0), confirmUpdate = ref(false);
const editing = shallowRef<MemoryRevision | null>(null), draft = ref('');
const pending = computed(() => view.value?.memories.filter(m => ['needs_review','needs_rebuild'].includes(states.value.get(m.id) ?? '')) ?? []);
const locked = computed(() => busy.value || props.disabled || engineState.running);
let host = '', generation = 0, ticket = 0, disposed = false, stopped = false;
function stopUpdates() { stopped = true; }
async function load() {
  if (busy.value || disposed) return;
  const token = ++ticket, stamp = hostVersion(), gen = dailyState.generation;
  try {
    const lib = await activeLibrary(), branch = await dailyBranch();
    if (!branch) { if (token === ticket) view.value = null; return; }
    const result = await capture(lib, branch.id), validity = await statuses(lib, result);
    if (disposed || token !== ticket || stamp !== hostVersion() || gen !== dailyState.generation) return;
    view.value = result; states.value = validity; host = stamp; generation = gen;
    page.value = Math.min(page.value, Math.max(0, Math.ceil(pending.value.length / 10) - 1));
  } catch (e) { if (token === ticket) error.value = (e as Error).message; }
}
watch(() => [dailyState.revision, dailyState.scope, dailyState.review], load, { immediate: true });
watch(() => dailyState.scope, () => { editing.value = null; view.value = null; error.value = ''; notice.value = ''; stopped = true; }, { flush: 'sync' });
onBeforeUnmount(() => { disposed = true; stopped = true; ticket++; });
async function run(action: () => Promise<void>) {
  if (locked.value) return;
  busy.value = true; error.value = ''; notice.value = ''; stopped = false;
  try { await action(); } catch (e) { error.value = (e as Error).message; }
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
function edit(memory: MemoryRevision) { editing.value = memory; draft.value = memory.content; }
async function saveEdit() {
  const captured = await currentView(), memory = editing.value;
  check(memory && draft.value.trim(), '摘要不能为空');
  if (!memory.level && memory.content === draft.value.trim()) await keep([memory.id]);
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
  const targets = new Set(pending.value.map(m => m.owner));
  const lib = await activeLibrary();
  let done = 0;
  while (targets.size && !stopped && !disposed) {
    check(guard(), '聊天改变，已停止；完成的摘要已保留');
    const captured = await syncDaily(), validity = await statuses(lib, captured);
    const currentByOwner = new Map(captured.memories.map(m => [m.owner, m]));
    let next: MemoryRevision | undefined;
    for (const owner of targets) {
      const memory = currentByOwner.get(owner);
      check(memory, '摘要已删除，停止更新');
      if (validity.get(memory.id) === 'valid') { targets.delete(owner); continue; }
      const dependencies = await Promise.all(memory.dependencies.map(id => lib.get<MemoryRevision>('memory_revisions', id)));
      if (dependencies.every(m => m && validity.get(currentByOwner.get(m.owner)?.id ?? '') === 'valid')) { next = memory; break; }
    }
    if (!targets.size) break;
    check(next, '请先修复缺失的来源或依赖摘要；已完成部分保留');
    if (next.level) await regenerateHigherSummary(next.hostId);
    else {
      const floor = captured.refs.findIndex(r => r.message === next!.anchor);
      check(floor >= 0 && await regenerateFloor(floor), '本楼无法重新生成，请手改或检查摘要 API 配置');
    }
    const updated = await syncDaily(), validityAfter = await statuses(lib, updated);
    const result = updated.memories.find(m => m.owner === next!.owner);
    check(result && validityAfter.get(result.id) === 'valid', '生成结果仍需审核，请检查来源；完成部分已保存');
    host = hostVersion(); generation = dailyState.generation;
    targets.delete(next.owner); done++; notice.value = `已更新 ${done} 条摘要`;
  }
  notice.value = `${stopped ? '已停止' : '更新完成'}：已保存 ${done} 条摘要。事件概要可单独保留或更新。`;
}
</script>
<template>
  <aside v-if="pending.length || error || notice" class="mn-card mn-summary-review" aria-label="摘要编辑审核">
    <template v-if="pending.length">
      <strong>{{ pending.length }} 条摘要待确认</strong>
      <p>正文或下级摘要有变化。小修正可保留现有摘要；内容有变化可手改或更新。旧版本和事件链仍保留。</p>
      <div class="mn-actions">
        <button :disabled="locked" @click="run(() => keep(pending.map(m => m.id)))">保留全部现有摘要</button>
        <button :disabled="locked" @click="confirmUpdate = true">更新受影响摘要</button>
        <button v-if="busy" @click="stopUpdates">停止后续更新</button>
      </div>
      <details><summary>逐条查看与处理</summary>
        <article v-for="m in pending.slice(page * 10, (page + 1) * 10)" :key="m.id" class="mn-card">
          <small>L{{ m.level }} · {{ states.get(m.id) === 'needs_rebuild' ? '下级摘要有变化' : '来源待确认' }}</small>
          <p class="mn-pre">{{ m.content.slice(0, 300) }}</p>
          <div class="mn-actions"><button :disabled="locked" @click="run(() => keep([m.id]))">保留此摘要</button><button :disabled="locked" @click="edit(m)">手动修订</button></div>
        </article>
        <div class="mn-actions"><button :disabled="!page" @click="page--">上一页</button><span>{{ page + 1 }}</span><button :disabled="(page + 1) * 10 >= pending.length" @click="page++">下一页</button></div>
      </details>
    </template>
    <p v-if="error" role="alert" class="mn-warning">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <ConfirmDialog v-model:open="confirmUpdate" title="更新受影响摘要" confirm-text="确认调用模型" :busy="busy" @confirm="run(rebuild)">
      按依赖顺序重新生成待处理摘要，可能多次调用摘要 API。完成的部分逐条保存，停止或失败会保留已完成部分；不会自动重写事件概要。
    </ConfirmDialog>
    <ModalMask :open="!!editing" @close="!busy && (editing = null)">
      <form class="mn-dialog" role="dialog" aria-label="修订待审核摘要" @submit.prevent="run(saveEdit)">
        <header><h3>手动修订摘要</h3></header><div class="mn-dialog-body"><p>保存表示确认这份摘要适用于当前来源。上级摘要和事件概要可分别保留或更新。</p><TableTextField v-model="draft" label="修订摘要正文" :disabled="busy"/><p v-if="error" role="alert">{{ error }}</p></div>
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
