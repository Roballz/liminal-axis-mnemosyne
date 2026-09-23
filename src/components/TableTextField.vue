<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
defineProps<{ modelValue: string; label: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const area = ref<HTMLTextAreaElement | null>(null);
let cleanup: (() => void) | undefined;
function resize(event: PointerEvent) {
  if (!area.value) return;
  event.preventDefault();
  const start = event.clientY,
    height = area.value.offsetHeight;
  const move = (e: PointerEvent) => {
    if (area.value) area.value.style.height = `${Math.max(84, Math.min(900, height + e.clientY - start))}px`;
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    cleanup = undefined;
  };
  cleanup?.();
  cleanup = stop;
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}
function enlarge() {
  if (area.value) area.value.style.height = `${Math.min(900, area.value.offsetHeight + 80)}px`;
}
onBeforeUnmount(() => cleanup?.());
</script>
<template>
  <div class="mn-text-field">
    <textarea
      ref="area"
      :aria-label="label"
      :value="modelValue"
      :disabled="disabled"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    /><button
      type="button"
      class="mn-resize"
      :aria-label="`拉大${label}输入框`"
      title="拖动拉大；键盘点击逐步拉大"
      @pointerdown="resize"
      @click="enlarge"
    >
      ◢
    </button>
  </div>
</template>
