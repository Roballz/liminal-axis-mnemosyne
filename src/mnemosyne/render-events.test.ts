import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
import type { STContext, STMessage } from '@/st/context';
import { bindEngine } from '@/memory/engine';
import * as store from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import { ReplyFinality, REPLY_FINALITY_KEY } from './reply-finality';
import { Library, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, dailyState, canonicalLeaves, serializeDailyActivation } from './bridge';

const keys = ['USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
  'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SENT', 'CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_ENDED',
  'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'STREAM_TOKEN_RECEIVED'];
const message = (floor: number): STMessage => ({ name: 'Synthetic', is_user: false, is_system: false,
  mes: `Synthetic body ${floor}: ${'a'.repeat(1_000)}`, extra: { bbs_leaf: {
    id: `leaf-${floor}`, text: `Summary ${floor}`, delta: {}, createdAt: 1, v: 1, swipe: 0,
  } } });
let ctx: STContext, lib: Library, chatId: string, win: EventTarget;
let disposeDaily: (() => void) | undefined, disposeEngine: (() => void) | undefined;
let handlers: Map<string, Set<(...args: any[]) => unknown>>;
const emit = async (key: string, ...args: any[]) => {
  for (const callback of handlers.get(key) ?? []) await callback(...args);
};
const drainSync = () => serializeDailyActivation(async () => {});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  Object.assign(store.memory, createEmptyMemory());
  chatId = 'synthetic-render'; handlers = new Map();
  ctx = { chat: Array.from({ length: 155 }, (_, i) => message(i)), chatMetadata: {},
    characters: [{ avatar: 'synthetic.png' }], characterId: 0, getCurrentChatId: () => chatId,
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined),
    setExtensionPrompt: vi.fn(), eventTypes: Object.fromEntries(keys.map(k => [k, k])),
    eventSource: {
      on: (key: string, callback: (...args: any[]) => unknown) => { const set = handlers.get(key) ?? new Set(); set.add(callback); handlers.set(key, set); },
      off: (key: string, callback: (...args: any[]) => unknown) => { handlers.get(key)?.delete(callback); },
    },
  } as unknown as STContext;
  win = Object.assign(new EventTarget(), { SillyTavern: { getContext: () => ctx } });
  vi.stubGlobal('window', win);
  lib = await Library.open(freshLibraryName()); await activateLibrary(lib);
  disposeDaily = bindDaily(); await syncDaily();
  await vi.advanceTimersByTimeAsync(200); await drainSync();
});
afterEach(async () => {
  disposeEngine?.(); disposeDaily?.(); await drainSync(); lib.close();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function countHostSerializations() {
  const original = JSON.stringify;
  const count = { calls: 0 };
  vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args: any[]) => {
    if (Array.isArray(value) && value.length === 4 && typeof value[0] === 'string' &&
      Array.isArray(value[1]) && value[1].length === ctx.chat.length && Array.isArray(value[2])) count.calls++;
    return original(value, ...args as []);
  });
  return count;
}

test('155 unchanged historical renders batch whole-host comparisons and derived replay', async () => {
  const derive = vi.spyOn(store, 'recomputeDerived');
  disposeEngine = bindEngine();
  const serializations = countHostSerializations();
  for (let i = 0; i < 155; i++) await emit('CHARACTER_MESSAGE_RENDERED', i);
  expect(serializations.calls).toBe(0); expect(derive).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(32); await nextTick();
  expect(serializations.calls).toBe(2); expect(derive).toHaveBeenCalledOnce();
  expect(store.derivedMeta.leaves).toHaveLength(155);
});

test('a changed final render is read from the latest body, including direct sync before the timer', async () => {
  for (let i = 0; i < 155; i++) await emit('CHARACTER_MESSAGE_RENDERED', i);
  ctx.chat[154].mes = 'Latest content arriving at the end of the render burst';
  await emit('CHARACTER_MESSAGE_RENDERED', 154);
  // Existing request-time sync is authoritative; it does not wait for a render timer.
  const view = await syncDaily();
  expect(view.sources.get(view.refs[154].revision)?.content).toBe(ctx.chat[154].mes);
  expect(canonicalLeaves().some(l => l.hostId === 'leaf-154')).toBe(false);
});

test('pending and stopped reply permissions are revoked before any render timer', async () => {
  await emit('GENERATION_STARTED', 'regenerate');
  ctx.chat[154].mes = 'Incomplete fragment';
  ctx.streamingProcessor = { messageId: 154, isFinished: false, isStopped: false,
    abortController: { signal: { aborted: false } } };
  await emit('CHARACTER_MESSAGE_RENDERED', 154);
  expect((ctx.chat[154].extra?.[REPLY_FINALITY_KEY] as any).state).toBe('pending');
  expect(canonicalLeaves()).toEqual([]);
  await expect(syncDaily()).rejects.toThrow('暂不归档');
  await emit('GENERATION_STOPPED');
  expect((ctx.chat[154].extra?.[REPLY_FINALITY_KEY] as any).state).toBe('aborted');
  await expect(syncDaily()).rejects.toThrow('暂不归档');
});

