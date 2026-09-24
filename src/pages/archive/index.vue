<script setup lang="ts">
import { shallowRef, ref, watch, computed } from 'vue';
import BbsSelect from '@/components/BbsSelect.vue';
import {
  dailyState,
  dailyBranchChoices,
  syncDaily,
  chooseNewStory,
  confirmFork,
  invalidateDaily,
} from '@/mnemosyne/bridge';
import { activeLibrary } from '@/mnemosyne/db';
import { statuses, keepSummary } from '@/mnemosyne/canonical';
import { exportLibrary, restoreLibrary } from '@/mnemosyne/migration';
import { parseStrictJson } from '@/mnemosyne/json';
import { regenerateFloor, regenerateHigherSummary } from '@/memory/engine';
import { copyLegacyKnowledge } from '@/memory/vector/knowledge';
import { currentVectorDb } from '@/memory/vector/scope';
import type { CapturedView } from '@/mnemosyne/model';
const prefix = ref(0),
  branch = ref(''),
  error = ref(''),
  notice = ref(''),
  busy = ref(false);
const choices = shallowRef<Awaited<ReturnType<typeof dailyBranchChoices>>>([]);
const loadingChoices = ref(false);
const selected = computed(() => choices.value.find(c => c.value === branch.value));
const choiceOptions = computed(() => [{ value: '', label: '请选择来源聊天' }, ...choices.value]);
let choiceRun = 0;
watch(() => [dailyState.conflict, dailyState.scope, dailyState.generation], async (_, __, cleanup) => {
  const runId = ++choiceRun;
  let active = true;
  cleanup(() => { active = false; });
  choices.value = [];
  branch.value = '';
  loadingChoices.value = dailyState.conflict;
  if (!dailyState.conflict) return;
  try {
    const result = await dailyBranchChoices();
    if (!active || runId !== choiceRun) return;
    choices.value = result;
    branch.value = result.find(c => c.inherited)?.value ?? '';
  } catch (e) {
    if (active && runId === choiceRun) error.value = String((e as Error).message);
  } finally {
    if (active && runId === choiceRun) loadingChoices.value = false;
  }
}, { immediate: true });
watch(branch, () => { prefix.value = selected.value?.suggested ?? 0; });
const reviewView = shallowRef<CapturedView | null>(null),
  reviewStates = shallowRef(new Map<string, string>());
