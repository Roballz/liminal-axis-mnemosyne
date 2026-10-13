<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { getContext } from '@/st/context';
import { getLeaf } from '@/memory/apply';
import { derivedMeta } from '@/memory/store';
import { membershipBadges, membershipUi, openMemberships, membershipPicking, membershipRowsByHost, membershipSelected, toggleMembershipRow } from '@/mnemosyne/event-membership-ui';
import { manualEventState } from '@/mnemosyne/manual-events';
import { jobState } from '@/mnemosyne/jobs';
const props = defineProps<{ floor: number; disabled?: boolean; leafId?: string }>();
let live = true;
onBeforeUnmount(() => { live = false; });
function open() {
  const expectedLeafId = props.leafId ?? getLeaf(getContext()?.chat?.[props.floor])?.id;
  void openMemberships({ floor: props.floor, expectedLeafId, isCurrent: () => live });
}
const hostId = computed(() => { void derivedMeta.rev; return props.leafId ?? getLeaf(getContext()?.chat?.[props.floor])?.id; });
const pickingRow = computed(() => hostId.value ? membershipRowsByHost.value.get(hostId.value) : undefined);
const entries = computed(() => {
  void derivedMeta.rev;
  const id = props.leafId ?? getLeaf(getContext()?.chat?.[props.floor])?.id;
  return id ? membershipBadges.value?.get(id) ?? [] : [];
});
const label = computed(() => entries.value.length
  ? `事件链：${entries.value[0].title}${entries.value.length > 1 ? ` +${entries.value.length - 1}` : ''}`
  : membershipBadges.value ? '加入事件链' : '事件链 · 待刷新');
const detail = computed(() => entries.value.map(item => `${item.title}${item.archived ? '（已归档）' : ''}${item.needsReview ? '（待审核）' : ''}`).join('、'));
const blocked = computed(() => membershipUi.loading || membershipUi.saving || manualEventState.busy || jobState.busy || (props.disabled && !entries.value.length));
</script>
<template>
  <label v-if="membershipPicking" class="mn-floor-pick" @click.stop @keydown.stop>
    <input type="checkbox" :checked="!!pickingRow && membershipSelected.has(pickingRow.id)" :disabled="!pickingRow?.valid || membershipUi.saving"
      @change="pickingRow && toggleMembershipRow(pickingRow.id)" />加入选择
  </label>
  <button v-else class="mn-floor-event bbs-btn bbs-btn-sm" type="button" aria-haspopup="dialog" :disabled="blocked"
    :title="detail || label" :aria-label="label" @click.stop="open" @keydown.stop>
    <Icon name="events" :size="14" /><span>{{ label }}</span>
  </button>
</template>
<style scoped>
.mn-floor-pick { display: inline-flex; align-items: center; gap: 8px; padding: 5px; font-size: 12px; }
.mn-floor-event { display: inline-flex; align-items: center; justify-content: flex-start; gap: 5px; min-width: 0; max-width: 100%; }
.mn-floor-event span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
