<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import TableBackfillAction from '@/components/TableBackfillAction.vue';
import ModalMask from '@/components/ModalMask.vue';
import BbsSelect from '@/components/BbsSelect.vue';
import TableTextField from '@/components/TableTextField.vue';
import { activeLibrary } from '@/mnemosyne/db';
import { dailyBranch, dailyState, hostScope, refreshDailyTables } from '@/mnemosyne/bridge';
import { newTable, saveTable, applyRows, cellLocked } from '@/mnemosyne/tables';
import { check, row, type Branch, type TableDef, type TableRow, type Column } from '@/mnemosyne/model';
const tables = shallowRef<TableDef[]>([]),
  rows = shallowRef<TableRow[]>([]),
  branch = shallowRef<Branch | null>(null);
const tableId = ref(''),
  screen = ref<'list' | 'rows' | 'design'>('list'),
  busy = ref(false),
  loading = ref(false),
  error = ref('');
const search = ref(''),
  page = ref(0),
  showHidden = ref(false),
  selectMode = ref(false),
  selected = ref<string[]>([]);
const menu = shallowRef<TableDef | null>(null),
  definitionDialog = ref(false),
  editingDef = ref<TableDef | null>(null);
const fieldDialog = ref(false),
  editingColumn = ref<Column | null>(null),
  originalColumn = shallowRef<Column | null>(null);
const rowDialog = ref(false),
  editingRow = shallowRef<TableRow | null>(null),
  draft = ref<Record<string, string>>({});
const typeOptions = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '是否' },
];
const modeOptions = [
  { value: 'replace', label: '覆写' },
  { value: 'append', label: '追加' },
  { value: 'lock', label: '锁定' },
  { value: 'manual', label: '仅手动（兼容旧字段）' },
];
const booleanOptions = [
  { value: '', label: '未填写' },
  { value: 'true', label: '是' },
  { value: 'false', label: '否' },
];
const table = computed(() => tables.value.find((t) => t.id === tableId.value));
const filtered = computed(() =>
  rows.value.filter(
    (r) => !r.deleted && (showHidden.value || !r.hidden) && JSON.stringify(r.values).includes(search.value),
  ),
);
const shown = computed(() => filtered.value.slice(page.value * 20, page.value * 20 + 20));
const selectionItems = computed(() =>
  screen.value === 'design' ? (table.value?.columns ?? []) : shown.value,
);
const allSelected = computed(
  () => !!selectionItems.value.length && selectionItems.value.every((r) => selected.value.includes(r.id)),
);
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const typeName = (type: string) => typeOptions.find((o) => o.value === type)?.label ?? type;
const modeName = (mode: string) => modeOptions.find((o) => o.value === mode)?.label ?? mode;
const display = (value: unknown) =>
  value === undefined || value === ''
    ? '未填写'
    : typeof value === 'boolean'
      ? value
        ? '是'
        : '否'
      : String(value);
