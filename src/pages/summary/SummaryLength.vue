<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ text: string }>();
const length = computed(() => {
  let count = 0;
  for (const character of props.text) {
    if (/\S/u.test(character)) count++;
  }
  return count;
});
</script>

<template>
  <small class="bbs-summary-length" title="正文字数，含标点，空格与换行不计">{{ length }}字</small>
</template>

<style scoped>
.bbs-summary-length {
  color: var(--bbs-ink-soft);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
