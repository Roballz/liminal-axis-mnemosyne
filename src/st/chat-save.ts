import { getContext, type STContext, type STMessage } from './context';

interface PendingSave {
  chat: STMessage[];
  metadata: STContext['chatMetadata'];
  chatId: string | undefined;
  owner: string;
  dirty: number;
  saved: number;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
}

// A dirty ticket belongs to one chat, not to a transient getContext() wrapper.
// It covers only writes explicitly scheduled by the leaf editors. Archive saves
// also supply their exact host-version guard before acknowledging those tickets.
const pending = new WeakMap<STMessage[], PendingSave>();
const owner = (ctx: STContext) => ctx.characters?.[Number(ctx.characterId)]?.avatar ?? ctx.groupId ?? '';
function sameTarget(state: PendingSave, ctx: STContext | null): ctx is STContext {
  return !!ctx && state.chat === ctx.chat && state.metadata === ctx.chatMetadata &&
    state.chatId === ctx.getCurrentChatId?.() && state.owner === owner(ctx);
}
function stateFor(ctx: STContext): PendingSave {
  let state = pending.get(ctx.chat);
  if (!state || !sameTarget(state, ctx)) {
    state = { chat: ctx.chat, metadata: ctx.chatMetadata, chatId: ctx.getCurrentChatId?.(),
      owner: owner(ctx), dirty: 0, saved: 0 };
    pending.set(ctx.chat, state);
  }
  return state;
}
function clearTimer(state: PendingSave): void {
  if (state.timer !== undefined) clearTimeout(state.timer);
  state.timer = undefined;
}

/** Explicit save: preserve the caller's save requirement, serialize overlapping
 * requests, and acknowledge only the dirty tickets present when this save began.
 * A later edit or a failed save remains pending. */
export function saveChatNow(ctx: STContext, unchanged: () => boolean = () => true): Promise<void> {
  const state = stateFor(ctx);
  const run = async () => {
    if (!sameTarget(state, getContext())) throw new Error('聊天已切换，未保存到其他聊天');
    const version = state.dirty;
    await ctx.saveChat();
    if (sameTarget(state, getContext()) && unchanged()) {
      state.saved = Math.max(state.saved, version);
      if (state.saved === state.dirty) clearTimer(state);
    }
  };
  // Start immediately when idle: callers of the legacy synchronous flush API
  // rely on saveChat being invoked before control returns.
  const result = state.running ? state.running.catch(() => {}).then(run) : run();
  const running = result.finally(() => {
    if (state.running === running) state.running = undefined;
  });
  state.running = running;
  return running;
}

async function flushPending(state: PendingSave): Promise<void> {
  // A slow archive save already covers this ticket; wait instead of saving the
  // same chat concurrently. Recheck after it settles in case another edit came in.
  while (state.running) await state.running.catch(() => {});
  const ctx = getContext();
  if (state.saved < state.dirty && sameTarget(state, ctx)) await saveChatNow(ctx);
}

export function scheduleChatSave(ctx: STContext): void {
  const state = stateFor(ctx);
  state.dirty++;
  clearTimer(state);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void flushPending(state).catch(reportChatSaveError);
  }, 1500);
}

/** The ticket is deliberately retained on failure; the next explicit flush,
 * archive retry, or edit can save it again without an unbounded retry loop. */
export function reportChatSaveError(error: unknown): void {
  console.warn('[Mnemosyne] 聊天保存失败，待下次保存重试', error);
}
