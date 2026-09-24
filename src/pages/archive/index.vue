<script setup lang="ts">
import { shallowRef, ref, watch, computed, onBeforeUnmount } from 'vue';
import BbsSelect from '@/components/BbsSelect.vue';
import {
  dailyState,
  dailyBranchChoices,
  syncDaily,
  chooseNewStory,
  confirmFork,
  invalidateDaily,
  dailyBranch,
  dailyCurrent,
  hostScope,
  hostVersion,
  hiddenRoleRepairRefs,
  previewArchiveReconnect,
  reconnectArchive,
} from '@/mnemosyne/bridge';
import { activeLibrary } from '@/mnemosyne/db';
import { capture, statuses, keepSummary } from '@/mnemosyne/canonical';
import { reviewDifference, type ReviewDifference } from '@/mnemosyne/review-diagnostics';
import { previewRoleRepairs, confirmRoleRepairs, type RoleRepairCandidate } from '@/mnemosyne/source-role-repair';
import { exportLibrary, restoreLibrary } from '@/mnemosyne/migration';
import { parseStrictJson } from '@/mnemosyne/json';
import { regenerateFloor, regenerateHigherSummary } from '@/memory/engine';
import { copyLegacyKnowledge } from '@/memory/vector/knowledge';
import { currentVectorDb } from '@/memory/vector/scope';
import { check, type CapturedView } from '@/mnemosyne/model';
const prefix = ref(0),
  branch = ref(''),
  error = ref(''),
  notice = ref(''),
  busy = ref(false);
