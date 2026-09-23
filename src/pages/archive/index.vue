<script setup lang="ts">
import { parseStrictJson } from '@/mnemosyne/json';
import { computed, onMounted, ref } from 'vue';
import { dailyState, syncDaily, chooseNewStory, confirmBinding, confirmFork, invalidateDaily } from '@/mnemosyne/bridge';
import { activeLibrary } from '@/mnemosyne/db';
import { statuses, keepSummary } from '@/mnemosyne/canonical';
import { exportLibrary, restoreLibrary } from '@/mnemosyne/migration';
import { regenerateFloor, regenerateHigherSummary } from '@/memory/engine';
import { copyLegacyKnowledge } from '@/memory/vector/knowledge';
import { currentVectorDb } from '@/memory/vector/scope';
import { ui } from '@/state/ui';
import type { CapturedView } from '@/mnemosyne/model';
const prefix = ref(0);
const sourcePage = ref(0);
const view = ref<CapturedView | null>(null), status = ref(new Map<string, string>()), error = ref(''), busy = ref(false), page = ref(0), search = ref(''), branch = ref('');
const rows = computed(() => view.value?.memories.filter(m => m.content.includes(search.value)) ?? []);
const shown = computed(() => rows.value.slice(page.value * 20, page.value * 20 + 20));
async function run(fn: () => Promise<unknown>) { busy.value = true; error.value = ''; try {
    await fn();
}
catch (e) {
    error.value = String((e as Error).message);
}
finally {
    busy.value = false;
} }
async function refresh() { view.value = await syncDaily(); status.value = await statuses(await activeLibrary(), view.value); }
async function keep(id: string) { await keepSummary(await activeLibrary(), view.value!, id); await refresh(); }
async function regenerate(anchor: string | null) { const index = view.value!.refs.findIndex(r => r.message === anchor); if (index >= 0) {
    await regenerateFloor(index);
    await refresh();
} }
async function download() { const pack = await exportLibrary(await activeLibrary()); const url = URL.createObjectURL(new Blob([JSON.stringify(pack)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'mnemosyne-daily-v1.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function restore(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file)
        return;
    if (!confirm('恢复会写入新的空库，校验成功后切换活动库。原活动库仍保留。继续？'))
        return;
    await restoreLibrary(parseStrictJson(await file.text()));
    invalidateDaily();
    await refresh();
}
onMounted(() => run(refresh));
</script>
<template>
 <section class="mn-page">
  <h2>Mnemosyne 档案 / 迁移</h2>
  <p class="mn-warning">试用时请停用原柏宝书。两个扩展同时启用可能重复摘要、状态更新和注入。</p>
  <p role="status">{{dailyState.status}} · 正文 {{dailyState.archived}} · 摘要 {{dailyState.summaries}} · 待审核 {{dailyState.review}}</p>
  <p v-if="dailyState.error||error" class="mn-warning" role="alert">{{error||dailyState.error}}</p>
  <div class="mn-actions"><button :disabled="busy" @click="run(refresh)">刷新 / 重试归档</button><button @click="ui.activePage='events'">事件</button><button @click="ui.activePage='tables'">自定义表</button></div>
  <div v-if="dailyState.conflict" class="mn-card">
   <p>检测到复制/继承的宿主绑定。请明确身份意图；不按相同文本自动合并。</p>
   <button @click="run(async()=>{await chooseNewStory();await refresh()})">作为独立新故事</button>
   <label>续接已有分支 ID<input v-model="branch" /></label>
   <button @click="run(async()=>{await confirmBinding(branch);await refresh()})">确认这是原分支换聊天继续</button>
   <label>分叉继承前缀条数（从第0楼起，含User/Assistant）<input v-model.number="prefix" type="number" min="0" /></label>
   <button @click="run(async()=>{await confirmFork(branch,prefix);await refresh()})">从上述父分支固定前缀创建分叉</button>
   <p>分叉先验证前缀消息身份与原文完全匹配；父分支不改变。旧摘要以新分支的来源声明重新登记。</p>
  </div>
  <details class="mn-card"><summary>数据包边界与恢复</summary>
   <p>核心包包含正式正文/摘要版本、事件及回执、自定义表、宿主映射和非秘密设置。保留历史 ID。</p>
   <p>不含宿主聊天文件、聊天 delta、知识库文件/向量及 API 密钥。物品/地点/生活小档案请另备份宿主聊天；知识库在原知识库页另行导入。</p>
   <p>向量是可重建数据；恢复后按原 Embedding 设置重建，可能产生 API 费用。</p>
   <button :disabled="busy" @click="run(async()=>{const db=currentVectorDb();if(!db)throw new Error('请打开角色聊天');const n=await copyLegacyKnowledge(db);error=`已复制 ${n} 个知识库文件及向量；原库未改动`})">从旧柏宝书复制本角色知识库（不调用模型）</button>
   <button :disabled="busy" @click="run(download)">导出核心包</button>
   <label>恢复到新空库<input type="file" accept=".json" :disabled="busy" @change="e=>run(()=>restore(e))" /></label>
  </details>
  <details class="mn-card"><summary>正文当前视图（{{view?.refs.length??0}} 条；保留历史版本）</summary>
   <article v-for="(source,index) in view?.refs.slice(sourcePage*20,sourcePage*20+20)" :key="source.revision" class="mn-card">
    <p>#{{sourcePage*20+index}} · {{view?.sources.get(source.revision)?.role}}</p><small>{{source.message}} / {{source.revision}}</small>
    <p class="mn-pre">{{view?.sources.get(source.revision)?.content}}</p>
   </article>
   <div class="mn-actions"><button :disabled="sourcePage===0" @click="sourcePage--">上一页正文</button><span>{{sourcePage+1}}</span><button :disabled="(sourcePage+1)*20>=(view?.refs.length??0)" @click="sourcePage++">下一页正文</button></div>
  </details>
  <h3>摘要与来源</h3><input v-model="search" placeholder="搜索摘要" @input="page=0" />
  <article v-for="m in shown" :key="m.id" class="mn-card">
   <p><strong>L{{m.level}}</strong> <span :class="{'mn-warning':status.get(m.id)!=='valid'}">{{status.get(m.id)}}</span> · {{m.storyTime}}</p>
   <p>{{m.content.slice(0,100)}}</p>
   <details><summary>完整摘要 / 来源</summary><p class="mn-pre">{{m.content}}</p><small>{{m.id}}</small><p>{{m.declaration}}</p>
    <p v-for="source in m.inputRefs" :key="source.revision" class="mn-pre">{{view?.sources.get(source.revision)?.content||'历史来源版本（当前视图未选择）'}}</p>
   </details>
   <div v-if="status.get(m.id)==='needs_review'||status.get(m.id)==='needs_rebuild'" class="mn-actions">
    <button v-if="status.get(m.id)==='needs_review' && m.level===0" @click="run(()=>keep(m.id))">保留摘要（仅当前 Head）</button><button v-if="m.level===0" @click="run(()=>regenerate(m.anchor))">重新生成</button><button v-else @click="run(async()=>{await regenerateHigherSummary(m.hostId);await refresh()})">重建本层（下级需先就绪）</button>
   </div>
  </article>
  <div class="mn-actions"><button :disabled="page===0" @click="page--">上一页</button><span>{{page+1}} · {{rows.length}} 条</span><button :disabled="(page+1)*20>=rows.length" @click="page++">下一页</button></div>
 </section>
</template>
