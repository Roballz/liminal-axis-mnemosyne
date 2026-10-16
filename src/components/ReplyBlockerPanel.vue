<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { readReplyBlockers, locateReplyBlocker, replyDiagnosticEpoch } from '@/mnemosyne/bridge';
import { replyBlockerText, type ReplyBlocker, type ReplyBlockerPage } from '@/mnemosyne/reply-finality';
import { closeBook } from '@/state/ui';
import { toast } from '@/st/toast';
const props = defineProps<{ initial: ReplyBlocker; disabled?: boolean }>();
const emit = defineEmits<{ located: [] }>();
const page = shallowRef<ReplyBlockerPage | null>(null), seed = shallowRef<ReplyBlocker | null>(null);
const busy = ref(false), error = ref('');
let ticket = 0;
watch(() => [props.initial, replyDiagnosticEpoch.value], () => {
    ticket++; page.value = null;
    seed.value = props.initial.current() ? props.initial : null;
    error.value = seed.value ? '' : '聊天或正文已变化，请重新检查';
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { ticket++; });
// At most one known blocker plus one bounded page; never accumulate a huge DOM list.
const rows = computed(() => [...(seed.value ? [seed.value] : []),
    ...(page.value?.items ?? []).filter(item => item.floor !== seed.value?.floor)]);
async function inspect(restart = false) {
    if (busy.value || props.disabled) return;
    const run = ++ticket; busy.value = true; error.value = '';
    try {
        const result = await readReplyBlockers(restart ? undefined : page.value?.next);
        if (run === ticket && result.current()) page.value = result;
    } catch (e) { if (run === ticket) { page.value = null; seed.value = null; error.value = (e as Error).message; } }
    finally { busy.value = false; }
}
async function locate(item: ReplyBlocker) {
    if (busy.value || props.disabled) return;
    const run = ++ticket; busy.value = true; error.value = '';
    try {
        const result = await locateReplyBlocker(item);
        if (run !== ticket) return;
        if (result === 'unsupported') error.value = `当前宿主无法自动定位，请在聊天中查找楼层 #${item.floor}（编号从 0 开始），核对后用原生勾号保存。`;
        else {
            toast(`已请求定位楼层 #${item.floor}；若未跳转，请按该楼号查找。核对正文后用原生勾号保存。`, 'info');
            emit('located'); closeBook();
        }
    } catch (e) { if (run === ticket) error.value = (e as Error).message; }
    finally { busy.value = false; }
}
</script>
<template>
  <section class="mn-reply-blockers" aria-label="需先确认的正文">
    <strong>需先确认的正文</strong>
    <p>旧楼层也可能阻挡当前归档。请定位原文核对；需要时编辑，再用原生勾号保存。这里只检查和定位，不确认正文或摘要。</p>
    <ul>
      <li v-for="item in rows" :key="`${item.floor}:${item.swipe}`">
        <span>楼层 #{{ item.floor }} · swipe {{ item.swipe + 1 }}：{{ replyBlockerText[item.reason] }}</span>
        <button :disabled="busy || disabled" @click="locate(item)">定位原文</button>
      </li>
    </ul>
    <p v-if="page" role="status">已检查 {{ page.examined }} / {{ page.total }} 楼；{{ page.next ? '仅部分结果，尚未检查完' : '本轮检查结束' }}。本页显示 {{ page.items.length }} 处；上方保留首次发现项。</p>
    <p v-else>此处先显示归档发现的一处；可能还有其他未确认楼层。楼号从 0 开始。</p>
    <p>各页为检查时的快照；归档仍会复核全部正文。</p>
    <div class="mn-reply-actions">
      <button v-if="!page || page.next" :disabled="busy || disabled" @click="inspect()">{{ busy ? '检查中…' : page ? '继续检查' : '检查其他楼层' }}</button>
      <button :disabled="busy || disabled" @click="inspect(true)">重新检查</button>
    </div>
    <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.mn-reply-blockers { margin: 12px 0; padding: 12px; border: 1px solid var(--bbs-line); border-radius: 8px; font-size: 13px; }
.mn-reply-blockers p { line-height: 1.5; }
.mn-reply-blockers ul { padding-left: 20px; }
.mn-reply-blockers li { margin: 8px 0; overflow-wrap: anywhere; }
.mn-reply-blockers button { margin: 4px; min-height: 36px; color: inherit; background: var(--bbs-surface-2); border: 1px solid var(--bbs-line); border-radius: 6px; cursor: pointer; }
.mn-reply-actions { display: flex; flex-wrap: wrap; }
</style>
