<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import ModalMask from './ModalMask.vue';
import { closeBook } from '@/state/ui';
import { membershipSession, membershipUi, closeMemberships, commitMembershipSelection, membershipSelected, membershipPicking, toggleMembershipRow } from '@/mnemosyne/event-membership-ui';
import { parseFloorRanges } from '@/mnemosyne/event-memberships';
const session = membershipSession;
const form = ref<HTMLElement | null>(null);
const range = ref(''), keyword = ref(''), chainQuery = ref(''), newTitle = ref('');
const creating = ref(false), rowPage = ref(0), chainPage = ref(0);
const selected = membershipSelected, selectedChains = ref(new Set<string>());
const pageSize = 20;
let returnFocus: HTMLElement | null = null;
watch(session, async value => {
  if (!value) { returnFocus?.isConnected && returnFocus.focus({ preventScroll: true }); return; }
  returnFocus = typeof document === 'undefined' ? null : (document.activeElement?.shadowRoot?.activeElement ?? document.activeElement) as HTMLElement;
  range.value = keyword.value = chainQuery.value = newTitle.value = '';
  creating.value = false; rowPage.value = chainPage.value = 0;
  selected.value = new Set(value.mode === 'single' ? value.rows.map(row => row.id) : []);
  selectedChains.value = new Set(value.mode === 'single'
    ? value.cards.filter(card => card.members.some(member => member.memory === value.rows[0].id)).map(card => card.chain.id)
    : value.target ? [value.target] : []);
  await nextTick(); form.value?.focus({ preventScroll: true });
});
watch(membershipPicking, async picking => {
  if (!picking && session.value) { await nextTick(); form.value?.focus({ preventScroll: true }); }
});
watch([range, keyword], () => { rowPage.value = 0; });
watch(chainQuery, () => { chainPage.value = 0; });
const filter = computed(() => {
  try {
    const floors = parseFloorRanges(range.value, (session.value?.view.refs.length ?? 1) - 1);
    const q = keyword.value.trim().toLocaleLowerCase();
    return { error: '', rows: (session.value?.rows ?? []).filter(row => (!floors || floors.has(row.floor)) &&
      (!q || row.text.toLocaleLowerCase().includes(q) || row.time.toLocaleLowerCase().includes(q))) };
  } catch (error) { return { error: (error as Error).message, rows: [] }; }
});
const pageRows = computed(() => filter.value.rows.slice(rowPage.value * pageSize, (rowPage.value + 1) * pageSize));
const chainRows = computed(() => (session.value?.cards ?? []).filter(card => card.meta.title.toLocaleLowerCase().includes(chainQuery.value.trim().toLocaleLowerCase())));
const pageChains = computed(() => chainRows.value.slice(chainPage.value * pageSize, (chainPage.value + 1) * pageSize));
const pickedRows = computed(() => session.value?.rows.filter(row => selected.value.has(row.id)) ?? []);
const allowed = computed(() => session.value?.mode !== 'single' || !!session.value.rows[0]?.valid);
const initialChains = computed(() => new Set(session.value?.mode === 'single'
  ? session.value.cards.filter(card => card.members.some(member => member.memory === session.value!.rows[0].id)).map(card => card.chain.id) : []));
const counts = computed(() => {
  if (!session.value) return { added: 0, removed: 0, already: 0 };
  let added = creating.value && newTitle.value.trim() ? selected.value.size : 0, removed = 0, already = 0;
  for (const card of session.value.cards) {
    const members = new Set(card.members.map(member => member.memory));
    for (const id of selected.value) {
      if (selectedChains.value.has(card.chain.id)) members.has(id) ? already++ : added++;
      else if (session.value.mode === 'single' && members.has(id)) removed++;
    }
  }
  return { added, removed, already };
});
const canSave = computed(() => !!session.value && !membershipUi.saving && !filter.value.error && selected.value.size > 0 &&
  (!creating.value || !!newTitle.value.trim() && newTitle.value.trim().length <= 300) &&
  (session.value.mode === 'single' || (creating.value ? !!newTitle.value.trim() : selectedChains.value.size === 1)) &&
  (counts.value.added > 0 || counts.value.removed > 0 || counts.value.already > 0));