let request = 0;
async function refresh() {
  const ticket = ++request,
    scope = hostScope();
  loading.value = true;
  try {
    const current = await dailyBranch();
    const lib = await activeLibrary();
    const defs = current
      ? (await lib.all<TableDef>('custom_table_defs', 'branch', current.id)).filter((t) => !t.deleted)
      : [];
    const records =
      current && tableId.value && defs.some((t) => t.id === tableId.value)
        ? await lib.all<TableRow>('custom_table_rows', 'owner', tableId.value)
        : [];
    if (ticket !== request || scope !== hostScope()) return;
    branch.value = current;
    tables.value = defs;
    rows.value = records;
    if (tableId.value && !defs.some((t) => t.id === tableId.value)) back();
  } finally {
    if (ticket === request) loading.value = false;
  }
}
async function run(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = String((e as Error).message);
  } finally {
    busy.value = false;
  }
}
async function scopeForWrite() {
  const scope = hostScope(),
    current = await dailyBranch();
  check(scope === hostScope() && current && current.id === branch.value?.id, '聊天已切换，请重新打开表格');
  return { branch: current };
}
async function save(def: TableDef) {
  const view = await scopeForWrite();
  await saveTable(await activeLibrary(), view, plain(def));
  await refreshDailyTables();
  await refresh();
}
function resetSelection() {
  selected.value = [];
  selectMode.value = false;
}
function back() {
  screen.value = 'list';
  tableId.value = '';
  rows.value = [];
  resetSelection();
  search.value = '';
  page.value = 0;
}
async function openTable(def: TableDef, design = false) {
  tableId.value = def.id;
  screen.value = design ? 'design' : 'rows';
  menu.value = null;
  resetSelection();
  search.value = '';
  page.value = 0;
  await refresh();
}
function newDefinition(def?: TableDef) {
  check(branch.value, '请等待当前聊天首次归档完成');
  editingDef.value = def ? plain(def) : newTable({ branch: branch.value }, '');
  definitionDialog.value = true;
  menu.value = null;
}
async function saveDefinition() {
  await save(editingDef.value!);
  definitionDialog.value = false;
}
async function deleteTable(def: TableDef) {
  menu.value = null;
  if (!confirm(`删除「${def.name}」？表与行会隐藏，核心包仍保留历史数据。`)) return;
  await save({ ...plain(def), deleted: true });
}
function editColumn(column?: Column) {
  originalColumn.value = column ?? null;
  editingColumn.value = column
    ? plain(column)
    : { id: row('col').id, name: '', type: 'text', mode: 'replace', description: '', prompt: '' };
  fieldDialog.value = true;
}
async function saveColumn() {
  const def = plain(table.value!),
    column = plain(editingColumn.value!);
  def.columns = originalColumn.value
    ? def.columns.map((c) => (c.id === column.id ? column : c))
    : [...def.columns, column];
  await save(def);
  fieldDialog.value = false;
}
async function deleteColumns() {
  if (
    !selected.value.length ||
    !confirm(`删除所选 ${selected.value.length} 个字段？旧值仍归档，但不再发送。`)
  )
    return;
  const def = plain(table.value!);
  def.columns = def.columns.filter((c) => !selected.value.includes(c.id));
  await save(def);
  resetSelection();
}
function toggle(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id];
}
function selectAll() {
  selectMode.value = true;
  selected.value = allSelected.value ? [] : selectionItems.value.map((r) => r.id);
}
function editRecord(record?: TableRow) {
  editingRow.value = record ?? null;
  draft.value = Object.fromEntries(
    table.value!.columns.map((c) => [
      c.id,
      record?.values[c.id] === undefined ? '' : String(record.values[c.id]),
    ]),
  );
  rowDialog.value = true;
}
async function saveRecord() {
  const def = table.value!,
    values: TableRow['values'] = {};
  for (const c of def.columns) {
    const value = draft.value[c.id] ?? '';
    if (value === '' && !(c.id in (editingRow.value?.values ?? {}))) continue;
    if (c.type === 'number') {
      check(value.trim() !== '' && Number.isFinite(Number(value)), `${c.name} 应填写有效数字`);
      values[c.id] = Number(value);
    } else if (c.type === 'boolean') {
      check(['true', 'false'].includes(value), `${c.name} 请选择是或否`);
      values[c.id] = value === 'true';
    } else values[c.id] = value;
  }
  await applyRows(
    await activeLibrary(),
    await scopeForWrite(),
    plain(def),
    [{ row_id: editingRow.value?.id ?? null, values, expectedVersion: editingRow.value?.version }],
    false,
  );
  rowDialog.value = false;
  await refreshDailyTables();
  await refresh();
}
async function hideRows(hidden: boolean) {
  if (!selected.value.length) return;
  await applyRows(
    await activeLibrary(),
    await scopeForWrite(),
    plain(table.value!),
    selected.value.map((id) => ({ row_id: id, values: {}, hidden })),
    false,
  );
  resetSelection();
  await refreshDailyTables();
  await refresh();
}
async function deleteRecord() {
  if (!editingRow.value || !confirm('删除此行？历史数据保留在核心包中。')) return;
  await applyRows(
    await activeLibrary(),
    await scopeForWrite(),
    plain(table.value!),
    [{ row_id: editingRow.value.id, values: {}, delete: true, expectedVersion: editingRow.value.version }],
    false,
  );
  rowDialog.value = false;
  await refreshDailyTables();
  await refresh();
}
let timer: ReturnType<typeof setTimeout> | undefined,
  held = false,
  startX = 0,
  startY = 0;
