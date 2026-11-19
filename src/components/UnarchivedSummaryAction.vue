<script setup lang="ts">
import { ref, shallowRef, onBeforeUnmount, watch } from 'vue';
import ModalMask from './ModalMask.vue';
import { confirmUnarchivedSummary, type UnarchivedSummary } from '@/mnemosyne/bridge';
import { toast } from '@/st/toast';
const props = defineProps<{ item: UnarchivedSummary; disabled?: boolean }>();
const preview = shallowRef<UnarchivedSummary | null>(null);
const busy = ref(false);
watch(() => props.item, () => { preview.value = null; });
onBeforeUnmount(() => { preview.value = null; });
async function confirm() {
  const item = preview.value;
  if (!item || busy.value || props.disabled) return;
  busy.value = true;
  try {
    await confirmUnarchivedSummary(item, () => !props.disabled && item === preview.value && item === props.item);
    preview.value = null;
    toast(`#${item.floor} 摘要已重新归档`, 'success');
  } catch (error) { toast((error as Error).message, 'warning'); }
  finally { busy.value = false; }
}
</script>
<template>
  <button class="bbs-btn" type="button" :disabled="busy || disabled" @click.stop="preview = item">核对并归档</button>
  <ModalMask v-if="preview" :open="true" @close="preview = null">
    <section class="bbs-modal" role="dialog" aria-modal="true" aria-label="核对并归档摘要" @click.stop>
      <header class="bbs-modal-head"><strong>核对 #{{ preview.floor }} 楼摘要</strong></header>
      <div class="mn-archive-preview">
        <strong>聊天中保留的摘要</strong><p>{{ preview.text }}</p>
        <details><summary>查看本楼正文</summary><p>{{ preview.body }}</p></details>
        <p>确认后，使用这份摘要文字和当前楼层及此前正文建立人工确认版本。</p>
      </div>
      <footer class="bbs-modal-foot"><button class="bbs-btn" :disabled="busy" @click="preview = null">取消</button><button class="bbs-btn bbs-btn-primary" :disabled="busy || disabled" @click="confirm">已核对，重新归档</button></footer>
    </section>
  </ModalMask>
</template>
<style scoped>
.mn-archive-preview { padding: 12px; max-height: 54vh; overflow: auto; }
.mn-archive-preview p { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
