<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { activeLibrary } from '@/mnemosyne/db';
import { syncDaily } from '@/mnemosyne/bridge';
import { newTable, saveTable, applyRows } from '@/mnemosyne/tables';
import { fillTable, jobState } from '@/mnemosyne/jobs';
import { row, type CapturedView, type TableDef, type TableRow, type Column } from '@/mnemosyne/model';
const view = ref<CapturedView | null>(null), tables = ref<TableDef[]>([]), rows = ref<TableRow[]>([]), tableId = ref(''), error = ref(''), search = ref(''), page = ref(0), sources = ref<string[]>([]);
const table = computed(() => tables.value.find(t => t.id === tableId.value));
const found = computed(() => rows.value.filter(r => !r.deleted && JSON.stringify(r.values).includes(search.value)));
const shown = computed(() => found.value.slice(page.value * 20, page.value * 20 + 20));
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
async function run(fn: () => Promise<unknown>) { error.value = ''; try {
    await fn();
}
catch (e) {
    error.value = String((e as Error).message);
} }
async function refresh() { view.value = await syncDaily(); const lib = await activeLibrary(); tables.value = (await lib.all<TableDef>('custom_table_defs', 'branch', view.value.branch.id)).filter(t => !t.deleted); if (!tableId.value)
    tableId.value = tables.value[0]?.id ?? ''; rows.value = tableId.value ? await lib.all<TableRow>('custom_table_rows', 'owner', tableId.value) : []; }
async function save(def: TableDef) { await saveTable(await activeLibrary(), view.value!, plain(def)); await refresh(); }
async function create() { const name = prompt('新表名称'); if (name)
    await save(newTable(view.value!, name)); }
async function rename() { const def = plain(table.value!); const name = prompt('表名称', def.name); if (!name)
    return; def.name = name; const description = prompt('表说明', def.description); if (description === null)
    return; def.description = description; await save(def); }
async function remove() { if (confirm('删除此表？将隐藏表及其行，历史数据保留在核心包中。'))
    await save({ ...plain(table.value!), deleted: true }); }
async function column(old?: Column) {
    const name = prompt('字段名', old?.name ?? '');
    if (!name)
        return;
    const type = prompt('类型：text / number / boolean', old?.type ?? 'text');
    if (!type)
        return;
    const mode = prompt('AI更新模式：replace / append / manual', old?.mode ?? 'manual');
    if (!mode)
        return;
    const description = prompt('字段说明', old?.description ?? '');
    if (description === null)
        return;
    const def = plain(table.value!);
    const col = { id: old?.id ?? row('col').id, name, type, mode, description } as Column;
    def.columns = old ? def.columns.map(c => c.id === old.id ? col : c) : [...def.columns, col];
    await save(def);
}
async function dropColumn(col: Column) { if (!confirm(`删除字段 ${col.name}？旧单元格保留在归档行中，但不再发送给AI。`))
    return; const def = plain(table.value!); def.columns = def.columns.filter(c => c.id !== col.id); await save(def); }
async function editRow(record?: TableRow) {
    const def = table.value!;
    const values: TableRow['values'] = {};
    for (const c of def.columns) {
        const raw = prompt(`${c.name} (${c.type})`, String(record?.values[c.id] ?? ''));
        if (raw === null)
            return;
        if (c.type === 'number') {
            if (!raw.trim() || !Number.isFinite(Number(raw)))
                throw new Error('数字字段应为有效数字');
            values[c.id] = Number(raw);
        }
        else if (c.type === 'boolean') {
            if (!['true', 'false'].includes(raw))
                throw new Error('布尔字段填写true或false');
            values[c.id] = raw === 'true';
        }
        else
            values[c.id] = raw;
    }
    await applyRows(await activeLibrary(), view.value!, plain(def), [{ row_id: record?.id ?? null, values }], false);
    await refresh();
}
async function deleteRow(record: TableRow) { if (!confirm('删除此行？'))
    return; await applyRows(await activeLibrary(), view.value!, plain(table.value!), [{ row_id: record.id, values: {}, delete: true }], false); await refresh(); }
onMounted(() => run(refresh));
</script>
<template>
 <section class="mn-page"><h2>本地自定义表</h2><p v-if="error" class="mn-warning" role="alert">{{error}}</p>
 <div class="mn-actions"><button @click="run(refresh)">刷新</button><button :disabled="!view" @click="run(create)">新建表</button><select v-model="tableId" @change="run(refresh)"><option v-for="t in tables" :key="t.id" :value="t.id">{{t.name}}</option></select></div>
 <template v-if="table">
 <h3>{{table.name}}</h3><p>{{table.description}}</p>
 <div class="mn-actions"><button @click="run(rename)">改名 / 说明</button><button @click="run(remove)">删除表</button><button @click="run(()=>column())">新增字段</button><button @click="run(()=>editRow())">新增行</button></div>
 <label><input :checked="table.ai" type="checkbox" @change="run(()=>save({...plain(table!),ai:!table!.ai}))" />允许 AI 填写此表（手动执行时发送定义、已有行和选定摘要）</label>
 <div v-for="col in table.columns" :key="col.id" class="mn-actions"><span>{{col.name}} · {{col.type}} · {{col.mode}}</span><button @click="run(()=>column(col))">编辑字段</button><button @click="run(()=>dropColumn(col))">删除字段</button></div>
 <input v-model="search" placeholder="搜索行" @input="page=0" />
 <div class="mn-scroll"><table><thead><tr><th v-for="col in table.columns" :key="col.id">{{col.name}}</th><th>操作</th></tr></thead><tbody><tr v-for="record in shown" :key="record.id"><td v-for="col in table.columns" :key="col.id">{{record.values[col.id]}}</td><td><button @click="run(()=>editRow(record))">编辑</button><button @click="run(()=>deleteRow(record))">删除</button></td></tr></tbody></table></div>
 <div class="mn-actions"><button :disabled="page===0" @click="page--">上一页</button><span>{{page+1}} · {{found.length}} 行</span><button :disabled="(page+1)*20>=found.length" @click="page++">下一页</button></div>
 <details class="mn-card"><summary>手动 AI 填写选定摘要范围</summary><p>manual 字段只允许人工改；append 追加文本；replace 覆盖。无变化也会保存完成回执。</p>
 <label v-for="m in view?.memories" :key="m.id"><input v-model="sources" type="checkbox" :value="m.id" />L{{m.level}} {{m.content.slice(0,70)}}</label>
 <button :disabled="!table.ai||!sources.length||jobState.busy" @click="run(async()=>{await fillTable(plain(table!),sources);await refresh()})">填充选定表（调用模型）</button><p>{{jobState.status}}</p></details>
 </template></section>
</template>
