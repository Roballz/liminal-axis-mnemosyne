import { getContext } from './context';

/** Rendering an old page is not a content mutation. Bound its expensive refresh
 * work to one latest-chat pass per window, without a trailing debounce that can
 * starve while the host keeps rendering. This never caches authorization checks. */
export function chatRenderBatch(refresh: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ReturnType<typeof snapshot>;
  function snapshot() {
    const ctx = getContext();
    return { chat: ctx?.chat, id: ctx?.getCurrentChatId?.(), character: ctx?.characterId, group: ctx?.groupId };
  }
  const same = (a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) =>
    a.chat === b.chat && a.id === b.id && a.character === b.character && a.group === b.group;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    cancel,
    schedule() {
      const now = snapshot();
      if (timer !== undefined && same(pending, now)) return;
      cancel();
      pending = now;
      timer = setTimeout(() => {
        timer = undefined;
        if (same(now, snapshot())) refresh();
      }, 32);
    },
  };
}
