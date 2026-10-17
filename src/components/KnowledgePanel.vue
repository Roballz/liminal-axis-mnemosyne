<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import ModalMask from './ModalMask.vue';
import { apiSettings } from '@/api/settings';
import { currentVectorDb } from '@/memory/vector/scope';
import { clearRecallInjection } from '@/memory/vector/recall';
import { invalidateRecallCache } from '@/memory/vector/cache';
import { deleteKnowledge, editKnowledge, embeddingIdentity, importKnowledge, knowledgeDebug, knowledgeText, listKnowledge,
  readKnowledgeSource, setKnowledgeEnabled, type KnowledgeFile } from '@/memory/vector/knowledge';

const files = ref<KnowledgeFile[]>([]);
const delimiter = computed({ get: () => apiSettings.vector.knowledge.delimiter ?? '=========',
  set: (value: string) => { apiSettings.vector.knowledge.delimiter = value; } });
const encoding = ref('utf-8');
const preview = ref<{ name: string; database: string; delimiter: string; chunks: string[]; text: string } | null>(null);
const busy = ref(false);
const status = ref('');
const selectedBlock = ref(0);
const editing = ref<{ file: KnowledgeFile; text: string } | null>(null);
const editError = ref('');
const editor = ref<HTMLTextAreaElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
let controller: AbortController | undefined;
let opener: HTMLElement | undefined;
let disposed = false;
let refreshGeneration = 0;
function changed() { invalidateRecallCache(); clearRecallInjection(); }
async function refresh() {
  const generation = ++refreshGeneration;
  const database = currentVectorDb();
  files.value = [];
  if (!database) { status.value = '请先进入单角色聊天'; return; }
  try {
    const result = await listKnowledge(database);
    if (!disposed && generation === refreshGeneration && database === currentVectorDb()) files.value = result;
  } catch (error) { status.value = String(error); }
}
async function choose(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  preview.value = null;
  if (!file) return;
  const database = currentVectorDb();
  if (!database) { status.value = '请先进入单角色聊天'; return; }
  busy.value = true;
  try {
    const marker = delimiter.value;
    const { text, chunks } = await readKnowledgeSource(file, marker, encoding.value);
    if (database !== currentVectorDb()) throw new Error('角色已切换，请重新选择文件');
    preview.value = { name: file.name, database, delimiter: marker, chunks, text };
    selectedBlock.value = 0;
    status.value = `已解析 ${chunks.length} 块，尚未发送或向量化`;
  } catch (error) { status.value = `读取失败：${String(error)}；乱码时可切换编码后重新选文件`; }
  finally { busy.value = false; }
}
async function commit() {
  const prepared = preview.value;
  if (!prepared || busy.value) return;
  if (prepared.database !== currentVectorDb()) { status.value = '角色已切换，请重新选择文件'; preview.value = null; return; }
  busy.value = true;
  controller = new AbortController();
  try {
    await importKnowledge(prepared.database, prepared.name, prepared.delimiter, prepared.text, controller.signal,
      done => { status.value = `已向量化 ${done}/${prepared.chunks.length} 块`; });
    preview.value = null;
    changed();
    status.value = '导入完成，已保存到所选角色的本机知识库';
  } catch (error) { status.value = `未发布此次导入：${String(error)}`; }
  finally { busy.value = false; controller = undefined; await refresh(); }
}
async function update(file: KnowledgeFile, remove = false) {
  if (busy.value) return;
  if (file.database !== currentVectorDb()) { await refresh(); status.value = '角色已切换，请重新操作'; return; }
  if (remove && !window.confirm(`删除知识库文件“${file.name}”及其向量？`)) return;
  busy.value = true;
  try {
    if (remove) await deleteKnowledge(file); else await setKnowledgeEnabled(file, !file.enabled);
    changed();
    status.value = remove ? '文件及向量已删除' : '文件启用状态已更新';
  } catch (error) { status.value = String(error); }
  finally { busy.value = false; await refresh(); }
}
async function openEdit(file: KnowledgeFile, event: Event) {
  if (busy.value) return;
  if (file.database !== currentVectorDb()) { await refresh(); status.value = '角色已切换，请重新操作'; return; }
  editing.value = { file, text: knowledgeText(file) }; editError.value = '';
  opener = event.currentTarget as HTMLElement;
  await nextTick(); editor.value?.focus?.();
}
function closeEdit() {
  if (busy.value) return;
  editing.value = null; editError.value = '';
  opener?.focus?.();
}
function trapFocus(event: KeyboardEvent) {
  const targets = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') ?? [])];
  const index = targets.findIndex(el => event.composedPath().includes(el));
  if (targets.length && (index < 0 || (!event.shiftKey && index === targets.length - 1) || (event.shiftKey && index === 0))) {
    event.preventDefault(); targets[event.shiftKey ? targets.length - 1 : 0]?.focus();
  }
}
async function saveEdit() {
  const draft = editing.value;
  if (!draft || busy.value) return;
  if (draft.file.database !== currentVectorDb()) { editError.value = '角色已切换，请取消后刷新文件'; return; }
  const unchanged = draft.text === knowledgeText(draft.file) && draft.file.embedding === embeddingIdentity();
  busy.value = true; editError.value = ''; status.value = '正在保存正文并重新向量化…'; controller = new AbortController();
  changed(); // Clear an already injected result as soon as an explicit save starts.
  try {
    await editKnowledge(draft.file, draft.text, controller.signal,
      done => { status.value = `正在重新向量化：已完成 ${done} 块`; });
    if (disposed) return;
    editing.value = null;
    status.value = unchanged ? '正文未变化，无需重新向量化' : '正文已保存并完成重新向量化，原有启用状态保持不变';
    opener?.focus?.();
  } catch (error) {
    if (!disposed) { editError.value = `保存或向量化未完成：${String(error)}`; status.value = editError.value; }
  } finally {
    busy.value = false; controller = undefined; changed();
    if (!disposed) {
      await refresh();
      const latest = files.value.find(file => file.id === draft.file.id);
      // A failed embedding leaves the new text saved; retry against that exact revision only.
      if (editing.value === draft && latest?.sourceText === draft.text) draft.file = latest;
    }
  }
}
function download(file: KnowledgeFile) {
  const url = URL.createObjectURL(new Blob([knowledgeText(file)], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = file.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(refresh);
onBeforeUnmount(() => { disposed = true; refreshGeneration++; controller?.abort(); });
</script>

<template>
  <section class="bbs-knowledge">
    <h4>额外知识库（TXT / MD）</h4>
    <p>按当前角色隔离，保存在本机浏览器；同角色各聊天可用，不自动同步到其他设备。切换角色后点击刷新。</p>
    <label><input v-model="apiSettings.vector.knowledge.enabled" type="checkbox" @change="changed" />启用知识库召回（同时需开启向量记忆）</label>
    <div class="kb-fields">
      <label>独立召回块数<input v-model.number="apiSettings.vector.knowledge.count" class="bbs-input" type="number" min="0" max="30" @change="changed" /></label>
      <label>相似度阈值<input v-model.number="apiSettings.vector.knowledge.threshold" class="bbs-input" type="number" min="0" max="1" step="0.01" @change="changed" /></label>
      <label>内容预算（字符）<input v-model.number="apiSettings.vector.knowledge.maxChars" class="bbs-input" type="number" min="0" max="100000" @change="changed" /></label>
    </div>
    <p>与摘要共用一次 query 改写和 query 向量；按向量相似度筛选完整区块，不占摘要/原文条数。超过预算的区块跳过，不截断、不拼接相邻块。结果置于召回摘要下方的【额外信息】。</p>
    <div class="kb-fields">
      <label>独占一行的分隔符<input v-model="delimiter" class="bbs-input" :disabled="busy" /></label>
      <label>文件编码<select v-model="encoding" class="bbs-input" :disabled="busy"><option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select></label>
    </div>
    <p>每文件最多 5 MB / 1000 块，每块最多 24000 字符。先设置分隔符和编码，再选文件；Markdown 按原文保留。</p>
    <input type="file" accept=".txt,.md" :disabled="busy" aria-label="选择知识库文件" @change="choose" />
    <div v-if="preview" class="kb-preview">
      <p>{{ preview.name }} · {{ preview.chunks.length }} 个独立区块</p>
      <label>预览第几块<input v-model.number="selectedBlock" class="bbs-input" type="range" min="0" :max="preview.chunks.length - 1" /></label>
      <pre>{{ preview.chunks[selectedBlock] }}</pre>
      <p>点击确认后，文件各区块将发送至已配置的 Embedding 服务进行向量化。</p>
      <button class="bbs-btn bbs-btn-primary" :disabled="busy" @click="commit">确认导入并向量化</button>
      <button v-if="busy" class="bbs-btn" @click="controller?.abort()">取消导入</button>
    </div>
    <p role="status">{{ status }}</p>
    <button class="bbs-btn" :disabled="busy" @click="refresh">刷新当前角色文件</button>
    <div v-for="file in files" :key="file.id" class="kb-file">
      <strong>{{ file.name }}</strong><span>{{ file.chunks.length }} 块 · {{ file.enabled ? '启用' : '停用' }}</span>
      <span v-if="file.embedding !== embeddingIdentity()">{{ file.indexError ? '向量化失败' : file.embedding ? 'Embedding 配置已改变' : '向量化未完成' }}，本文件暂停召回；请编辑并保存以重新向量化。</span>
      <div><button class="bbs-btn" :disabled="busy" @click="update(file)">{{ file.enabled ? '停用' : '启用' }}</button>
        <button class="bbs-btn" :disabled="busy" @click="openEdit(file, $event)">编辑</button>
        <button class="bbs-btn" @click="download(file)">导出文本</button>
        <button class="bbs-btn" :disabled="busy" @click="update(file, true)">删除</button></div>
    </div>
    <ModalMask :open="!!editing" @close="closeEdit">
      <form v-if="editing" ref="dialog" class="mn-dialog kb-editor" role="dialog" aria-modal="true" aria-label="编辑知识库文档"
        @submit.prevent="saveEdit" @keydown.esc.stop.prevent="closeEdit" @keydown.tab="trapFocus">
        <header><h3>编辑知识库文档</h3><small>{{ editing.file.name }}</small></header>
        <div class="mn-dialog-body">
          <p v-if="editing.file.sourceText === undefined">旧版文件未保存导入原文，以下为区块还原文本；原始空白和换行格式无法恢复。</p>
          <p>沿用此文档导入时的分隔符「{{ editing.file.delimiter }}」重新分块。保存后自动向量化，区块将发送至当前配置的 Embedding 服务；完成前暂停此文档召回。</p>
          <label>文档全文<textarea ref="editor" v-model="editing.text" class="bbs-input kb-edit-text" aria-label="知识库文档全文" :disabled="busy" /></label>
          <p v-if="editError" role="alert">{{ editError }}。若正文已保存但向量化失败，可保留当前内容再次保存重试。</p>
          <p v-if="busy" role="status">{{ status }}</p>
        </div>
        <footer>
          <button class="bbs-btn" type="button" :disabled="busy" @click="closeEdit">取消</button>
          <button class="bbs-btn kb-save" type="submit" :disabled="busy"><span aria-hidden="true">✓</span> {{ busy ? '正在保存…' : '保存' }}</button>
        </footer>
      </form>
    </ModalMask>
    <p>{{ knowledgeDebug.status }}</p>
    <p v-for="hit in knowledgeDebug.hits" :key="`${hit.name}:${hit.block}`">{{ hit.name }} · 第{{ hit.block }}块 · {{ hit.score.toFixed(3) }}</p>
  </section>
</template>

<style scoped>
.bbs-knowledge { display: grid; gap: 10px; margin: 16px 0; }
.bbs-knowledge p { font-size: 12px; color: var(--bbs-ink-muted); margin: 0; }
.kb-fields { display: flex; flex-wrap: wrap; gap: 10px; }
.kb-fields label { flex: 1; min-width: 130px; }
.kb-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; padding: 10px; background: var(--bbs-surface-2); }
.kb-file { display: grid; gap: 6px; border: 1px solid var(--bbs-line); padding: 10px; border-radius: 8px; overflow-wrap: anywhere; }
.kb-editor { width: min(760px, calc(100vw - 28px)); }
.kb-editor .kb-edit-text { display: block; width: 100%; box-sizing: border-box; height: 320px; min-height: 140px; max-height: none; resize: vertical; overflow: auto; white-space: pre-wrap; }
.kb-editor footer .bbs-btn:not(.kb-save) { background: transparent; }
.kb-editor .kb-save { display: inline-flex; align-items: center; gap: 8px; padding: 9px 18px; border: 2px solid #a9cbd3; border-radius: 18px; background: #8ca8b3; color: #17272d; }
.kb-editor .kb-save:hover:not(:disabled) { background: #9ab5bf; border-color: #b8d8df; color: #17272d; }
</style>