function press(event: PointerEvent, fn: () => void) {
  if (event.button !== 0) return;
  cancelPress();
  held = false;
  startX = event.clientX;
  startY = event.clientY;
  timer = setTimeout(() => {
    held = true;
    fn();
  }, 500);
}
function cancelPress() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
function move(event: PointerEvent) {
  if (Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY) > 12) cancelPress();
}
function activate(fn: () => void) {
  cancelPress();
  if (held) {
    held = false;
    return;
  }
  fn();
}
function selectByPress(id: string) {
  selectMode.value = true;
  if (!selected.value.includes(id)) selected.value = [...selected.value, id];
}
function closeDialogs() {
  menu.value = null;
  definitionDialog.value = false;
  fieldDialog.value = false;
  rowDialog.value = false;
}
watch(
  () => dailyState.scope,
  () => {
    request++;
    back();
    branch.value = null;
    tables.value = [];
    closeDialogs();
    void run(refresh);
  },
);
watch(
  () => dailyState.tableRevision,
  () => {
    if (!busy.value) void run(refresh);
  },
);
watch([search, showHidden], () => {
  page.value = 0;
  selected.value = [];
});
onMounted(() => run(refresh));
onBeforeUnmount(() => {
  request++;
  cancelPress();
});
</script>
<template>
  <section class="mn-page mn-tables">
    <header class="mn-heading">
      <div>
        <button
          v-if="screen !== 'list'"
          class="mn-back"
          @click="screen === 'design' ? (screen = 'rows') : back()"
        >
          ‹ {{ screen === 'design' ? '返回表格' : '所有表格' }}
        </button>
        <h2>
          {{
            screen === 'list'
              ? '本地自定义表'
              : screen === 'design'
                ? `设计 · ${table?.name ?? ''}`
                : table?.name
          }}
        </h2>
      </div>
      <TableBackfillAction v-if="screen === 'list'" :tables="tables" :disabled="busy || !branch" @done="refresh" />
      <button
        v-if="screen === 'list'"
        class="mn-primary"
        :disabled="busy || !branch"
        @click="newDefinition()"
      >
        ＋ 新建表</button
      ><button
        v-else-if="screen === 'rows'"
        :disabled="busy"
        @click="
          screen = 'design';
          resetSelection();
        "
      >
        设计表
      </button>
    </header>
    <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
    <p v-if="dailyState.tableError" class="mn-warning" role="alert">{{ dailyState.tableError }}</p>
    <p v-if="loading" class="mn-muted" role="status">正在读取表格…</p>
    <template v-if="screen === 'list'">
      <p class="mn-muted">让摘要 AI 顺手更新你的记录。点表名打开；右键、长按或点 ··· 管理表格。</p>
      <div v-if="!branch" class="mn-empty">当前聊天正在归档或尚未绑定。归档完成后即可建表。</div>
      <div v-else-if="!tables.length && !loading" class="mn-empty">
        <strong>留一张表给你的故事</strong>
        <p>例如约定、任务、关系变化。先新建表，再设计字段。</p>
      </div>
      <article
        v-for="def in tables"
        :key="def.id"
        class="mn-list-card"
        @contextmenu.prevent="menu = def"
        @pointerdown="press($event, () => (menu = def))"
        @pointermove="move"
        @pointerup="cancelPress"
        @pointercancel="cancelPress"
      >
        <button class="mn-card-open" @click="activate(() => run(() => openTable(def)))">
          <strong>{{ def.name }}</strong
          ><small>{{ def.columns.length }} 个字段 · {{ def.ai ? '随摘要填写' : '仅手动填写' }}</small>
          <p v-if="def.description">{{ def.description }}</p></button
        ><button class="mn-more" :aria-label="`管理${def.name}`" @pointerdown.stop @click.stop="menu = def">
          ···
        </button>
      </article>
      <details class="mn-card">
        <summary>填写、隐藏与注入说明</summary>
        <p>
          开启“随摘要填写”后，生成最新楼摘要的同一次模型请求会携带表定义、字段说明、填写提示词和已有可见行，并返回增量填表
          JSON；没有独立填表请求。
        </p>
        <p>
          在未开启“仅摘要模式”时，有效的未隐藏行会并入原来的“当前状态”系统提示，位置和时间、地点、人物、物品一致。关闭
          AI 填写只停止自动更新，不停止可见行注入。
        </p>
        <p>
          隐藏行不发给摘要
          AI，也不发给正文生成模型。设计页删除字段后，该字段旧值仍归档，但不再发送。纯历史补摘 /
          高层摘要压缩不填写当前表，以免把未来状态带入旧楼；包含最新楼的批量补摘在同一请求中返回整批净变化。
        </p>
        <p>
          锁定字段第一次写入后不能改；如需改规则，先在设计页调整该字段写入策略。旧版“仅手动”字段保持原限制。
        </p>
      </details>
    </template>
    <template v-else-if="table">
      <p v-if="table.description" class="mn-muted">{{ table.description }}</p>
      <template v-if="screen === 'design'">
        <div class="mn-toolbar">
          <label class="mn-check"
            ><input type="checkbox" :checked="allSelected" @change="selectAll" />全选</label
          >
          <div class="mn-actions">
            <button class="mn-primary" :disabled="busy" @click="editColumn()">新增字段</button
            ><button :disabled="busy || !selected.length" @click="run(deleteColumns)">删除字段</button
            ><button
              @click="
                selectMode = !selectMode;
                selected = [];
              "
            >
              {{ selectMode ? '取消多选' : '多选' }}
            </button>
          </div>
        </div>
        <label class="mn-check"
          ><input
            type="checkbox"
            :checked="table.ai"
            :disabled="busy"
            @change="run(() => save({ ...plain(table!), ai: !table!.ai }))"
          />随原生摘要一起填写（同一次模型请求）</label
        >
        <p class="mn-muted">字段顺序就是表内顺序，行列表展示前两个字段。长按字段可进入多选。</p>
        <article
          v-for="col in table.columns"
          :key="col.id"
          class="mn-field-card"
          :class="{ 'is-selected': selected.includes(col.id) }"
          @pointerdown="press($event, () => selectByPress(col.id))"
          @pointermove="move"
          @pointerup="cancelPress"
          @pointercancel="cancelPress"
          @click="activate(() => (selectMode ? toggle(col.id) : undefined))"
        >
          <div class="mn-field-title">
            <input
              v-if="selectMode"
              type="checkbox"
              :checked="selected.includes(col.id)"
              :aria-label="`选择字段${col.name}`"
              @pointerdown.stop
              @click.stop="toggle(col.id)"
            /><strong>{{ col.name }}</strong
            ><small>{{ typeName(col.type) }} · {{ modeName(col.mode) }}</small
            ><button
              :aria-label="`编辑字段${col.name}`"
              :disabled="busy"
              @pointerdown.stop
              @click.stop="editColumn(col)"
            >
              编辑
            </button>
          </div>
          <p>{{ col.description || '尚未填写字段介绍' }}</p>
          <p class="mn-prompt-preview">{{ col.prompt || '尚未填写 AI 填表提示词' }}</p>
        </article>
        <div v-if="!table.columns.length" class="mn-empty">
          新增第一个字段，说明你想记录什么、AI 应该怎么填写。
        </div>
      </template>
      <template v-else>
        <div class="mn-toolbar">
          <label class="mn-check"
            ><input type="checkbox" :checked="allSelected" @change="selectAll" />全选本页</label
          >
          <div class="mn-actions">
            <button class="mn-primary" :disabled="busy || !table.columns.length" @click="editRecord()">
              新增行</button
            ><button :disabled="busy || !selected.length" @click="run(() => hideRows(true))">隐藏行</button
            ><button :disabled="busy || !selected.length" @click="run(() => hideRows(false))">显示行</button
            ><button
              @click="
                selectMode = !selectMode;
                selected = [];
              "
            >
              {{ selectMode ? '取消多选' : '多选' }}
            </button>
          </div>
        </div>
        <div class="mn-toolbar">
          <input
            v-model="search"
            class="mn-search"
            placeholder="搜索表内记录"
            aria-label="搜索表内记录"
          /><label class="mn-check"><input v-model="showHidden" type="checkbox" />查看隐藏行</label>
        </div>
        <p class="mn-muted">点记录查看和编辑全部字段；长按进入多选。隐藏行不会发送给任何模型。</p>
        <article
          v-for="record in shown"
          :key="record.id"
          class="mn-record"
          :class="{ 'is-selected': selected.includes(record.id), 'is-hidden': record.hidden }"
          @pointerdown="press($event, () => selectByPress(record.id))"
          @pointermove="move"
          @pointerup="cancelPress"
          @pointercancel="cancelPress"
        >
          <input
            v-if="selectMode"
            type="checkbox"
            :checked="selected.includes(record.id)"
            aria-label="选择行"
            @pointerdown.stop
            @click.stop="toggle(record.id)"
          />
          <button
            class="mn-card-open"
            @click="activate(() => (selectMode ? toggle(record.id) : editRecord(record)))"
          >
            <span
              v-for="(col, index) in table.columns.slice(0, 2)"
              :key="col.id"
              :class="index ? 'mn-record-secondary' : 'mn-record-primary'"
              ><small>{{ col.name }}</small
              ><span>{{ display(record.values[col.id]) }}</span></span
            ><small v-if="record.hidden" class="mn-badge">已隐藏 · 不注入</small></button
          ><span class="mn-muted">›</span>
        </article>
        <div v-if="!shown.length && !loading" class="mn-empty">
          {{ search ? '没有匹配的记录' : '还没有可见记录。可以手动新增，或在下次生成摘要时由 AI 填写。' }}
        </div>
        <div class="mn-actions mn-pagination">
          <button
            :disabled="page === 0"
            @click="
              page--;
              selected = [];
            "
          >
            上一页</button
          ><span
            >{{ page + 1 }} / {{ Math.max(1, Math.ceil(filtered.length / 20)) }} ·
            {{ filtered.length }} 行</span
          ><button
            :disabled="(page + 1) * 20 >= filtered.length"
            @click="
              page++;
              selected = [];
            "
          >
            下一页
          </button>
        </div>
      </template>
    </template>
    <ModalMask :open="!!menu" @close="menu = null"
      ><div class="mn-dialog mn-menu" role="dialog" aria-label="管理表格">
        <h3>{{ menu?.name }}</h3>
        <button @click="newDefinition(menu!)">改名</button
        ><button @click="run(() => openTable(menu!, true))">设计表</button
        ><button class="mn-danger" @click="run(() => deleteTable(menu!))">删除表</button
        ><button @click="menu = null">取消</button>
      </div></ModalMask
    >
    <ModalMask :open="definitionDialog" @close="!busy && (definitionDialog = false)"
      ><form class="mn-dialog" role="dialog" aria-label="表格信息" @submit.prevent="run(saveDefinition)">
        <header>
          <h3>{{ editingDef?.version ? '编辑表格' : '新建表格' }}</h3>
          <p>给一组长期记录起个名字</p>
        </header>
        <div class="mn-dialog-body" v-if="editingDef">
          <label>表名<input v-model="editingDef.name" required placeholder="例如：未完成的约定" /></label
          ><label>表格说明<TableTextField v-model="editingDef.description" label="表格说明" /></label
          ><label class="mn-check"><input v-model="editingDef.ai" type="checkbox" />随摘要一起填写</label>
        </div>
        <footer>
          <button type="button" :disabled="busy" @click="definitionDialog = false">取消</button
          ><button class="mn-primary" :disabled="busy">{{ busy ? '保存中…' : '保存' }}</button>
        </footer>
        <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
      </form></ModalMask
    >
    <ModalMask :open="fieldDialog" @close="!busy && (fieldDialog = false)"
      ><form class="mn-dialog" role="dialog" aria-label="字段设计" @submit.prevent="run(saveColumn)">
        <header>
          <h3>{{ originalColumn ? '编辑字段' : '新增字段' }}</h3>
          <p>只编辑当前字段，保存后回到设计列表</p>
        </header>
        <div v-if="editingColumn" class="mn-dialog-body">
          <label>字段名<input v-model="editingColumn.name" required placeholder="例如：约定内容" /></label
          ><label
            >写入策略<BbsSelect
              :model-value="editingColumn.mode"
              :options="modeOptions"
              aria-label="写入策略"
              @update:model-value="editingColumn!.mode = $event as Column['mode']" /></label
          ><small>覆写：替换值；追加：只添加新文本；锁定：首次写入后不可更改。</small
          ><label
            >字段类型<BbsSelect
              v-if="!originalColumn"
              :model-value="editingColumn.type"
              :options="typeOptions"
              aria-label="字段类型"
              @update:model-value="editingColumn!.type = $event as Column['type']"
            /><span v-else class="mn-readonly"
              >{{ typeName(editingColumn.type) }} · 已有字段保留原类型，需换类型请新建字段</span
            ></label
          ><label>字段介绍<TableTextField v-model="editingColumn.description" label="字段介绍" /></label
          ><label
            >给 AI 的填写提示词<TableTextField
              :model-value="editingColumn.prompt ?? ''"
              label="填写提示词"
              @update:model-value="editingColumn!.prompt = $event"
          /></label>
        </div>
        <footer>
          <button type="button" :disabled="busy" @click="fieldDialog = false">取消</button
          ><button class="mn-primary" :disabled="busy">{{ busy ? '保存中…' : '保存' }}</button>
        </footer>
        <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
      </form></ModalMask
    >
    <ModalMask :open="rowDialog" @close="!busy && (rowDialog = false)"
      ><form class="mn-dialog" role="dialog" aria-label="编辑记录" @submit.prevent="run(saveRecord)">
        <header>
          <h3>{{ editingRow ? '编辑记录' : '新增记录' }}</h3>
          <p>{{ table?.name }} · 可拖动输入框右下角放大</p>
        </header>
        <div class="mn-dialog-body">
          <label v-for="col in table?.columns" :key="col.id"
            >{{ col.name }}：<small v-if="cellLocked(col, editingRow?.values[col.id])">已锁定</small
            ><span
              v-if="col.type === 'boolean' && cellLocked(col, editingRow?.values[col.id])"
              class="mn-readonly"
              >{{ display(editingRow?.values[col.id]) }}</span
            ><BbsSelect
              v-else-if="col.type === 'boolean'"
              v-model="draft[col.id]"
              :options="booleanOptions"
              :aria-label="col.name" /><TableTextField
              v-else
              v-model="draft[col.id]"
              :label="col.name"
              :disabled="cellLocked(col, editingRow?.values[col.id])"
          /></label>
        </div>
        <footer>
          <button
            v-if="editingRow"
            type="button"
            class="mn-danger mn-footer-left"
            :disabled="busy"
            @click="run(deleteRecord)"
          >
            删除行</button
          ><button type="button" :disabled="busy" @click="rowDialog = false">取消</button
          ><button class="mn-primary" :disabled="busy">{{ busy ? '保存中…' : '保存' }}</button>
        </footer>
        <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
      </form></ModalMask
    >
  </section>
</template>
