<script setup lang="ts">
import { computed, inject } from 'vue';
import Icon from '@/components/Icon.vue';
import { SUMMARY_CTX, type SummaryRow } from './ctx';
import SummaryLength from './SummaryLength.vue';
import SummaryTags from './SummaryTags.vue';
import { summaryPreview } from './preview';

const props = defineProps<{ row: SummaryRow; child?: boolean }>();
const ctx = inject(SUMMARY_CTX)!;
const open = computed(() => ctx.openTexts.value.has(props.row.id));
const summary = computed(() => props.row.kind === 'comp');
const compact = computed(() => summary.value && (!open.value || ctx.selectMode.value));
const relative = computed(() => ctx.rowRelative(props.row));
const time = computed(() => ctx.rowTime(props.row));
const preview = computed(() => summaryPreview(props.row.text, ctx.searchQuery.value.trim()));
const toggleLabel = computed(() => open.value ? '收起总结全文' : '展开总结全文');
</script>

<template>
  <SummaryTags v-if="row.kind === 'leaf' && row.msgIndex !== undefined" :floor="row.msgIndex" :leaf-id="row.id" />
  <header class="bbs-summary-meta" :class="{ 'can-toggle-text': summary && !ctx.selectMode.value }">
    <template v-if="summary">
      <span v-if="ctx.selectMode.value" class="bbs-summary-badge">{{ ctx.levelLabel(row.level, row.imported) }}</span>
      <button v-else type="button" class="bbs-summary-badge bbs-summary-text-toggle"
        :aria-expanded="open" :aria-label="toggleLabel" :title="toggleLabel" @click="ctx.toggleText(row.id)">
        {{ ctx.levelLabel(row.level, row.imported) }}
        <Icon name="chevron" class="bbs-summary-text-caret" :class="{ closed: !open }" />
      </button>
    </template>
    <span v-else-if="relative" class="bbs-summary-rel">{{ relative }}</span>
    <span class="bbs-summary-loc">{{ ctx.floorLabel(row) }}</span>
    <SummaryLength :text="row.text" />
    <span v-if="summary && relative" class="bbs-summary-rel">({{ relative }})</span>
    <span v-if="time" :class="summary ? 'bbs-summary-time' : 'bbs-summary-dateline'">{{ time }}</span>
    <span v-if="row.stale" class="bbs-summary-stale">待更新</span>
    <span v-if="!ctx.selectMode.value" class="bbs-summary-acts">
      <button class="bbs-summary-act" type="button" :title="row.imported ? '编辑导入历史' : summary ? '编辑总结' : '编辑摘要'" @click="ctx.openEdit(row)">
        <Icon name="edit" />
      </button>
      <button v-if="!child" class="bbs-summary-act bbs-summary-del" type="button" :title="row.imported ? '删除导入历史' : summary ? '删除总结(下层会展开)' : '删除摘要'" @click="ctx.onDelete(row)">
        <Icon name="trash" />
      </button>
    </span>
  </header>

  <p v-if="compact" class="bbs-summary-preview">
    <span v-for="(line, i) in preview" :key="i" class="bbs-preview-line" :class="{ 'clip-start': i > 0 && line.startsWith('…') }">
      <bdi>
        <template v-if="ctx.searching.value">
          <template v-for="(seg, j) in ctx.highlightParts(line)" :key="j">
            <mark v-if="seg.hit" class="bbs-hit">{{ seg.t }}</mark>
            <template v-else>{{ seg.t }}</template>
          </template>
        </template>
        <template v-else>{{ line }}</template>
      </bdi>
    </span>
  </p>
  <p v-else class="bbs-summary-text">
    <template v-if="ctx.searching.value">
      <template v-for="(seg, i) in ctx.highlightParts(row.text)" :key="i">
        <mark v-if="seg.hit" class="bbs-hit">{{ seg.t }}</mark>
        <template v-else>{{ seg.t }}</template>
      </template>
    </template>
    <template v-else>{{ row.text }}</template>
  </p>
</template>

<style scoped>
.can-toggle-text {
  position: relative;
  isolation: isolate;
}
.bbs-summary-text-toggle {
  gap: 3px;
  cursor: pointer;
  font-family: inherit;
}
/* The badge's native button also covers the date and floor. Keep edit/delete above it. */
.bbs-summary-text-toggle::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
}
.can-toggle-text .bbs-summary-acts {
  position: relative;
  z-index: 2;
}
.bbs-summary-text-caret {
  width: 11px;
  height: 11px;
}
.bbs-summary-text-caret.closed {
  transform: rotate(-90deg);
}
.bbs-summary-preview {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--bbs-ink-muted);
  color: color-mix(in srgb, var(--bbs-ink-soft) 65%, var(--bbs-ink-muted));
}
.bbs-preview-line {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-preview-line.clip-start {
  direction: rtl;
  text-align: left;
}
.bbs-hit {
  background: var(--bbs-accent-soft);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}
</style>
