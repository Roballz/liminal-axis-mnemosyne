import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { STContext, STMessage } from '@/st/context';
import * as apply from './apply';
import { bindEngine } from './engine';
import { derivedMeta, memory, recomputeDerived } from './store';
import { createEmptyMemory } from './types';

let ctx: STContext, chatId: string, dispose: (() => void) | undefined;
let handlers: Map<string, (...args: unknown[]) => void>;
const message = (floor: number): STMessage => ({ name: 'Synthetic', is_user: false, is_system: false,
  mes: `Synthetic body ${floor}: ${'a'.repeat(2_000)}`, swipe_id: 0,
  extra: { bbs_leaf: { id: `leaf-${floor}`, text: `Summary ${floor}`, createdAt: 1, v: 1, swipe: 0,
    delta: { location: `Place ${floor}` } } },
});
beforeEach(() => {
  vi.useFakeTimers(); handlers = new Map(); chatId = 'render-proof';
  Object.assign(memory, createEmptyMemory());
  ctx = { chat: Array.from({ length: 300 }, (_, i) => message(i)), chatMetadata: {},
    name1: 'User', name2: 'Synthetic', characterId: 0, getCurrentChatId: () => chatId,
    eventTypes: { CHARACTER_MESSAGE_RENDERED: 'render', USER_MESSAGE_RENDERED: 'user', CHAT_CHANGED: 'chat' },
    eventSource: { on: (name: string, callback: (...args: unknown[]) => void) => handlers.set(name, callback),
      off: (name: string) => handlers.delete(name) },
    setExtensionPrompt: vi.fn(),
  } as unknown as STContext;
  vi.stubGlobal('window', Object.assign(new EventTarget(), { SillyTavern: { getContext: () => ctx } }));
  recomputeDerived();
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('20 unchanged render windows over 300 leaves do not replay or publish derived state', () => {
  const derive = vi.spyOn(apply, 'deriveMemory'), rev = derivedMeta.rev, leaves = derivedMeta.leaves;
  dispose = bindEngine();
  for (let i = 0; i < 20; i++) { handlers.get('render')!(i); vi.advanceTimersByTime(50); }
  expect(derive).not.toHaveBeenCalled();
  expect(derivedMeta.rev).toBe(rev); expect(derivedMeta.leaves).toBe(leaves);
  expect(memory.state.location).toBe('Place 299');
});

test('in-place leaf delta and summary edits are observed by render-only refresh', () => {
  const derive = vi.spyOn(apply, 'deriveMemory');
  ctx.chat[299].extra!.bbs_leaf!.delta.location = 'Edited place';
  ctx.chat[299].extra!.bbs_leaf!.text = 'Edited summary';
  recomputeDerived(true);
  expect(derive).toHaveBeenCalledOnce(); expect(memory.state.location).toBe('Edited place');
  expect(derivedMeta.leaves[299].text).toBe('Edited summary');
  recomputeDerived(true); expect(derive).toHaveBeenCalledOnce();
});

test('same-length body/time edits, visibility and speaker changes invalidate the render proof', () => {
  ctx.chat[299].mes = '<bbs_end>2026/10/25 12:00</bbs_end>'; recomputeDerived();
  ctx.chat[299].mes = '<bbs_end>2026/10/25 13:00</bbs_end>'; recomputeDerived(true);
  expect(derivedMeta.latestStoryTime).toBe('2026/10/25 13:00');
  ctx.chat[299].is_system = true; recomputeDerived(true); expect(derivedMeta.leaves[299].active).toBe(true);
  delete ctx.chat[299].extra!.bbs_leaf; ctx.chat[299].is_system = false; recomputeDerived(true);
  expect(derivedMeta.pendingFloors).toContain(299);
  ctx.chat[299].is_user = true; recomputeDerived(true); expect(derivedMeta.pendingFloors).not.toContain(299);
});

test('swipe, omit, append and deletion preserve the complete replay result', () => {
  ctx.chat[299].swipe_id = 1; recomputeDerived(true);
  expect(memory.state.location).toBe('Place 298'); expect(derivedMeta.leaves[299].stale).toBe(true);
  ctx.chat[299].swipe_id = 0; ctx.chat[299].extra!.bbs_omit = true; recomputeDerived(true);
  expect(derivedMeta.leaves).toHaveLength(299); expect(memory.state.location).toBe('Place 298');
  ctx.chat[299].extra!.bbs_omit = false; ctx.chat.push(message(300)); recomputeDerived(true);
  expect(memory.state.location).toBe('Place 300'); expect(derivedMeta.leaves).toHaveLength(301);
  ctx.chat.splice(299, 2); recomputeDerived(true);
  expect(memory.state.location).toBe('Place 298'); expect(derivedMeta.leaves).toHaveLength(299);
});

test('chat scope, same-valued replacement array and forced mutation refresh cannot reuse old state', () => {
  const derive = vi.spyOn(apply, 'deriveMemory');
  chatId = 'another-chat'; recomputeDerived(true);
  ctx.chat = [...ctx.chat]; recomputeDerived(true);
  ctx.characters = [{ name: 'Synthetic', avatar: 'another-card.png' }]; recomputeDerived(true);
  memory.state.location = 'externally reset'; recomputeDerived();
  expect(derive).toHaveBeenCalledTimes(4); expect(memory.state.location).toBe('Place 299');
});

test('runtime macro output and imported-history coverage remain derived inputs', () => {
  let runtimeValue = 'first';
  ctx.substituteParams = value => value.replace('{{runtime}}', runtimeValue);
  memory.varTemplates.chat.json = { runtime: '{{runtime}}' };
  recomputeDerived(true); expect(memory.vars.runtime).toBe('first');
  runtimeValue = 'later'; recomputeDerived(true); expect(memory.vars.runtime).toBe('later');
  delete ctx.chat[0].extra!.bbs_leaf; recomputeDerived(true); expect(derivedMeta.pendingFloors).toContain(0);
  memory.summaries.push({ id: 'imported', text: 'Synthetic imported history', level: 1, createdAt: 1,
    auto: false, childIds: [], imported: true, importedFloorStart: 0, importedFloorEnd: 0 });
  recomputeDerived(true); expect(derivedMeta.pendingFloors).not.toContain(0);
});

test('unknown accessor metadata is replayed conservatively instead of publishing an unsafe proof', () => {
  const derive = vi.spyOn(apply, 'deriveMemory');
  Object.defineProperty(ctx.chat[0].extra!.bbs_leaf!, 'text', { get: () => 'Getter summary', enumerable: true });
  recomputeDerived(true); recomputeDerived(true);
  expect(derive).toHaveBeenCalledTimes(2); expect(derivedMeta.leaves[0].text).toBe('Getter summary');
});