const choices = shallowRef<Awaited<ReturnType<typeof dailyBranchChoices>>>([]);
const loadingChoices = ref(false);
const reconnectChoices = shallowRef<Awaited<ReturnType<typeof dailyBranchChoices>>>([]);
const reconnectChoice = ref('');
const reconnectPreview = shallowRef<Awaited<ReturnType<typeof previewArchiveReconnect>> | null>(null);
const reconnectOptions = computed(() => [{ value: '', label: '请选择改名前的原档案' }, ...reconnectChoices.value]);
watch(reconnectChoice, () => { reconnectPreview.value = null; });
const selected = computed(() => choices.value.find(c => c.value === branch.value));
const choiceOptions = computed(() => [{ value: '', label: '请选择来源聊天' }, ...choices.value]);
const currentChatName = computed(() => {
  try { return JSON.parse(dailyState.scope)[1] || '未打开聊天'; } catch { return '未打开聊天'; }
});
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
const pendingMemories = computed(() => reviewView.value?.memories.filter(m => ['needs_review', 'needs_rebuild'].includes(reviewStates.value.get(m.id)!)) ?? []);
const difference = shallowRef<{ id: string; value: ReviewDifference } | null>(null);
const roleRepair = shallowRef<{ candidates: RoleRepairCandidate[]; eligibility: string } | null>(null);
const roleNames = { user: '用户', assistant: 'AI', system: '系统' };
let reviewRun = 0, disposed = false;
let reviewStamp: { host: string; generation: number; scope: string; library: Awaited<ReturnType<typeof activeLibrary>> } | null = null;
function clearReviews() {
  reviewRun++;
  reviewView.value = null;
  reviewStates.value = new Map();
  reviewStamp = null;
  difference.value = null;
  roleRepair.value = null;
  reviewPage.value = 0;
}
watch(() => dailyState.scope, () => { clearReviews(); reconnectChoices.value = []; reconnectChoice.value = ''; reconnectPreview.value = null; error.value = ''; notice.value = ''; }, { flush: 'sync' });
onBeforeUnmount(() => { disposed = true; clearReviews(); });
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
async function loadReconnectChoices() {
  reconnectPreview.value = null;
  const result = await dailyBranchChoices();
  if (disposed) return;
  reconnectChoices.value = result;
  reconnectChoice.value = result.find(c => c.inherited)?.value ?? '';
}
async function inspectReconnect() {
  const choice = reconnectChoice.value;
  reconnectPreview.value = null;
  const value = await previewArchiveReconnect(choice);
  check(!disposed && choice === reconnectChoice.value, '选择已改变，请重新预览');
  reconnectPreview.value = value;
}
async function applyReconnect() {
  const preview = reconnectPreview.value;
  check(preview, '请先预览原档案');
  if (!confirm('请确认这是同一聊天改名后的原档案，不是要继续独立发展的新分支。接回会恢复使用原分支；当前误建档案完整保留为未连接，不合并、不删除两边记录。继续？')) return;
  await reconnectArchive(preview, () => !disposed && reconnectPreview.value === preview);
  reconnectPreview.value = null;
  reconnectChoices.value = [];
  reconnectChoice.value = '';
  clearReviews();
  notice.value = `已接回原档案。库内原有 ${preview.plan.events} 条事件链；仍有 ${dailyState.review} 条摘要待审核。若事件未显示，请继续检查隐藏来源差异。`;
}
async function loadReviews() {
  clearReviews();
  const ticket = reviewRun;
  const stamp = { host: hostVersion(), generation: dailyState.generation, scope: hostScope(), library: await activeLibrary() };
  check(!dailyState.pending && !dailyState.conflict, '请等当前聊天归档完成后再读取；本按钮不会触发归档');
  const branch = await dailyBranch();
  check(branch, '当前聊天尚未绑定已有档案');
  const view = await capture(stamp.library, branch.id);
  const states = await statuses(stamp.library, view);
  const valid = await dailyCurrent(view, stamp.host, stamp.generation) && stamp.library === await activeLibrary();
  if (disposed || ticket !== reviewRun) return;
  check(valid && stamp.host === hostVersion() && stamp.generation === dailyState.generation, '聊天已改变，请重新加载待审核项');
  reviewView.value = view;
  reviewStates.value = states;
  reviewStamp = stamp;
  reviewPage.value = 0;
}
async function checkedReview() {
  const view = reviewView.value, stamp = reviewStamp;
  check(view && stamp, '请先加载待审核项');
  const valid = await dailyCurrent(view, stamp.host, stamp.generation) && stamp.library === await activeLibrary();
  const guard = () => !disposed && reviewView.value === view && reviewStamp === stamp && stamp.scope === hostScope() && stamp.host === hostVersion() && stamp.generation === dailyState.generation;
  check(valid && guard(), '聊天或档案已改变，请重新加载待审核项');
  return { view, stamp, guard };
}
async function inspectReview(id: string) {
  const { view, stamp, guard } = await checkedReview();
  const value = await reviewDifference(stamp.library, view, id);
  const valid = await dailyCurrent(view, stamp.host, stamp.generation) && stamp.library === await activeLibrary();
  check(valid && guard(), '聊天或档案已改变，请重新加载待审核项');
  difference.value = { id, value };
}
async function previewHiddenRoles() {
  const { view, stamp, guard } = await checkedReview();
  roleRepair.value = null;
  const eligible = hiddenRoleRepairRefs(view), eligibility = JSON.stringify(eligible);
  const candidates = await previewRoleRepairs(stamp.library, view, eligible);
  check(await dailyCurrent(view, stamp.host, stamp.generation) && guard() && eligibility === JSON.stringify(hiddenRoleRepairRefs(view)), '聊天或隐藏状态已改变，请重新预览');
  roleRepair.value = { candidates, eligibility };
}
async function repairHiddenRoles() {
  const { view, stamp, guard } = await checkedReview(), preview = roleRepair.value;
  check(preview?.candidates.length, '请先预览隐藏来源修复');
  const repairGuard = () => guard() && roleRepair.value === preview && preview.eligibility === JSON.stringify(hiddenRoleRepairRefs(view));
  check(repairGuard(), '隐藏状态已改变，请重新预览');
  if (!confirm('请确认列出的楼层原本都是普通 AI 回复，只因隐藏被旧版记为系统。确认后仅在当前分支认可列出的来源版本；正文、摘要和事件记录保留原样。继续？')) return;
  await confirmRoleRepairs(stamp.library, view, preview.candidates, repairGuard);
  await syncDaily();
  await loadReviews();
  notice.value = `已记录隐藏来源修复；当前仍有 ${dailyState.review} 条待审核。请到事件页查看恢复结果。`;
}
async function review(id: string, action: 'keep' | 'rebuild') {
  const { view, stamp, guard } = await checkedReview();
  const memory = view.memories.find((m) => m.id === id)!;
  if (action === 'keep') await keepSummary(stamp.library, view, id, guard);
  else if (memory.level) await regenerateHigherSummary(memory.hostId);
  else {
    const floor = view.refs.findIndex((r) => r.message === memory.anchor);
    if (floor >= 0) await regenerateFloor(floor);
  }
  await syncDaily();
  await loadReviews();
}
async function download() {
  const pack = await exportLibrary(await activeLibrary());
  const url = URL.createObjectURL(new Blob([JSON.stringify(pack)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `mnemosyne-daily-v${pack.version}.json`;
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
  try { await refresh(); }
  catch (e) {
    if (!dailyState.conflict) throw e;
    notice.value = '核心包已验证并恢复到新库，原库仍保留。当前聊天名称或绑定与备份不同，请在“聊天改名 / 接回已有档案”中选择原档案。';
    return;
  }
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
      <details>
        <summary>当前聊天与档案标识（只读）</summary>
        <p>当前聊天：{{ currentChatName }}</p>
        <p style="overflow-wrap: anywhere">分支档案：{{ dailyState.branch || '尚未确认当前聊天的档案' }}</p>
        <small>可切换聊天比较此标识；“已归档”表示当前聊天已保存，不表示它继承了另一聊天。没有旧绑定的聊天会自动建立独立档案。</small>
      </details>
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
      <p>当前聊天名称或绑定已改变。若只是给原聊天改名，请使用下方“聊天改名 / 接回已有档案”；只有真正创建了新路线，才选择“继承档案”。</p>
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
        class="mn-primary"
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
      <summary>聊天改名 / 接回已有档案</summary>
      <p>只改名字或改名后误选过“继承档案”时，从这里接回原分支。原事件链和自定义表仍属于原档案。</p>
      <button :disabled="busy" @click="run(loadReconnectChoices)">查找原档案（只读）</button>
      <template v-if="reconnectChoices.length">
        <BbsSelect v-model="reconnectChoice" :options="reconnectOptions" aria-label="改名前的原档案" />
        <button :disabled="busy || !reconnectChoice" @click="run(inspectReconnect)">预览接回（只读）</button>
      </template>
      <div v-if="reconnectPreview" class="mn-card">
        <p>原档案保存：{{ reconnectPreview.plan.messages }} 条正文 · {{ reconnectPreview.plan.summaries }} 条摘要 · {{ reconnectPreview.plan.events }} 条事件链 · {{ reconnectPreview.plan.tables }} 张表。</p>
        <p>已逐条核对原档案的全部消息身份和正文。接回后仍按原有来源有效性显示，不代表所有待审核项自动通过。</p>
        <p v-if="reconnectPreview.plan.displaced">当前连接将替换为原档案；当前分支及其中 {{ reconnectPreview.plan.displacedEvents }} 条事件完整保留为“未连接”，仍可导出或再次接回。</p>
        <button :disabled="busy" @click="run(applyReconnect)">确认是同一聊天，接回原档案</button>
      </div>
      <p class="mn-muted">不会按相同文字合并消息。若身份缺失、正文不同或聊天变短，预览会停止；先保留核心包和宿主聊天。备份只包含导出时的数据。</p>
    </details>
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
      <p>正文、消息身份或角色分类变化后，相关旧摘要可能待审核；依赖它们的事件也可能暂不显示。这不表示摘要或事件已删除。</p>
      <p class="mn-muted">加载和查看来源差异均只读，不归档、不调用模型、不修改审核结果。若突然出现大量待审核，请先导出核心包，再查看来源差异，不必逐条重新生成。</p>
      <button :disabled="busy || dailyState.pending || dailyState.conflict" @click="run(loadReviews)">加载待审核项（只读）</button>
      <div v-if="reviewView" class="mn-card">
        <button :disabled="busy" @click="run(previewHiddenRoles)">预览隐藏来源修复（只读）</button>
        <template v-if="roleRepair">
          <p v-if="!roleRepair.candidates.length">未发现符合条件的来源版本：需要当前仍隐藏的普通 AI 回复，且旧版系统来源的消息身份、完整正文与回复版本相同。</p>
          <template v-else>
            <p>发现 {{ roleRepair.candidates.length }} 处旧「系统」→ 当前「AI」差异，完整正文均相同。旧版未保存隐藏依据，请核对这些楼层原本是否都是 AI 回复。</p>
            <div style="max-height: 260px; overflow: auto">
              <p v-for="c in roleRepair.candidates" :key="c.before.revision">#{{ c.floor }} · 系统 → AI · {{ c.excerpt }}</p>
            </div>
            <p class="mn-muted">确认仅适用于列出的来源版本与当前分支；仍会检查正文、顺序、截止点和摘要依赖，不会调用模型。</p>
            <button :disabled="busy" @click="run(repairHiddenRoles)">确认这些楼层原本是 AI，修复来源</button>
          </template>
        </template>
      </div>
      <article
        v-for="m in pendingMemories.slice(reviewPage * 10, reviewPage * 10 + 10)"
        :key="m.id"
        class="mn-card"
      >
        <p>L{{ m.level }} · {{ reviewStates.get(m.id) === 'needs_rebuild' ? '需要重建' : '需要审核' }}</p>
        <p>{{ m.content.slice(0, 180) }}</p>
        <button :disabled="busy" @click="run(() => inspectReview(m.id))">查看来源差异</button>
        <div v-if="difference?.id === m.id" class="mn-review-difference" role="status">
          <strong>只读检查：{{ difference.value.floor !== undefined && difference.value.floor >= 0 ? `原来源楼层 #${difference.value.floor}` : '来源与依赖' }}</strong>
          <p>{{ difference.value.explanation }}</p>
          <template v-for="side in (['before', 'after'] as const)" :key="side">
            <p v-if="difference.value[side]">{{ side === 'before' ? '原版本' : '当前对照' }} · {{ roleNames[difference.value[side]!.role] }} · {{ difference.value[side]!.length }} 字</p>
            <pre v-if="difference.value[side]">{{ difference.value[side]!.excerpt }}</pre>
          </template>
          <small>片段仅在本机显示；引号和反斜线用于显示换行、空格等差异。这里只展示首处差异，没有自动确认兼容。</small>
        </div>
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
        ><button :disabled="(reviewPage + 1) * 10 >= pendingMemories.length" @click="reviewPage++">
          下一页
        </button>
      </div>
    </details>
  </section>
</template>

<style scoped>
.mn-branch-select { border: 0; padding: 0; margin: 0; min-width: 0; }
.mn-review-difference { margin: 14px 0; padding: 14px; border-left: 3px solid var(--SmartThemeBorderColor, #6b9295); background: #ffffff06; border-radius: 8px; }
.mn-review-difference pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .85em; }
</style>
