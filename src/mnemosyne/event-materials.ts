import { cleanBody } from '@/memory/timeTag';
import { sourceRefMatches } from './source-equivalence';
import { eventInputBytes } from './event-token-budget';
import { check, type CapturedView, type MemoryRevision, type SourceRef } from './model';
import type { EventMaterialMode } from './event-settings';

export function eventSourceRefs(memory: MemoryRevision, refsByMessage: Map<string, SourceRef>): SourceRef[] {
  const anchor = memory.anchor && refsByMessage.get(memory.anchor);
  return [...memory.inputRefs.map(r => refsByMessage.get(r.message) ?? r), ...(anchor ? [anchor] : [])];
}

/** Omit disabled text fields entirely; never fall back to a different material mode. */
export function eventMaterial(memory: MemoryRevision, view: CapturedView, refsByMessage: Map<string, SourceRef>,
  representedSources: Set<string>, mode: EventMaterialMode) {
  const refs = eventSourceRefs(memory, refsByMessage);
  const includeSummary = mode !== 'body', includeBody = mode !== 'summary';
  if (includeSummary) check(memory.content.trim(), `事件成员 ${memory.id} 的摘要为空，未发送；请修复摘要或选择正文模式`);
  if (includeBody) check(refs.length, `事件成员 ${memory.id} 没有可用正文来源，未发送；请选择摘要模式或修复来源`);
  const sources: (SourceRef & { body?: string })[] = [];
  for (const ref of refs) {
    if (representedSources.has(ref.revision)) continue;
    representedSources.add(ref.revision);
    if (includeBody) {
      const current = refsByMessage.get(ref.message);
      const body = sourceRefMatches(view.branch, ref, current) ? view.sources.get(current!.revision)?.content : undefined;
      const cleaned = body == null ? '' : cleanBody(body);
      check(cleaned.trim(), `事件成员 ${memory.id} 的正文缺失或清洗后为空，未发送；请选择摘要模式或修复来源`);
      sources.push({ ...ref, body: cleaned });
    } else sources.push({ ...ref });
  }
  return { id: memory.id, storyTime: memory.storyTime,
    ...(includeSummary ? { summary: memory.content } : {}), sources };
}

/** Keep long-chain preparation cooperative, outside every IndexedDB transaction. */
export async function prepareEventMaterials(memories: MemoryRevision[], view: CapturedView,
  refsByMessage: Map<string, SourceRef>, representedSources: Set<string>, mode: EventMaterialMode,
  guard: () => boolean) {
  const materials: { id: string; text: string; bytes: number }[] = [];
  check(guard(), '事件材料准备已停止或聊天已改变');
  let started = performance.now(), characters = 0;
  for (const memory of memories) {
    const text = JSON.stringify(eventMaterial(memory, view, refsByMessage, representedSources, mode));
    materials.push({ id: memory.id, text, bytes: eventInputBytes(JSON.stringify(text)) - 2 });
    characters += text.length;
    // A task boundary (not Promise.resolve) lets paint, stop and host events run.
    // One member is indivisible; its complete payload is still budget-checked before sending.
    if (characters >= 32768 || performance.now() - started >= 8) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      check(guard(), '事件材料准备已停止或聊天已改变');
      characters = 0; started = performance.now();
    }
  }
  return materials;
}
