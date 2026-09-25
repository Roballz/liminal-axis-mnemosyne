<script setup lang="ts">
import { computed, ref } from 'vue';
import ModalMask from '@/components/ModalMask.vue';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { getLeaf, editLeafTags } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import { normalizeTags, planTitle, type SummaryTags } from '@/memory/contextTags';
import { currentEventHints, dailyInstalled, dailyState, hostVersion, syncDaily } from '@/mnemosyne/bridge';
import { refreshInjection } from '@/memory/inject';

const props = defineProps<{ floor: number; leafId: string }>();
const tags = computed(() => {
  void derivedMeta.rev;
  const leaf = getLeaf(getContext()?.chat?.[props.floor]);
  return leaf?.id === props.leafId ? normalizeTags(leaf.tags) : undefined;
});
const events = computed(() => { void dailyState.revision; return currentEventHints(); });
const links = computed(() => [
  ...memory.plans.filter(p => tags.value?.planIds.includes(p.id)).map(p => `${p.kind === 'suspense' ? '悬念' : '计划'} · ${planTitle(p)}`),
  ...events.value.filter(e => tags.value?.eventIds.includes(e.id)).map(e => `事件 · ${e.title}`),
]);
const opened = ref(false), busy = ref(false), publicOnly = ref(false);
const participants = ref(''), reason = ref(''), planIds = ref<string[]>([]), eventIds = ref<string[]>([]);
let expectedHost = '';
async function open(publication = false) {
  busy.value = true;
  const chat = getContext()?.chat;
  try {
    if (dailyInstalled()) await syncDaily();
    if (getContext()?.chat !== chat || getLeaf(chat?.[props.floor])?.id !== props.leafId) throw new Error('摘要已改变，请重新打开');
    expectedHost = hostVersion();
    publicOnly.value = publication;
    participants.value = tags.value?.participants?.join('、') ?? '';
    reason.value = tags.value?.public?.reason ?? '';
    planIds.value = [...(tags.value?.planIds ?? [])];
    eventIds.value = [...(tags.value?.eventIds ?? [])];
    opened.value = true;
  } catch (error) { toast((error as Error).message, 'warning'); }
  finally { busy.value = false; }
}
async function persist(value: SummaryTags) {
  if (!editLeafTags(props.floor, props.leafId, value)) throw new Error('摘要已改变，请重新打开');
  refreshInjection();
  if (dailyInstalled()) await syncDaily();
}
async function togglePublic() {
  if (!tags.value?.public) return open(true);
  busy.value = true;
  try { const next = { ...tags.value }; delete next.public; await persist(next); }
  catch (error) { toast((error as Error).message, 'warning'); }
  finally { busy.value = false; }
}
async function save() {
  if (expectedHost !== hostVersion()) { toast('聊天或摘要已改变，请重新打开编辑窗口', 'warning'); return; }
  if (publicOnly.value && !reason.value.trim()) return;
  const next: SummaryTags = publicOnly.value
    ? { ...(tags.value ?? { version: 1, planIds: [], eventIds: [] }), public: { reason: reason.value.trim() } }
    : { version: 1, participants: participants.value.split(/[、,，\n]/).map(s => s.trim()).filter(Boolean),
      planIds: planIds.value, eventIds: eventIds.value, ...(tags.value?.public ? { public: tags.value.public } : {}) };
  busy.value = true;
  try { await persist(next); opened.value = false; }
  catch (error) { toast((error as Error).message, 'warning'); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="bbs-tags-top">
    <button class="bbs-tag-names" type="button" title="编辑在场人物和关联事项" :disabled="busy" @click.stop="open()">
      <span v-for="name in tags?.participants" :key="name">{{ name }}</span>
      <span v-if="!tags?.participants?.length" class="bbs-tag-empty">{{ tags?.participants ? '未标记人物' : '添加人物' }}</span>
    </button>
    <button class="bbs-tag-public" type="button" :class="{ 'is-on': tags?.public }" :aria-pressed="!!tags?.public" :title="tags?.public?.reason || '标为公开并填写原因'" :disabled="busy" @click.stop="togglePublic">公开</button>
  </div>
  <div v-if="links.length" class="bbs-tag-links"><span v-for="link in links" :key="link">{{ link }}</span></div>
  <ModalMask :open="opened" @close="opened = false">
    <div class="bbs-modal bbs-tags-modal" role="dialog" aria-modal="true" :aria-label="publicOnly ? '公开理由' : '编辑摘要标签'" @click.stop>
      <header class="bbs-modal-head"><strong>{{ publicOnly ? '公开理由' : '摘要标签' }}</strong><button class="bbs-btn" @click="opened = false">关闭</button></header>
      <template v-if="publicOnly">
        <p>说明在场人物之外的人可能如何得知这些事。</p>
        <textarea v-model="reason" class="bbs-input" rows="3" maxlength="200" placeholder="例如：被意外直播泄露" />
      </template>
      <template v-else>
        <label>在场人物<input v-model="participants" class="bbs-input" placeholder="名字之间用顿号分隔" /></label>
        <fieldset v-if="memory.plans.length"><legend>计划／悬念</legend>
          <label v-for="p in memory.plans" :key="p.id"><input v-model="planIds" type="checkbox" :value="p.id" />{{ planTitle(p) }}<small>{{ p.status === 'resolved' ? '已了结' : '' }}</small></label>
        </fieldset>
        <fieldset v-if="events.length"><legend>相关事件</legend>
          <label v-for="e in events" :key="e.id"><input v-model="eventIds" type="checkbox" :value="e.id" />{{ e.title }}</label>
          <small>这里只调整召回关联，正式事件链成员在事件页管理。</small>
        </fieldset>
      </template>
      <footer class="bbs-modal-foot"><button class="bbs-btn" @click="opened = false">取消</button><button class="bbs-btn bbs-btn-primary" :disabled="busy || (publicOnly && !reason.trim())" @click="save">保存</button></footer>
    </div>
  </ModalMask>
</template>

<style scoped>
.bbs-tags-top { display:flex; align-items:center; gap:10px; padding:7px 0; margin-bottom:6px; border-bottom:1px solid var(--bbs-line); }
.bbs-tag-names { display:flex; flex-wrap:wrap; gap:5px; flex:1; text-align:left; border:0; background:none; padding:0; color:inherit; cursor:pointer; }
.bbs-tag-names span { font-size:11px; padding:2px 7px; border-radius:4px; background:color-mix(in srgb, var(--bbs-accent, #b89b60) 14%, transparent); }
.bbs-tag-empty { opacity:.65; }
.bbs-tag-public { border:1px solid var(--bbs-line); background:none; color:inherit; opacity:.65; border-radius:12px; padding:3px 9px; font-size:11px; cursor:pointer; }
.bbs-tag-public.is-on { opacity:1; color:var(--bbs-accent, #b89b60); border-color:currentColor; }
.bbs-tag-links { display:flex; flex-wrap:wrap; gap:5px 12px; font-size:10px; opacity:.7; margin-bottom:7px; }
.bbs-tags-modal { display:flex; flex-direction:column; gap:14px; }
.bbs-tags-modal fieldset { max-height:180px; overflow:auto; border:1px solid var(--bbs-line); border-radius:6px; }
.bbs-tags-modal label { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:5px; }
.bbs-tags-modal label > .bbs-input { width:100%; }
</style>