function toggleRow(id: string) {
  if (membershipUi.saving) return;
  toggleMembershipRow(id);
}
function selectRows(all: boolean) {
  const next = new Set(selected.value);
  for (const row of (all ? filter.value.rows : pageRows.value)) if (row.valid) next.add(row.id);
  selected.value = next;
}
function toggleChain(id: string) {
  if (membershipUi.saving) return;
  if (session.value?.mode === 'bulk') { selectedChains.value = new Set([id]); creating.value = false; return; }
  const next = new Set(selectedChains.value); next.has(id) ? next.delete(id) : next.add(id); selectedChains.value = next;
}
function toggleCreate() {
  creating.value = !creating.value;
  if (creating.value && session.value?.mode === 'bulk') selectedChains.value = new Set();
}
async function save() {
  if (!canSave.value || !session.value) return;
  await commitMembershipSelection({ mode: session.value.mode === 'single' ? 'replace' : 'add', memories: [...selected.value],
    eventIds: [...selectedChains.value], ...(creating.value ? { newTitle: newTitle.value } : {}) });
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMemberships(); return; }
  if (event.key !== 'Tab') return;
  const elements = [...(form.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])];
  const first = elements[0], last = elements.at(-1), active = form.value?.getRootNode() as Document | ShadowRoot;
  if (!first || !last) { event.preventDefault(); return; }
  if (event.shiftKey && (active.activeElement === first || active.activeElement === form.value)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (active.activeElement === last || active.activeElement === form.value)) { event.preventDefault(); first.focus(); }
}
</script>
<template>
  <ModalMask :open="!!session && !membershipPicking" top-layer @close="closeMemberships">
    <form v-if="session" ref="form" class="mn-dialog mn-membership-dialog" :class="{ 'mn-membership-single': session.mode === 'single' }" role="dialog" aria-modal="true" tabindex="-1"
      :aria-label="session.mode === 'single' ? '管理事件链关联' : '批量加入事件链'" @submit.prevent="save" @keydown.stop="keyboard">
      <header><h3>{{ session.mode === 'single' ? `楼层 #${session.floor} 的事件链` : '批量加入事件链' }}</h3>
        <button type="button" :disabled="membershipUi.saving" aria-label="关闭事件链关联" @click="closeMemberships">关闭</button></header>
      <div class="mn-dialog-body">
        <template v-if="session.mode === 'bulk'">
          <label>楼层范围<input v-model="range" :disabled="membershipUi.saving" placeholder="全部楼层，或 100-150,180" aria-label="楼层范围" /></label>
          <label>摘要关键词<input v-model="keyword" :disabled="membershipUi.saving" placeholder="按摘要文字或剧情时间筛选" aria-label="摘要关键词" /></label>
          <p v-if="filter.error" class="mn-warning" role="alert">{{ filter.error }}</p>
          <p class="mn-muted">匹配 {{ filter.rows.length }} 条逐楼摘要，已选 {{ selected.size }} 条。翻页和筛选保留选择；无效摘要不能新增关联。</p>
          <div class="mn-actions"><button type="button" :disabled="membershipUi.saving" @click="selectRows(false)">选择本页</button>
            <button type="button" :disabled="membershipUi.saving || !!filter.error" @click="selectRows(true)">选择全部筛选结果</button>
            <button type="button" :disabled="membershipUi.saving || !selected.size" @click="selected = new Set()">清空选择</button></div>
          <div class="mn-membership-rows">
            <label v-for="row in pageRows" :key="row.id" class="mn-member-choice">
              <input type="checkbox" :checked="selected.has(row.id)" :disabled="membershipUi.saving || !row.valid" @change="toggleRow(row.id)" />
              <span><strong>#{{ row.floor }}</strong> <small>{{ row.time }}</small><small v-if="!row.valid"> · 待审核或不参与记忆</small><br />{{ row.text.slice(0, 140) }}</span>
            </label>
          </div>
          <div class="mn-actions"><button type="button" :disabled="membershipUi.saving || rowPage === 0" @click="rowPage--">上一页摘要</button>
            <span>{{ rowPage + 1 }} / {{ Math.max(1, Math.ceil(filter.rows.length / pageSize)) }}</span>
            <button type="button" :disabled="membershipUi.saving || (rowPage + 1) * pageSize >= filter.rows.length" @click="rowPage++">下一页摘要</button></div>
          <button type="button" :disabled="membershipUi.saving" @click="membershipPicking = true; closeBook()">从聊天摘要卡勾选</button>
          <p class="mn-muted">批量操作只向下面的一条链加入，不移除摘要原有的其他关联。</p>
        </template>
        <template v-else>
          <p v-if="!allowed" class="mn-warning">本楼摘要待审核或不参与记忆；可以解除已有关联，新增前请先处理摘要。</p>
          <p class="mn-muted">勾选加入，取消勾选移除。新建链会和本楼关联一起保存；概要可在事件页更新。</p>
        </template>
        <label>查找事件链<input v-model="chainQuery" :disabled="membershipUi.saving" placeholder="输入链名" aria-label="查找事件链" /></label>
        <div class="mn-membership-chains">
          <label v-for="card in pageChains" :key="card.chain.id" class="mn-member-choice">
            <input :type="session.mode === 'single' ? 'checkbox' : 'radio'" name="event-membership-target"
              :checked="selectedChains.has(card.chain.id)" :disabled="membershipUi.saving || (!allowed && !initialChains.has(card.chain.id))" @change="toggleChain(card.chain.id)" />
            <span>{{ card.meta.title }}<small v-if="card.chain.archived"> · 已归档</small><small v-if="card.blocked || card.needsReview"> · 待审核</small></span>
          </label>
          <p v-if="!chainRows.length" class="mn-muted">{{ session.cards.length ? '没有匹配的事件链' : '还没有事件链，可以在下面新建' }}</p>
        </div>
        <div v-if="chainRows.length > pageSize" class="mn-actions"><button type="button" :disabled="membershipUi.saving || chainPage === 0" @click="chainPage--">上一页事件链</button>
          <span>{{ chainPage + 1 }} / {{ Math.ceil(chainRows.length / pageSize) }}</span>
          <button type="button" :disabled="membershipUi.saving || (chainPage + 1) * pageSize >= chainRows.length" @click="chainPage++">下一页事件链</button></div>
        <button type="button" :disabled="membershipUi.saving || !allowed" @click="toggleCreate">{{ creating ? '取消新建事件链' : '新建事件链' }}</button>
        <label v-if="creating">新事件链名称<input v-model="newTitle" :disabled="membershipUi.saving" maxlength="300" placeholder="填写链名，保存时创建" aria-label="新事件链名称" /></label>
        <p role="status">已选 {{ selected.size }} 条摘要 · 新增 {{ counts.added }} 条关联 · 已在链中 {{ counts.already }} 条<span v-if="session.mode === 'single'"> · 移除 {{ counts.removed }} 条关联</span></p>
        <p v-if="membershipUi.error" class="mn-warning" role="alert">{{ membershipUi.error }}</p>
      </div>
      <footer><button type="button" :disabled="membershipUi.saving" @click="closeMemberships">取消</button>
        <button class="mn-primary" :disabled="!canSave">{{ membershipUi.saving ? '保存中…' : session.mode === 'single' ? '保存关联' : '确认加入' }}</button></footer>
    </form>
  </ModalMask>
  <aside v-if="session && membershipPicking" class="mn-membership-picking" aria-label="事件链多选" role="region">
    <span>在聊天摘要卡勾选 · 已选 {{ selected.size }} 条</span>
    <button type="button" @click="membershipPicking = false">选择目标链</button>
    <button type="button" @click="closeMemberships">取消</button>
  </aside>
