<script setup lang="ts">
import {
  computed,
  ref,
  shallowRef,
  watch,
  nextTick,
  onBeforeUnmount,
} from "vue";
import { modalHost } from "@/state/ui";
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
  feedback = ref<{ title: string; message: string } | null>(null),
  confirmNew = ref(false);
const acknowledge = ref<HTMLButtonElement | null>(null);
function showFeedback(message: string, failed = false) {
  feedback.value = { title: failed ? "操作未完成" : "操作完成", message };
}
watch(feedback, async (value) => {
  if (!value) return;
  await nextTick();
  acknowledge.value?.focus({ preventScroll: true });
});
const choices = shallowRef<{ value: string; label: string }[]>([]);
let openedScope = "",
  openedHost = "",
  ticket = 0;
watch(
  () => dailyState.scope,
  () => {
    ticket++;
    screen.value = "";
    closeMenu();
    confirmNew.value = false;
    feedback.value = null;
  },
);
const blocked = computed(
  () => props.disabled || busy.value || jobState.busy || manualEventState.busy,
);
// The floor lives inside TT's message clipping/stacking contexts. Mount the menu
// in the shared top-level shadow host; a larger z-index inside the card cannot fix clipping.
const trigger = ref<HTMLButtonElement | null>(null);
const menuElement = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
function closeMenu(restoreFocus = false) {
  menu.value = false;
  document.removeEventListener("pointerdown", outsideMenu, true);
  document.removeEventListener("keydown", menuKeydown, true);
  document.removeEventListener("scroll", viewportChanged, true);
  window.removeEventListener("resize", viewportChanged);
  window.visualViewport?.removeEventListener("resize", viewportChanged);
  window.visualViewport?.removeEventListener("scroll", viewportChanged);
  if (restoreFocus && trigger.value?.isConnected)
    trigger.value.focus({ preventScroll: true });
}
function outsideMenu(event: PointerEvent) {
  const path = event.composedPath();
  if (!path.includes(trigger.value!) && !path.includes(menuElement.value!))
    closeMenu();
}
function viewportChanged(event: Event) {
  if (event.composedPath().includes(menuElement.value!)) return;
  closeMenu();
}
function menuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    const buttons = [
      ...(menuElement.value?.querySelectorAll<HTMLButtonElement>("button") ??
        []),
    ];
    const index = buttons.findIndex((button) =>
      event.composedPath().includes(button),
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  } else if (event.key === "Tab") closeMenu();
}
async function toggleMenu() {
  if (menu.value) {
    closeMenu(true);
    return;
  }
  if (blocked.value) return;
  if (!modalHost.value) {
    showFeedback("界面尚未就绪，请稍后重试", true);
    return;
  }
  const anchor = trigger.value!.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = (viewport?.offsetLeft ?? 0) + 8,
    top = (viewport?.offsetTop ?? 0) + 8;
  const right = left + (viewport?.width ?? window.innerWidth) - 16;
  const bottom = top + (viewport?.height ?? window.innerHeight) - 16;
  menuStyle.value = {
    width: `${Math.min(208, right - left)}px`,
    visibility: "hidden",
  };
  menu.value = true;
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  const rect = menuElement.value.getBoundingClientRect();
  const below = bottom - anchor.bottom - 6,
    above = anchor.top - top - 6;
  const upward = below < rect.height && above > below;
  const height = Math.min(
    rect.height,
    Math.max(44, upward ? above : below),
    bottom - top,
  );
  menuStyle.value = {
    width: `${rect.width}px`,
    maxHeight: `${height}px`,
    left: `${Math.max(left, Math.min(anchor.right - rect.width, right - rect.width))}px`,
    top: `${Math.max(top, Math.min(upward ? anchor.top - height - 6 : anchor.bottom + 6, bottom - height))}px`,
  };
  document.addEventListener("pointerdown", outsideMenu, true);
  document.addEventListener("keydown", menuKeydown, true);
  document.addEventListener("scroll", viewportChanged, true);
  window.addEventListener("resize", viewportChanged);
  window.visualViewport?.addEventListener("resize", viewportChanged);
  window.visualViewport?.addEventListener("scroll", viewportChanged);
  await nextTick(); // The measured menu must be visible before it can receive focus.
  if (menu.value)
    menuElement.value
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
}
watch(blocked, (value) => {
  if (value) closeMenu();
});
onBeforeUnmount(() => {
  ticket++;
  closeMenu();
});
async function open(kind: "new" | "join") {
  const run = ++ticket;
  closeMenu();
  feedback.value = null;
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
    if (run === ticket && openedScope === hostScope())
      showFeedback(String((e as Error).message), true);
  } finally {
    busy.value = false;
  }
}
async function apply(create: boolean, update: boolean) {
  if (busy.value || jobState.busy || manualEventState.busy) return;
  const run = ++ticket;
  let joined = false;
  busy.value = true;
  manualEventState.busy = true;
  feedback.value = null;
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
      joined = true;
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
    if (run === ticket && openedScope === hostScope()) {
      showFeedback(
        update || create
          ? "事件已保存"
          : "本楼已在事件链中，未调用模型更新概要",
      );
      screen.value = "";
    }
  } catch (e) {
    if (run === ticket && openedScope === hostScope()) {
      showFeedback(
        (joined ? "本楼已入库，概要更新未完成。\n" : "") +
          String((e as Error).message),
        true,
      );
      openedHost = hostVersion();
    }
  } finally {
    busy.value = false;
    manualEventState.busy = false;
  }
}
</script>
<template>
  <span class="mn-floor-event" @click.stop>
    <button
      ref="trigger"
      class="bbs-btn bbs-btn-sm bbs-btn-primary"
      aria-haspopup="menu"
      :aria-expanded="menu"
      :disabled="blocked"
      title="添加事件链"
      aria-label="添加事件链"
      @click="toggleMenu"
    >
      <Icon name="events" :size="14" />
    </button>
    <Teleport v-if="modalHost" :to="modalHost">
      <div
        v-if="menu"
        ref="menuElement"
        class="mn-floor-menu"
        role="menu"
        aria-label="事件链操作"
        :style="menuStyle"
        @click.stop
      >
        <button role="menuitem" @click="open('new')">
          <Icon name="plus" :size="15" />新建事件链
        </button>
        <button role="menuitem" @click="open('join')">
          <Icon name="events" :size="15" />加入已有链
        </button>
      </div>
    </Teleport>
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
              立即更新会调用一次摘要
              API，发送该链全部有效成员，为所有待更新内容生成概要。仅入库不调用模型；已经关联的本楼不会重复写入。
            </p>
            <div class="mn-menu">
              <button
                type="button"
                :disabled="busy"
                class="mn-primary"
                @click="apply(false, true)"
              >
                立即更新</button
              ><button
                type="button"
                :disabled="busy"
                @click="apply(false, false)"
              >
                仅入库
              </button>
            </div></template
          >
        </div>
        <footer>
          <button type="button" :disabled="busy" @click="screen = ''">
            取消</button
          ><button
            class="mn-primary"
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
    <ModalMask :open="!!feedback" top-layer>
      <section
        class="mn-dialog mn-event-feedback"
        role="alertdialog"
        aria-modal="true"
        :aria-label="feedback?.title"
        @keydown.esc.stop.prevent
        @keydown.tab.prevent="acknowledge?.focus()"
      >
        <header>
          <h3>{{ feedback?.title }}</h3>
        </header>
        <div class="mn-dialog-body">
          <p>{{ feedback?.message }}</p>
        </div>
        <footer>
          <button ref="acknowledge" class="mn-primary" @click="feedback = null">
            确定
          </button>
        </footer>
      </section>
    </ModalMask>
  </span>
</template>
<style scoped>
.mn-floor-event {
  position: relative;
  display: inline-block;
}
.mn-floor-menu {
  position: fixed;
  z-index: 10003;
  box-sizing: border-box;
  padding: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--bbs-line-strong);
  border-radius: 12px;
  background: var(--bbs-surface);
  color: var(--bbs-ink);
  box-shadow: var(--bbs-shadow);
}
.mn-floor-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  text-align: left;
  padding: 10px 12px;
  border: 0;
  border-radius: 7px;
  font: inherit;
  font-size: 14px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.mn-floor-menu button:hover,
.mn-floor-menu button:focus-visible {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  outline: 2px solid var(--bbs-accent);
  outline-offset: -2px;
}
.mn-event-feedback {
  max-width: 380px;
}
.mn-event-feedback p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
</style>
