<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { getContext } from '@/st/context';
import { getLeaf } from '@/memory/apply';
import { derivedMeta } from '@/memory/store';
import { membershipBadges, membershipUi, openMemberships, membershipPicking, membershipRowsByHost, membershipSelected, toggleMembershipRow } from '@/mnemosyne/event-membership-ui';
import { manualEventState } from '@/mnemosyne/manual-events';
import { jobState } from '@/mnemosyne/jobs';
const props = defineProps<{ floor: number; disabled?: boolean; leafId?: string; compact?: boolean }>();
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
const names = computed(() => entries.value.map(item => item.title).join('，'));
// A missing projection is unknown/stale, never evidence of no formal memberships.
const label = computed(() => membershipUi.loading ? '事件链 · 加载中'
  : !membershipBadges.value ? '事件链 · 待刷新'
  : entries.value.length ? `相关事件:${names.value}`
  : '本楼层尚未加入事件链');
const muted = computed(() => membershipUi.loading || !membershipBadges.value || !entries.value.length);
const detail = computed(() => entries.value.map(item => `${item.title}${item.archived ? '（已归档）' : ''}${item.needsReview ? '（待审核）' : ''}`).join('，'));
const actionLabel = computed(() => `管理本楼层事件链关联：${label.value}`);
const blocked = computed(() => membershipUi.loading || membershipUi.saving || manualEventState.busy || jobState.busy || (props.disabled && !entries.value.length));
</script>
<template>
  <label v-if="membershipPicking" class="mn-floor-pick" @click.stop @keydown.stop>
    <input type="checkbox" :checked="!!pickingRow && membershipSelected.has(pickingRow.id)" :disabled="!pickingRow?.valid || membershipUi.saving"
      @change="pickingRow && toggleMembershipRow(pickingRow.id)" />加入选择
  </label>
  <div v-else class="mn-floor-event-row" :class="{ 'is-compact': compact }">
    <span class="mn-floor-event-text" :class="{ 'is-muted': muted, 'is-linked': !muted }" :title="detail || label">
      <template v-if="!muted"><span class="mn-floor-event-label">相关事件:</span><span class="mn-floor-event-names">{{ names }}</span></template>
      <template v-else>{{ label }}</template>
    </span>
    <span class="mn-floor-event-actions">
      <button class="mn-floor-event" type="button" aria-haspopup="dialog" :disabled="blocked"
        :title="actionLabel" :aria-label="actionLabel" @click.stop="open" @keydown.stop>
        <Icon name="events" :size="14" />
      </button>
    </span>
  </div>
</template>
<style scoped>
.mn-floor-pick { display: inline-flex; align-items: center; gap: 8px; padding: 5px; font-size: 12px; }
.mn-floor-event-row { display: grid; grid-template-columns: minmax(0, 1fr) var(--mn-floor-actions-width, 60px); align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 26px; }
.mn-floor-event-text { min-width: 0; font-size: 12px; line-height: 18px; text-align: left; color: var(--bbs-ink); font-style: normal; white-space: normal; overflow-wrap: anywhere; }
.mn-floor-event-text.is-linked { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; column-gap: 4px; }
.mn-floor-event-label { white-space: nowrap; }
/* A stable compact size keeps wrapped names readable without layout measurement or font-size oscillation. */
.mn-floor-event-names { min-width: 0; font-size: 11px; line-height: 16px; }
:global(.bbs-root[data-theme='night'] .mn-floor-event-text:not(.is-muted)) { color: #fff; }
.mn-floor-event-text.is-muted { color: var(--bbs-ink-soft); font-style: italic; }
.mn-floor-event-row.is-compact .mn-floor-event-text { font-size: 10px; line-height: 16px; color: inherit; opacity: .7; }
.mn-floor-event-row.is-compact .mn-floor-event-names { font-size: inherit; line-height: inherit; }
.mn-floor-event-actions { display: flex; justify-content: center; }
.mn-floor-event { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--bbs-radius-sm); background: transparent; color: var(--bbs-ink-muted); cursor: pointer; }
.mn-floor-event:hover:not(:disabled) { color: var(--bbs-accent); background: var(--bbs-surface-2); }
.mn-floor-event:focus-visible { outline: 2px solid var(--bbs-accent); outline-offset: 2px; }
.mn-floor-event:disabled { opacity: 0.5; cursor: default; }
</style>
