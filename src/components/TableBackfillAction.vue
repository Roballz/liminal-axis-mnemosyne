<script setup lang="ts">
import { ref } from "vue";
import ModalMask from "./ModalMask.vue";
import { dailyBranch, hostScope, hostVersion } from "@/mnemosyne/bridge";
import { activeLibrary } from "@/mnemosyne/db";
import {
  tableLastFloors,
  runTableBackfill,
  stopTableBackfill,
  backfillState,
} from "@/mnemosyne/table-backfill";
import { check, type TableDef } from "@/mnemosyne/model";
const props = defineProps<{ tables: TableDef[]; disabled?: boolean }>();
const emit = defineEmits<{ done: [] }>();
const open = ref(false),
  error = ref(""),
  loading = ref(false),
  total = ref(0);
const choices = ref<
  {
    id: string;
    name: string;
    last: number;
    start: number;
    end: number;
    selected: boolean;
  }[]
>([]);
let scope = "",
  host = "";
async function show() {
  loading.value = true;
  error.value = "";
  try {
    scope = hostScope();
    host = hostVersion();
    const branch = await dailyBranch();
    check(branch, "请先归档当前聊天");
    const progress = await tableLastFloors(await activeLibrary(), branch);
    check(
      scope === hostScope() && host === hostVersion(),
      "聊天已改变，请重新打开",
    );
    total.value = progress.total;
    choices.value = props.tables
      .filter((t) => !t.deleted && t.columns.length)
      .map((t) => ({
        id: t.id,
        name: t.name,
        last: progress.floors[t.id] ?? -1,
        start: (progress.floors[t.id] ?? -1) + 1,
        end: total.value - 1,
        selected: false,
      }));
    open.value = true;
  } catch (e) {
    error.value = String((e as Error).message);
  } finally {
    loading.value = false;
  }
}
async function submit() {
  error.value = "";
  try {
    check(
      scope === hostScope() && host === hostVersion(),
      "聊天已改变，请重新打开",
    );
    await runTableBackfill(
      choices.value
        .filter((c) => c.selected)
        .map((c) => ({ table: c.id, start: c.start, end: c.end })),
    );
    emit("done");
    open.value = false;
  } catch (e) {
    error.value = String((e as Error).message);
    emit("done");
  }
}
</script>
<template>
  <button
    :disabled="disabled || loading"
    @click="backfillState.busy ? stopTableBackfill() : show()"
  >
    {{ backfillState.busy ? "停止补表" : "批量补表" }}
  </button>
  <p v-if="error && !open" class="mn-warning" role="alert">{{ error }}</p>
  <ModalMask :open="open" @close="!backfillState.busy && (open = false)"
    ><form
      class="mn-dialog"
      role="dialog"
      aria-label="批量补表"
      @submit.prevent="submit"
    >
      <header>
        <h3>批量补表</h3>
        <p>
          发送所选楼层正文、表定义和可见行，使用摘要
          API。每张表每20楼最多一次请求，可能产生费用；无变化也记录已处理范围。
        </p>
      </header>
      <div class="mn-dialog-body">
        <p>
          楼号从0开始。“最后更新”是最后确认楼层，不保证之前没有缺口。可手填任意合法范围补缺。
        </p>
        <fieldset
          v-for="c in choices"
          :key="c.id"
          :disabled="backfillState.busy"
          class="mn-backfill-choice"
        >
          <label class="mn-check"
            ><input v-model="c.selected" type="checkbox" />{{ c.name }}</label
          >
          <small
            >{{ c.last < 0 ? "尚未更新" : "#" + c.last }} → #{{ total - 1 }} /
            共{{ total }}楼</small
          >
          <div v-if="c.selected" class="mn-backfill-range">
            <label
              >从楼号<input
                v-model.number="c.start"
                type="number"
                min="0"
                :max="total - 1" /></label
            ><label
              >到楼号<input
                v-model.number="c.end"
                type="number"
                :min="c.start"
                :max="total - 1"
            /></label>
          </div>
          <p v-if="c.selected && c.start <= c.last">
            此范围包含已更新楼层：提示词要求只补缺失内容，已有内容不重复新建或更新。
          </p>
        </fieldset>
        <p v-if="!choices.length">没有可补的表，请先建表并设计字段。</p>
        <p role="status">{{ backfillState.status }}</p>
        <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
      </div>
      <footer>
        <button
          type="button"
          :disabled="backfillState.busy"
          @click="open = false"
        >
          取消</button
        ><button
          v-if="backfillState.busy"
          type="button"
          @click="stopTableBackfill"
        >
          停止</button
        ><button class="mn-primary" v-else :disabled="!choices.some((c) => c.selected)">
          确认调用 API 补表
        </button>
      </footer>
    </form></ModalMask
  >
</template>
<style scoped>
.mn-backfill-choice {
  border: 1px solid var(--bbs-line);
  border-radius: 12px;
  padding: 12px;
  margin: 12px 0;
}
.mn-backfill-choice label {
  margin: 0;
}
.mn-backfill-range {
  display: flex;
  gap: 12px;
  margin-top: 10px;
}
.mn-backfill-range label {
  flex: 1;
  min-width: 0;
}
</style>