const reviewPage = ref(0);
async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = String((e as Error).message);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  await syncDaily();
  notice.value = '当前聊天归档已完成。查看摘要请使用原生「摘要」页。';
}
async function loadReviews() {
  const view = await syncDaily(),
    states = await statuses(await activeLibrary(), view);
  reviewView.value = {
    ...view,
    memories: view.memories.filter((m) => ['needs_review', 'needs_rebuild'].includes(states.get(m.id)!)),
  };
  reviewStates.value = states;
  reviewPage.value = 0;
}
async function review(id: string, action: 'keep' | 'rebuild') {
  const view = reviewView.value!,
    memory = view.memories.find((m) => m.id === id)!;
  if (action === 'keep') await keepSummary(await activeLibrary(), view, id);
  else if (memory.level) await regenerateHigherSummary(memory.hostId);
  else {
    const floor = view.refs.findIndex((r) => r.message === memory.anchor);
    if (floor >= 0) await regenerateFloor(floor);
  }
  await loadReviews();
}
async function download() {
  const pack = await exportLibrary(await activeLibrary());
  const url = URL.createObjectURL(new Blob([JSON.stringify(pack)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mnemosyne-daily-v3.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice.value = '核心包已生成，请确认浏览器已保存下载文件。';
}
async function restore(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file || !confirm('恢复会写入新的空库，校验成功后切换；原库保留。继续？')) return;
  await restoreLibrary(parseStrictJson(await file.text()));
  invalidateDaily();
  await refresh();
  notice.value = '已验证并切换到恢复的新库，原库仍保留。';
}
async function copyKnowledge() {
  const db = currentVectorDb();
  if (!db) throw new Error('请打开角色聊天');
  const n = await copyLegacyKnowledge(db);
  notice.value = `已复制 ${n} 个知识库文件及可复用向量，旧库未改动。请到知识库页检查。`;
}
</script>
<template>
  <section class="mn-page">
    <h2>Mnemosyne 档案 / 迁移</h2>
    <p class="mn-muted">查看归档状态，备份或恢复本机资料。日常阅读和编辑摘要，请用原生摘要页。</p>
    <div class="mn-card mn-status" role="status">
      <strong>{{ dailyState.status }}</strong>
      <p>正文 {{ dailyState.archived }} · 摘要 {{ dailyState.summaries }} · 待审核 {{ dailyState.review }}</p>
      <small
        >“已归档”且无 pending / 错误，表示当前聊天的正文与摘要已写入 Mnemosyne
        独立数据库。首次归档在后台进行，本页不会为显示列表再读一遍正文。</small
      >
    </div>
    <p v-if="dailyState.error || error" class="mn-warning" role="alert">{{ error || dailyState.error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="mn-actions">
      <button :disabled="busy" @click="run(refresh)">{{ busy ? '处理中…' : '刷新 / 重试归档' }}</button
      >
    </div>
    <p class="mn-muted">
      刷新 / 重试归档：检查当前聊天变化，补交失败的归档；不调用模型。平时显示“已归档”即可，无需反复点击。
    </p>
    <details class="mn-card">
      <summary>第一次使用：需要迁移什么？</summary>
      <ol>
        <li>停用原柏宝书，仅启用这个扩展，避免重复摘要和注入。</li>
        <li>打开原聊天，等状态变成“已归档”。正文、已有摘要会自动进入新库；旧聊天和旧库保留。</li>
        <li>
          只有曾在旧柏宝书导入知识库，才需要下方的“复制本角色知识库”。它不迁移聊天，不是归档的必要步骤。
        </li>
        <li>想换设备或备份时导出核心包，并另外备份宿主聊天和知识库。</li>
      </ol>
    </details>
    <div v-if="dailyState.conflict" class="mn-card">
      <p>这个聊天复制了另一聊天的归档信息。如果你刚在原会话点击了“创建分支”，请选择来源聊天，再点击“继承档案”。</p>
      <button
        :disabled="busy"
        @click="
          run(async () => {
            await chooseNewStory();
            await refresh();
          })
        "
      >
        作为独立新故事
      </button>
      <p>来源聊天（当前角色 / 群组已归档的聊天）</p>
      <fieldset :disabled="busy || loadingChoices" class="mn-branch-select">
        <BbsSelect v-model="branch" :options="choiceOptions" aria-label="来源聊天" />
      </fieldset>
      <p v-if="loadingChoices" class="mn-muted">正在读取聊天名称…</p>
      <p v-else-if="!choices.length" class="mn-muted">没有可选来源。请先回到原聊天完成归档，再回来选择；无需查找内部 ID。</p>
      <label
        >分叉点：继承开头多少条消息<input v-model.number="prefix" type="number" min="0" step="1" :max="selected?.suggested" :disabled="busy || !selected"
      /></label>
      <button
        :disabled="busy || loadingChoices || !selected || !Number.isInteger(prefix) || prefix < 0 || prefix > selected.suggested"
        @click="
          run(async () => {
            await confirmFork(branch, prefix);
            await refresh();
          })
        "
      >
        继承档案
      </button>
      <p class="mn-muted">
        “分叉”会继承开头指定条数的消息，之后两条路线独立发展，原聊天不变。你的消息、AI 回复和开场白各算一条，不是按对话轮数计算。
      </p>
      <p class="mn-muted">
        数量默认填两边聊天较短的长度，仅是建议值；若分叉后已聊了新内容，请改为分叉时保留的消息数。
        确认时仍会逐条核对消息身份和正文，不匹配就停止，不会靠同样的文字猜测来源。
      </p>
      <p class="mn-muted">
        “继承档案”会建立独立分支。
        “独立新故事”则不继承原分支身份。分叉不会复制原分支的事件链和自定义表。
      </p>
    </div>
    <details class="mn-card">
      <summary>数据包边界与恢复</summary>
      <p>核心包：正文/摘要及历史版本、事件与回执、自定义表、宿主映射、非秘密设置。</p>
      <p>不含：宿主聊天文件、人物/物品/地点等聊天内状态、知识库文件/向量、API 密钥。它不是整套柏宝书备份。</p>
      <div class="mn-action-help">
        <button :disabled="busy" @click="run(copyKnowledge)">从旧柏宝书复制本角色知识库</button
        ><small>可选。复制当前角色的旧知识库及可复用向量，不调用模型、不删除旧库；无旧知识库可跳过。</small>
      </div>
      <div class="mn-action-help">
        <button :disabled="busy" @click="run(download)">导出核心包</button
        ><small>导出当前活动库的全部故事和分支；等待正在进行的归档完成后再导出，才包含最新聊天。</small>
      </div>
      <label
        >恢复到新空库<input
          type="file"
          accept=".json"
          :disabled="busy"
          @change="(e) => run(() => restore(e))"
      /></label>
      <small
        >选择此前导出的核心包。先验证再切换活动库，失败不替换原库；不合并两个设备的修改。向量需按原设置重建，可能产生
        API 费用。</small
      >
    </details>
    <details v-if="dailyState.review || reviewView" class="mn-card">
      <summary>待审核摘要 · {{ dailyState.review }}</summary>
      <p>正文编辑、删除或翻页后，相关旧摘要可能待审核。本区只在点击后加载待处理项，不显示全量摘要和正文。</p>
      <button :disabled="busy" @click="run(loadReviews)">加载待审核项</button>
      <article
        v-for="m in reviewView?.memories.slice(reviewPage * 10, reviewPage * 10 + 10)"
        :key="m.id"
        class="mn-card"
      >
        <p>L{{ m.level }} · {{ reviewStates.get(m.id) === 'needs_rebuild' ? '需要重建' : '需要审核' }}</p>
        <p>{{ m.content.slice(0, 180) }}</p>
        <div class="mn-actions">
          <button
            v-if="m.level === 0 && reviewStates.get(m.id) === 'needs_review'"
            :disabled="busy"
            @click="run(() => review(m.id, 'keep'))"
          >
            保留摘要（仅当前版本）</button
          ><button :disabled="busy" @click="run(() => review(m.id, 'rebuild'))">
            {{ m.level ? '重建本层' : '重新生成' }}（调用模型）
          </button>
        </div>
      </article>
      <div v-if="reviewView" class="mn-actions">
        <button :disabled="reviewPage === 0" @click="reviewPage--">上一页</button
        ><span>{{ reviewPage + 1 }}</span
        ><button :disabled="(reviewPage + 1) * 10 >= reviewView.memories.length" @click="reviewPage++">
          下一页
        </button>
      </div>
    </details>
  </section>
</template>

<style scoped>
.mn-branch-select { border: 0; padding: 0; margin: 0; min-width: 0; }
</style>
