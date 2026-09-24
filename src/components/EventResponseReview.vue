<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import ModalMask from "./ModalMask.vue";
import TableTextField from "./TableTextField.vue";
import { eventJsonText, eventResponseError } from "@/mnemosyne/event-response";
import type { EventReview } from "@/mnemosyne/manual-events";
const props = defineProps<{
  review: EventReview;
  busy: boolean;
  saveError: string;
}>();
const emit = defineEmits<{ cancel: []; confirm: [text: string] }>();
const draft = ref(eventJsonText(props.review.raw));
const error = computed(() => eventResponseError(draft.value));
const originalError = eventResponseError(props.review.raw);
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
      aria-label="审阅事件返回"
      tabindex="-1"
      @keydown.esc.stop.prevent
      @keydown.tab="trapFocus"
      @submit.prevent="!busy && !error && emit('confirm', draft)"
    >
      <header>
        <h3>审阅事件返回</h3>
        <small>{{ review.title }} · 尚未入库</small>
      </header>
      <div class="mn-dialog-body">
        <p>
          检查或修改下方
          JSON，确认后才保存事件及本次关联。修改和确认不会再次调用
          API，取消不保存。
        </p>
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
            label="待保存事件 JSON"
            :disabled="busy"
        /></label>
        <details>
          <summary>填写格式说明</summary>
          <p>
            五个字段均需保留；键名、文本用英文双引号，字段间用英文逗号。文本中的换行写成
            \n，双引号写成
            \"。状态使用下面的英文值，关键词用数组。标题、状态、关键词和概要按草稿保存；progress
            只为未整理成员追加进展，重写已整理内容不新增历史进展。
          </p>
          <pre>{{
            JSON.stringify(
              {
                title: "事件标题",
                status: "open",
                keywords: ["关键词"],
                overview: "不超过500字的事件核心变化与关系转变",
                progress: "本次新增进展，没有则填空字符串",
              },
              null,
              2,
            )
          }}</pre>
          <p>
            status：open 进行中 / resolved 已结束 / dormant
            暂搁。overview：非空，最多500字（含标点）。
          </p>
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
