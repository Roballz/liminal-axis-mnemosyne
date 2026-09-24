<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import ModalMask from "./ModalMask.vue";
import TableTextField from "./TableTextField.vue";
import { eventJsonText } from "@/mnemosyne/event-response";
const props = defineProps<{
  review: { raw: string; title: string };
  label: string;
  editorLabel: string;
  description: string;
  validate: (text: string) => string;
  busy: boolean;
  saveError: string;
}>();
const emit = defineEmits<{ cancel: []; confirm: [text: string] }>();
const draft = ref(eventJsonText(props.review.raw));
const error = computed(() => props.validate(draft.value));
const originalError = props.validate(props.review.raw);
const panel = ref<HTMLElement | null>(null);
onMounted(() => panel.value?.focus({ preventScroll: true }));
function trapFocus(event: KeyboardEvent) {
  const targets = [
    ...panel.value!.querySelectorAll<HTMLElement>(
      "button:not(:disabled), textarea, summary",
    ),
  ].filter((el) => el.getClientRects().length);
  const index = targets.findIndex((el) => event.composedPath().includes(el));
  if (
    index < 0 ||
    (!event.shiftKey && index === targets.length - 1) ||
    (event.shiftKey && index === 0)
  ) {
    event.preventDefault();
    targets[event.shiftKey ? targets.length - 1 : 0]?.focus();
  }
}
</script>
<template>
  <ModalMask open top-layer>
    <form
      ref="panel"
      class="mn-dialog mn-event-review"
      role="dialog"
      aria-modal="true"
      :aria-label="label"
      tabindex="-1"
      @keydown.esc.stop.prevent
      @keydown.tab="trapFocus"
      @submit.prevent="!busy && !error && emit('confirm', draft)"
    >
      <header>
        <h3>{{ label }}</h3>
        <small>{{ review.title }} · 尚未入库</small>
      </header>
      <div class="mn-dialog-body">
        <p>{{ description }}</p>
        <div
          class="mn-review-status"
          :class="{ 'mn-review-invalid': error || saveError }"
          role="status"
          aria-live="polite"
        >
          <strong>{{
            error ? "格式未通过，尚未保存" : "格式通过，等待确认"
          }}</strong>
          <p v-if="error">{{ error }}</p>
          <p v-if="saveError">{{ saveError }}</p>
        </div>
        <label
          >待保存 JSON<TableTextField
            v-model="draft"
            :label="editorLabel"
            :disabled="busy"
        /></label>
        <details>
          <summary>填写格式说明</summary>
          <slot name="format" />
        </details>
        <details>
          <summary>AI 返回正文（原样 · {{ review.raw.length }} 字符）</summary>
          <p>
            {{
              originalError
                ? "原始返回校验：" + originalError
                : "原始返回格式有效。"
            }}
          </p>
          <p>
            这里只显示接口提供的输出正文，不含独立思考内容或网络响应头。截断原因需结合
            API 设置判断。
          </p>
          <pre aria-label="AI 原始返回">{{
            review.raw || "（返回正文为空）"
          }}</pre>
        </details>
      </div>
      <footer>
        <button type="button" :disabled="busy" @click="emit('cancel')">
          取消
        </button>
        <button class="mn-primary" :disabled="busy || !!error">
          {{ busy ? "正在保存…" : "确认写入" }}
        </button>
      </footer>
    </form>
  </ModalMask>
</template>
<style scoped>
.mn-event-review {
  width: min(680px, calc(100vw - 28px));
  outline: none;
}
.mn-event-review header small {
  display: block;
  overflow-wrap: anywhere;
}
.mn-review-status {
  margin: 14px 0;
  padding: 12px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: 10px;
  background: var(--bbs-accent-soft);
  font-size: 13px;
}
.mn-review-status p {
  color: inherit;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.mn-review-invalid {
  background: var(--bbs-surface-2);
  border-left: 3px solid var(--bbs-accent);
}
.mn-event-review label {
  margin-top: 14px;
}
.mn-event-review :deep(textarea) {
  min-height: 240px;
  font-family: var(--bbs-font-mono);
  font-size: 13px;
  tab-size: 2;
}
.mn-event-review details {
  border-top: 1px solid var(--bbs-line);
  padding: 12px 0;
}
.mn-event-review summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--bbs-ink-soft);
}
.mn-event-review pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.7 var(--bbs-font-mono);
  background: var(--bbs-surface-2);
  border-radius: 10px;
  padding: 12px;
  max-height: 280px;
  overflow: auto;
}
</style>
