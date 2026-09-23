import * as client from '@/api/client';
import * as api from '@/api/settings';
import { regenerateHigherSummary } from '@/memory/engine';
import { invalidateSummaryAncestors } from '@/memory/apply';
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { Library, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, dailyState, canonicalLeaves, invalidateDaily, hostVersion, dailyCurrent, captureSummaryEvidence, assertSummaryEvidence, attachSummaryEvidence, confirmFork } from './bridge';
import { memory } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import { type STContext, type STMessage } from '@/st/context';
import { capture, statuses } from './canonical';
let lib: Library, ctx: STContext, dispose: (() => void) | undefined;
const message = (user: boolean, text: string): STMessage => ({ name: user ? 'User' : 'Character', is_user: user, is_system: false, mes: text, extra: {} });
beforeEach(async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
    Object.assign(memory, createEmptyMemory());
    ctx = { chat: [message(true, '合成问题'), message(false, '合成答复')], chatMetadata: {}, characters: [{ name: '合成角色', avatar: 'synthetic.png' }], characterId: 0,
        getCurrentChatId: () => 'synthetic', saveChat: vi.fn().mockResolvedValue(undefined), saveMetadata: vi.fn().mockResolvedValue(undefined),
        eventTypes: {}, eventSource: { on: vi.fn(), off: vi.fn() }, setExtensionPrompt: vi.fn() } as unknown as STContext;
    ctx.chat[1].extra!.bbs_leaf = { id: 'legacy-leaf', text: '合成旧摘要', delta: {}, createdAt: 1, v: 1, swipe: 0 };
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
    lib = await Library.open(freshLibraryName());
    await activateLibrary(lib);
    dispose = bindDaily();
});
afterEach(() => { dispose?.(); lib.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test('real bridge archives once, persists independent host IDs, and exposes canonical IDs/payloads', async () => {
    const first = await syncDaily();
    const second = await syncDaily();
    expect(second.refs).toEqual(first.refs);
    expect(ctx.saveChat).toHaveBeenCalledTimes(1);
    expect(ctx.chat[1].extra!.bbs_leaf!.id).toBe('legacy-leaf');
    const leaves = canonicalLeaves();
    expect(leaves).toHaveLength(1);
    expect(leaves[0].leafId).toMatch(/^mr_/);
    expect(leaves[0].mesFull).toBe('合成答复');
    expect((ctx.chatMetadata.mnemosyne_archive_v1 as any).status).toBe('saved');
    expect(dailyState.pending).toBe(false);
});
test('host write failure stays pending and retries the unsaved message markers', async () => {
    vi.mocked(ctx.saveChat).mockRejectedValueOnce(new Error('host save failed'));
    await expect(syncDaily()).rejects.toThrow('host save failed');
    expect(dailyState.pending).toBe(true);
    expect(await lib.all('source_messages')).toHaveLength(0);
    await syncDaily();
    expect(ctx.saveChat).toHaveBeenCalledTimes(2);
    expect(dailyState.pending).toBe(false);
});
test('canonical failure after host success keeps persistent pending and retries without duplicate source objects', async () => {
    const spy = vi.spyOn(lib, 'transaction');
    spy.mockRejectedValueOnce(new Error('canonical unavailable'));
    await expect(syncDaily()).rejects.toThrow('canonical unavailable');
    expect(dailyState.pending).toBe(true);
    expect((ctx.chatMetadata.mnemosyne_archive_v1 as any).status).toBe('pending');
    spy.mockRestore();
    await syncDaily();
    expect(await lib.all('source_messages')).toHaveLength(2);
    expect(ctx.saveChat).toHaveBeenCalledTimes(2);
});
test('an old-floor edit invalidates recalled material before synchronization', async () => {
    const view = await syncDaily(), host = hostVersion(), generation = dailyState.generation;
    expect(canonicalLeaves()).toHaveLength(1);
    ctx.chat[1].mes = '编辑后的正文';
    invalidateDaily();
    expect(canonicalLeaves()).toHaveLength(0);
    expect(await dailyCurrent(view, host, generation)).toBe(false);
    await syncDaily();
    expect(canonicalLeaves()).toHaveLength(0);
    expect(dailyState.review).toBe(1);
});
test('copied binding requires explicit intent and a proven fixed-prefix fork retains source identities', async () => {
    const parent = await syncDaily();
    ctx.getCurrentChatId = () => 'forked-chat';
    invalidateDaily();
    await expect(syncDaily()).rejects.toThrow('明确选择');
    expect(dailyState.conflict).toBe(true);
    const fork = await confirmFork(parent.branch.id, 2);
    expect(fork.branch.id).not.toBe(parent.branch.id);
    expect(fork.branch.story).toBe(parent.branch.story);
    expect(fork.refs).toEqual(parent.refs);
});
test('summary evidence is actual source refs; extension-authored sidecars do not forge generation provenance', async () => {
    const before = await syncDaily();
    const evidence = await captureSummaryEvidence([0, 1]);
    assertSummaryEvidence(evidence);
    ctx.chat[1].extra!.bbs_leaf!.text = '新摘要';
    ctx.chat[1].mes += '\n<bbs_items>程序写入的合成旁注</bbs_items>';
    attachSummaryEvidence(ctx.chat, 1, evidence, [0, 1]);
    const view = await syncDaily();
    const summary = view.memories[0];
    expect(summary.inputRefs).toEqual(before.refs);
    expect(view.refs[1].revision).not.toBe(before.refs[1].revision);
    expect((await statuses(lib, view)).get(summary.id)).toBe('valid');
    ctx.chat[0].mes = '用户编辑了实际输入';
    invalidateDaily();
    const changed = await syncDaily();
    expect((await statuses(lib, changed)).get(changed.memories[0].id)).toBe('needs_review');
});
test('late summary evidence rejects a changed host before overwriting its leaf', async () => {
    await syncDaily();
    const evidence = await captureSummaryEvidence([0, 1]);
    ctx.chat[1].mes = '请求期间修改';
    expect(() => assertSummaryEvidence(evidence)).toThrow('正文已改变');
    expect(ctx.chat[1].extra!.bbs_leaf!.text).toBe('合成旧摘要');
});
test('nonstandard message groups are archived without fabricated User/Assistant coverage', async () => {
    ctx.chat[0].is_user = false;
    await syncDaily();
    const evidence = await captureSummaryEvidence([0, 1]);
    attachSummaryEvidence(ctx.chat, 1, evidence, [0, 1]);
    const view = await syncDaily();
    expect(view.memories[0].inputRefs).toHaveLength(2);
    expect(view.memories[0].coverage).toHaveLength(0);
});

test('retained higher summaries require an explicit one-level rebuild after a child changes', async () => {
  ctx.chat.push(message(true,'第二问'),message(false,'第二段正文'));
  ctx.chat[3].extra!.bbs_leaf={id:'second-leaf',text:'第二条摘要',delta:{},createdAt:2,v:1,swipe:0};
  memory.summaries.push({id:'high',text:'旧高层摘要',level:1,createdAt:1,auto:true,childIds:['legacy-leaf','second-leaf']});
  await syncDaily();
  ctx.chat[1].extra!.bbs_leaf!.text='修改后的下级';
  expect(invalidateSummaryAncestors('legacy-leaf')).toBe(0);
  invalidateDaily();let view=await syncDaily();
  expect((await statuses(lib,view)).get(view.memories.find(m=>m.hostId==='high')!.id)).toBe('needs_rebuild');
  vi.spyOn(api,'engineActiveHere').mockReturnValue(true);vi.spyOn(api,'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client,'mainApiAvailable').mockReturnValue(true);vi.spyOn(client,'requestViaMainApi').mockResolvedValue('{"summary":"重建后的高层摘要"}');
  await regenerateHigherSummary('high');view=await syncDaily();
  const high=view.memories.find(m=>m.hostId==='high')!;
  expect(high.content).toBe('重建后的高层摘要');expect((await statuses(lib,view)).get(high.id)).toBe('valid');
  expect(client.requestViaMainApi).toHaveBeenCalledTimes(1);expect(memory.summaries).toHaveLength(1);
});
