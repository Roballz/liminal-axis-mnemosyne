<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import Icon from "./Icon.vue";
import ModalMask from "./ModalMask.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import BbsSelect from "./BbsSelect.vue";
import TableTextField from "./TableTextField.vue";
import {
  manualEventState,
  floorEventContext,
  createFloorEvent,
  joinFloorEvent,
  updateEventOverview,
} from "@/mnemosyne/manual-events";
import {
  dailyState,
  hostScope,
  hostVersion,
  syncDaily,
} from "@/mnemosyne/bridge";
import { activeLibrary } from "@/mnemosyne/db";
import { settings, jobState } from "@/mnemosyne/jobs";
import { check } from "@/mnemosyne/model";
const props = defineProps<{ floor: number; disabled?: boolean }>();
const menu = ref(false),
  screen = ref<"new" | "join" | "mode" | "">(""),
  intent = ref(""),
  selected = ref("");
const busy = ref(false),
  error = ref(""),
  notice = ref(""),
  confirmNew = ref(false);
const choices = shallowRef<{ value: string; label: string }[]>([]);
let openedScope = "",
  openedHost = "",
  ticket = 0;
watch(
  () => dailyState.scope,
  () => {
    ticket++;
    screen.value = "";
    menu.value = false;
    confirmNew.value = false;
  },
);
const blocked = computed(
  () => props.disabled || busy.value || jobState.busy || manualEventState.busy,
);
async function open(kind: "new" | "join") {
  const run = ++ticket;
  menu.value = false;
  error.value = "";
  notice.value = "";
  busy.value = true;
  openedScope = hostScope();
  openedHost = hostVersion();
  try {
    const data = await floorEventContext(props.floor);
    if (run !== ticket || openedScope !== hostScope()) return;
    openedHost = hostVersion();
    choices.value = [
      { value: "", label: "请选择事件链" },
      ...data.cards.map((c) => ({ value: c.chain.id, label: c.meta.title })),
    ];
    selected.value = "";
    intent.value = "";
    screen.value = kind;
  } catch (e) {
    error.value = String((e as Error).message);
  } finally {
    busy.value = false;
  }
}
async function apply(create: boolean, update: boolean) {
  if (busy.value || jobState.busy || manualEventState.busy) return;
  busy.value = true;
  manualEventState.busy = true;
  error.value = "";
  confirmNew.value = false;
  try {
    check(
      openedScope === hostScope() && openedHost === hostVersion(),
      "聊天或楼层已改变，请重新打开",
    );
    if (create)
      await createFloorEvent(props.floor, intent.value, settings.maxChars);
    else {
      await joinFloorEvent(props.floor, selected.value);
      if (update) {
        const view = await syncDaily(),
          lib = await activeLibrary(),
          host = hostVersion(),
          generation = dailyState.generation;
        await updateEventOverview(
          lib,
          view,
          selected.value,
          settings.maxChars,
          undefined,
          () => host === hostVersion() && generation === dailyState.generation,
        );
      }
    }
    notice.value = update || create ? "事件已保存" : "已加入事件链，概要待更新";
    screen.value = "";
  } catch (e) {
    error.value = String((e as Error).message);
    openedHost = hostVersion();
  } finally {
    busy.value = false;
    manualEventState.busy = false;
  }
}
</script>
<template>
  <span class="mn-floor-event" @click.stop>
    <button
      class="bbs-btn bbs-btn-sm bbs-btn-primary"
      :disabled="blocked"
      title="添加事件链"
      aria-label="添加事件链"
      @click="menu = !menu"
    >
      <Icon name="events" :size="14" />
    </button>
    <span v-if="menu" class="mn-floor-menu" role="menu">
      <button role="menuitem" @click="open('new')">新建事件链</button>
      <button role="menuitem" @click="open('join')">加入已有链</button>
    </span>
    <small v-if="notice" role="status">{{ notice }}</small>
    <small v-if="error && !screen" role="alert">{{ error }}</small>
    <ModalMask :open="!!screen" @close="!busy && (screen = '')">
      <form
        class="mn-dialog"
        role="dialog"
        :aria-label="screen === 'new' ? '新建事件链' : '加入已有链'"
        @submit.prevent="
          screen === 'new' ? (confirmNew = true) : (screen = 'mode')
        "
      >
        <header>
          <h3>{{ screen === "new" ? "新建事件链" : "加入已有链" }}</h3>
          <small>楼层 #{{ floor }}</small>
        </header>
        <div class="mn-dialog-body">
          <template v-if="screen === 'new'"
            ><p>
              写一段说明用于帮助 AI 理解你想为摘要中的哪件事建立怎样的事件链。
            </p>
            <TableTextField v-model="intent" label="事件链说明"
          /></template>
          <template v-else-if="screen === 'join'"
            ><label
              >已有事件链<BbsSelect
                v-model="selected"
                :options="choices"
                aria-label="已有事件链"
            /></label>
            <p v-if="choices.length === 1">
              还没有事件链，请先新建。
            </p></template
          >
          <template v-else
            ><p>
              立刻更新会调用一次摘要
              API，发送该链全部有效成员，为所有待更新内容生成概要。仅入库不调用模型；已经关联的本楼不会重复写入。
            </p>
            <div class="mn-menu">
              <button
                type="button"
                :disabled="busy"
                @click="apply(false, true)"
              >
                立刻更新概要</button
              ><button
                type="button"
                :disabled="busy"
                @click="apply(false, false)"
              >
                不更新概要（仅入库）
              </button>
            </div></template
          >
          <p v-if="error" class="mn-warning" role="alert">{{ error }}</p>
        </div>
        <footer>
          <button type="button" :disabled="busy" @click="screen = ''">
            取消</button
          ><button
            v-if="screen !== 'mode'"
            :disabled="busy || (screen === 'new' ? !intent.trim() : !selected)"
          >
            {{ screen === "new" ? "新建" : "确认" }}
          </button>
        </footer>
      </form>
    </ModalMask>
    <ConfirmDialog
      v-model:open="confirmNew"
      title="确认调用摘要 API"
      top-layer
      confirm-text="确认发送"
      @confirm="apply(true, true)"
      >发送本次摘要所需上下文、本楼正文和你的说明，调用一次 API
      创建事件链，可能产生费用。是否继续？</ConfirmDialog
    >
  </span>
</template>
<style scoped>
.mn-floor-event {
  position: relative;
  display: inline-block;
}
.mn-floor-menu {
  position: absolute;
  right: 0;
  top: 100%;
  min-width: 140px;
  z-index: 20;
  padding: 6px;
  border: 1px solid var(--bbs-line);
  border-radius: 10px;
  background: var(--bbs-surface);
  box-shadow: var(--bbs-shadow);
}
.mn-floor-menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px;
  border: 0;
  border-radius: 6px;
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  margin: 3px 0;
}
.mn-floor-event small {
  font-size: 11px;
}
</style>