test.each(['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED'])('%s invalidates synchronously alongside a pending render batch', async key => {
  await emit('CHARACTER_MESSAGE_RENDERED', 0);
  const before = dailyState.generation;
  if (key === 'MESSAGE_DELETED') ctx.chat.pop();
  else if (key === 'MESSAGE_SWIPED') ctx.chat[154].swipe_id = 1;
  else ctx.chat[154].mes = 'Edited body';
  await emit(key, 154);
  expect(dailyState.generation).toBeGreaterThan(before);
  expect(canonicalLeaves()).toEqual([]);
});

test('chat switch cancels old render work, including switching away and back to the same array', async () => {
  const derive = vi.spyOn(store, 'recomputeDerived'); disposeEngine = bindEngine();
  await emit('CHARACTER_MESSAGE_RENDERED', 154);
  chatId = 'other-chat'; await emit('CHAT_CHANGED');
  chatId = 'synthetic-render'; await emit('CHAT_CHANGED');
  const observe = vi.spyOn(ReplyFinality.prototype, 'observe');
  await vi.advanceTimersByTimeAsync(32);
  expect(derive).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
});

test('pagehide removes listeners and cancels render, mutation, and archive timers', async () => {
  const derive = vi.spyOn(store, 'recomputeDerived'); disposeEngine = bindEngine();
  await emit('CHARACTER_MESSAGE_RENDERED', 154); await emit('MESSAGE_EDITED', 154);
  const observe = vi.spyOn(ReplyFinality.prototype, 'observe');
  win.dispatchEvent(new Event('pagehide'));
  await emit('CHARACTER_MESSAGE_RENDERED', 154);
  await vi.advanceTimersByTimeAsync(1_000); await drainSync();
  expect(derive).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
  expect([...handlers.values()].every(set => set.size === 0)).toBe(true);
});

test('an async render observation cannot restart a disposed binding', async () => {
  let finish!: () => void;
  vi.spyOn(ReplyFinality.prototype, 'observe').mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const rendering = emit('CHARACTER_MESSAGE_RENDERED', 154);
  disposeDaily?.(); finish(); await rendering;
  const serializations = countHostSerializations();
  await vi.advanceTimersByTimeAsync(1_000); await drainSync();
  expect(serializations.calls).toBe(0);
});

test('continuous render events cannot starve the latest derived view or automatic archive', async () => {
  const derive = vi.spyOn(store, 'recomputeDerived'); disposeEngine = bindEngine();
  ctx.chat[154].mes = 'Updated during a continuous render stream';
  for (let i = 0; i < 80; i++) {
    await emit('CHARACTER_MESSAGE_RENDERED', i % 155);
    await vi.advanceTimersByTimeAsync(10);
    if (i % 20 === 0) await drainSync();
  }
  await drainSync();
  expect(derive.mock.calls.length).toBeGreaterThan(1);
  expect(derive.mock.calls.length).toBeLessThanOrEqual(20);
  expect(dailyState.pending).toBe(false);
  expect(dailyState.status).toBe('已归档');
  const view = await syncDaily();
  expect(view.sources.get(view.refs[154].revision)?.content).toBe(ctx.chat[154].mes);
});


test('rebinding cancels old pending renders and an old disposer cannot disable the new binding', async () => {
  const oldDispose = disposeDaily;
  await emit('CHARACTER_MESSAGE_RENDERED', 154);
  disposeDaily = bindDaily(); oldDispose?.();
  const serializations = countHostSerializations();
  await vi.advanceTimersByTimeAsync(32);
  expect(serializations.calls).toBe(0);
  expect(handlers.get('CHARACTER_MESSAGE_RENDERED')?.size).toBe(1);
  const before = dailyState.generation;
  ctx.chat[154].mes = 'Updated under the new binding';
  await emit('MESSAGE_EDITED', 154);
  expect(dailyState.generation).toBeGreaterThan(before);
});

test('a blocked serial writer permits only one automatic job plus one latest-state follow-up', async () => {
  let release!: () => void;
  const held = serializeDailyActivation(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const validate = vi.spyOn(ReplyFinality.prototype, 'assertArchivable');
  try {
    for (let i = 0; i < 12; i++) {
      await emit('CHARACTER_MESSAGE_RENDERED', i);
      await vi.advanceTimersByTimeAsync(232);
    }
    expect(validate).not.toHaveBeenCalled();
  } finally { release(); }
  await held; await drainSync();
  expect(validate).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(200); await drainSync();
  expect(validate).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_000); await drainSync();
  expect(validate).toHaveBeenCalledTimes(2);
});

test('a queued automatic job becomes a no-op after pagehide before the writer releases', async () => {
  let release!: () => void;
  const held = serializeDailyActivation(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  const validate = vi.spyOn(ReplyFinality.prototype, 'assertArchivable');
  try {
    await emit('CHARACTER_MESSAGE_RENDERED', 154);
    await vi.advanceTimersByTimeAsync(232);
    win.dispatchEvent(new Event('pagehide'));
  } finally { release(); }
  await held; await drainSync();
  await vi.advanceTimersByTimeAsync(1_000); await drainSync();
  expect(validate).not.toHaveBeenCalled();
});
