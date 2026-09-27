<script setup lang="ts">
import ModalMask from './ModalMask.vue';
import { summaryEditPrompt as prompt, resolveSummaryEdit, deferSummaryEdit } from '@/mnemosyne/summary-edit-prompt';
import { engineState } from '@/memory/engine';
</script>
<template>
  <ModalMask :open="prompt.open" top-layer @close="!prompt.busy && deferSummaryEdit()">
    <section class="mn-dialog mn-edit-prompt" role="dialog" aria-modal="true" aria-label="编辑后处理摘要" @keydown.esc="!prompt.busy && deferSummaryEdit()">
      <header><h3>编辑后处理摘要</h3></header>
      <div class="mn-dialog-body">
        <p v-if="prompt.count">当前有 {{ prompt.count }} 条受影响摘要待确认。要保留现有摘要，还是根据编辑后的内容更新？</p>
        <p>更新会调用摘要 API，按依赖顺序逐条保存。过后处理会保留待审核状态，可稍后在扩展内继续。</p>
        <p v-if="prompt.progress" role="status">{{ prompt.progress }}</p>
        <p v-if="prompt.error" role="alert" class="mn-warning">{{ prompt.error }}</p>
      </div>
      <footer>
        <button :disabled="prompt.busy || engineState.running || !prompt.count" @click="resolveSummaryEdit('keep')">保留摘要</button>
        <button class="mn-primary" :disabled="prompt.busy || engineState.running || !prompt.count" @click="resolveSummaryEdit('update')">更新摘要</button>
        <button :disabled="prompt.busy" @click="resolveSummaryEdit('later')">过后处理</button>
      </footer>
    </section>
  </ModalMask>
</template>
<style scoped>
.mn-edit-prompt { color: var(--bbs-ink); }
.mn-edit-prompt footer { display: flex; flex-wrap: wrap; gap: 8px; }
.mn-edit-prompt button { min-height: 40px; padding: 8px 12px; font: inherit; color: inherit; border: 1px solid var(--bbs-line); border-radius: 8px; background: var(--bbs-surface-2); cursor: pointer; }
.mn-edit-prompt button:disabled { opacity: .5; cursor: default; }
</style>