</template>
<style scoped>
.mn-membership-picking { position: fixed; bottom: max(12px, env(safe-area-inset-bottom)); left: 12px; right: 12px; z-index: 10001; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--bbs-line); border-radius: 10px; background: var(--bbs-bg, #222); color: var(--bbs-ink); box-shadow: 0 4px 18px #0004; }
.mn-membership-dialog { width: min(600px, calc(100vw - 24px)); max-height: min(92vh, 900px); max-height: min(92dvh, 900px); }
.mn-membership-single { height: min(760px, 92vh); height: min(760px, 92dvh); }
.mn-membership-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0; }
.mn-membership-dialog header h3 { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.mn-membership-dialog header button { flex-shrink: 0; }
.mn-membership-dialog .mn-dialog-body { display: flex; flex: 1 1 auto; flex-direction: column; gap: 12px; padding-top: 12px; }
.mn-membership-dialog .mn-dialog-body > * { flex-shrink: 0; }
.mn-membership-dialog label { display: flex; flex-direction: column; gap: 6px; margin: 0; }
.mn-membership-dialog input:not([type=checkbox]):not([type=radio]) { width: 100%; min-width: 0; box-sizing: border-box; }
.mn-membership-dialog .mn-member-choice { flex-direction: row; align-items: flex-start; gap: 9px; margin: 0; padding: 8px 0; border-bottom: 1px solid var(--bbs-line); }
.mn-membership-dialog .mn-member-choice input { flex: 0 0 16px; width: 16px; height: 16px; padding: 0; margin: 4px 0 0; accent-color: var(--bbs-accent); }
.mn-member-choice span { min-width: 0; overflow-wrap: anywhere; }
.mn-member-choice small { opacity: .7; }
.mn-membership-rows, .mn-membership-chains { max-height: 240px; overflow-y: auto; }
.mn-membership-single .mn-membership-chains { flex: 1 0 180px; max-height: 420px; overscroll-behavior: contain; }
.mn-membership-dialog .mn-actions { margin: 0; }
.mn-membership-dialog footer { flex-wrap: wrap; }
</style>
