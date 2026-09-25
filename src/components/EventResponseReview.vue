<script setup lang="ts">
import JsonResponseReview from './JsonResponseReview.vue';
import { eventResponseError } from '@/mnemosyne/event-response';
import type { EventReview } from '@/mnemosyne/manual-events';
import { EVENT_PROGRESS_MAX_CHARS, EVENT_APPEND_MAX_CHARS, EVENT_APPEND_PROMPT_MAX_CHARS } from '@/memory/limits';
defineProps<{ review: EventReview; busy: boolean; saveError: string }>();
const emit = defineEmits<{ cancel: []; confirm: [text: string] }>();
</script>
<template>
  <JsonResponseReview :review="review" :busy="busy" :save-error="saveError" label="审阅事件返回" editor-label="待保存事件 JSON" :validate="eventResponseError"
    description="检查或修改下方 JSON，确认后才保存事件及本次关联。修改和确认不会再次调用 API，取消不保存。" @cancel="emit('cancel')" @confirm="emit('confirm', $event)">
    <template #format>
          <p>
            下列字段均需保留；键名、文本用英文双引号，字段间用英文逗号。文本中的换行写成
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
                progress: `本次新增进展，不超过${EVENT_APPEND_PROMPT_MAX_CHARS}字，没有则填空字符串`,
                latestProgress: { memory: "实际进展来源摘要ID", text: `${EVENT_PROGRESS_MAX_CHARS}字内的最新进展小结` },
              },
              null,
              2,
            )
          }}</pre>
          <p>
            status：open 进行中 / resolved 已结束 / dormant
            暂搁。overview：非空，最多500字（含标点）。
            progress：提示词要求不超过{{ EVENT_APPEND_PROMPT_MAX_CHARS }}字，保存上限{{ EVENT_APPEND_MAX_CHARS }}字；无新增进展时填空字符串。
            latestProgress：最近一次真实进展的来源摘要ID与小结，小结最多{{ EVENT_PROGRESS_MAX_CHARS }}字；时间由程序取来源摘要，无需写入小结。没有明确进展时填 null。
          </p>
    </template>
  </JsonResponseReview>
</template>
