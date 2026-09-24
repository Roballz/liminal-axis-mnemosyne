import * as client from '@/api/client';
import * as api from '@/api/settings';
import { regenerateHigherSummary } from '@/memory/engine';
import { invalidateSummaryAncestors } from '@/memory/apply';
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { Library, activateLibrary, freshLibraryName } from './db';
import { bindDaily, syncDaily, dailyState, canonicalLeaves, invalidateDaily, hostVersion, dailyCurrent, captureSummaryEvidence, assertSummaryEvidence, attachSummaryEvidence, confirmFork, dailyBranchChoices } from './bridge';
import { memory } from '@/memory/store';
import { createEmptyMemory } from '@/memory/types';
import { type STContext, type STMessage } from '@/st/context';
import { capture, statuses } from './canonical';
import * as canonical from './canonical';
import { editEvent, eventView } from './events';
import { buildHistoryInjectionText, selectInjectionNodes } from '@/memory/inject';
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

test.each([false, true])('hide/unhide preserves source identity after reload (plugin marker=%s)', async pluginHidden => {
    const first = await syncDaily(), version = hostVersion();
    ctx.chat[0].is_system = true; // a hidden user message is still a user source
    ctx.chat[1].is_system = true;
    if (pluginHidden) ctx.chat[1].extra!.bbs_hidden = true;
    expect(hostVersion()).toBe(version);
    // A warm cache used to mask the role bug until switching chats or reloading.
    dispose?.(); dispose = bindDaily();
    let next = await syncDaily();
    expect(next.refs).toEqual(first.refs);
    expect(next.memories.map(m => m.id)).toEqual(first.memories.map(m => m.id));
    expect(dailyState.review).toBe(0);
    expect(selectInjectionNodes([], ctx.chat).map(n => n.id)).toEqual(['legacy-leaf']);
    ctx.chat.forEach(m => { m.is_system = false; delete m.extra!.bbs_hidden; });
    dispose?.(); dispose = bindDaily();
    next = await syncDaily();
    expect(next.refs).toEqual(first.refs);
    expect(selectInjectionNodes([], ctx.chat)).toEqual([]);
    expect(await lib.all('source_revisions')).toHaveLength(2);
});

test('legacy hidden-role misclassification recovers child events and highest summary without rewriting records', async () => {
    ctx.chat.push(message(true, '第二问'), message(false, '第二段正文'));
    ctx.chat[3].extra!.bbs_leaf = { id: 'second-leaf', text: '第二条摘要', delta: {}, createdAt: 2, v: 1, swipe: 0 };
    memory.summaries.push(
        { id: 'level-1', text: '一级压缩', level: 1, createdAt: 3, auto: true, childIds: ['legacy-leaf', 'second-leaf'] },
        { id: 'level-2', text: '最高层剧情总结', level: 2, createdAt: 4, auto: true, childIds: ['level-1'] },
    );
    for (const m of ctx.chat.filter(m => !m.is_user)) {
        m.is_system = true;
        m.extra!.bbs_hidden = true;
    }
    const parent = await syncDaily();
    ctx.getCurrentChatId = () => 'hidden-child';
    const observe = vi.spyOn(canonical, 'synchronize');
    let view = await confirmFork(parent.branch.id, ctx.chat.length);
    const legacyObservation: canonical.HostObservation = JSON.parse(JSON.stringify(observe.mock.calls.at(-1)![1]));
    const leaf = view.memories.find(m => m.hostId === 'second-leaf')!;
    const eventId = await editEvent(lib, view, null, {
        title: '合成子分支事件', status: 'open', keywords: ['约定'], overview: '已整理的概要', summarized: [leaf.id],
    }, { memory: leaf.id, active: true, kind: 'progress' });
    view = await syncDaily();
    const eventRows = () => Promise.all((['event_chains', 'event_revisions', 'event_memberships', 'event_progress'] as const).map(s => lib.all(s)));
    const recordsBefore = await eventRows(), memoriesBefore = await lib.all('memory_revisions');
    expect(buildHistoryInjectionText()).toContain('最高层剧情总结');
    // Persist the previous adapter's wrong observation, as an already affected installation would.
    delete ctx.chat[1].extra!.bbs_hidden;
    legacyObservation.messages[1].role = 'system';
    await canonical.synchronize(lib, legacyObservation);
    const broken = await capture(lib, view.branch.id);
    expect([...(await statuses(lib, broken)).values()]).toEqual(Array(4).fill('needs_review'));
    expect(await eventView(lib, broken)).toMatchObject({ storedCount: 1, cards: [] });
    const revisionCount = (await lib.all('source_revisions')).length;
    dispose?.(); dispose = bindDaily();
    const recovered = await syncDaily();
    expect(recovered.branch.id).toBe(view.branch.id);
    expect(recovered.refs).toEqual(view.refs); // reselect original revisions; never forge compatibility
    expect(dailyState.review).toBe(0);
    const events = await eventView(lib, recovered);
    expect(events.cards).toHaveLength(1);
    expect(events.cards[0]).toMatchObject({ chain: { id: eventId }, meta: { overview: '已整理的概要' }, members: [{ memory: leaf.id }] });
    expect(selectInjectionNodes(memory.summaries, ctx.chat).map(n => n.id)).toEqual(['level-2']);
    const history = buildHistoryInjectionText();
    expect(history).toContain('最高层剧情总结');
    expect(history).not.toContain('第二条摘要');
    expect(history).not.toContain('一级压缩');
    expect(await eventRows()).toEqual(recordsBefore);
    expect(await lib.all('memory_revisions')).toEqual(memoriesBefore);
    expect(await lib.all('source_revisions')).toHaveLength(revisionCount);
    expect(await lib.all('reviews')).toEqual([]);
    expect(await capture(lib, parent.branch.id)).toEqual(parent);
    // Fixing visibility must still reject an actual later source edit.
    ctx.chat[1].mes += '真正改写剧情';
    invalidateDaily();
    const edited = await syncDaily();
    expect(dailyState.review).toBe(4);
    expect(await eventView(lib, edited)).toMatchObject({ storedCount: 1, cards: [] });
    expect(buildHistoryInjectionText()).not.toContain('最高层剧情总结');
});

test.each(['native', 'notice'])('real system-source changes invalidate the warm cache and in-flight evidence (%s)', async kind => {
    const view = await syncDaily(), host = hostVersion(), generation = dailyState.generation;
    const evidence = await captureSummaryEvidence([0, 1]);
    ctx.chat[1].is_system = true;
    if (kind === 'native') ctx.chat[1].extra!.type = 'narrator';
    else ctx.chat[1].extra!.bbs_internal_notice = 'backlog';
    expect(hostVersion()).not.toBe(host);
    expect(canonicalLeaves()).toEqual([]);
    expect(await dailyCurrent(view, host, generation)).toBe(false);
    expect(() => assertSummaryEvidence(evidence)).toThrow();
    const next = await syncDaily();
    expect(next.sources.get(next.refs[1].revision)?.role).toBe('system');
    expect(dailyState.review).toBe(1);
    expect(await lib.all('reviews')).toEqual([]);
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

test('unchanged refresh and lightweight page scope do not resave or scan sources/summaries', async () => {
    const bridge = await import('./bridge');
    await syncDaily();
    const all = vi.spyOn(lib, 'all'), transaction = vi.spyOn(lib, 'transaction');
    vi.mocked(ctx.saveChat).mockClear(); vi.mocked(ctx.saveMetadata).mockClear();
    expect((await bridge.dailyBranch())?.id).toBe(dailyState.branch);
    invalidateDaily(); // a UI-derived notification with no actual host change
    await syncDaily(); await syncDaily();
    expect(ctx.saveChat).not.toHaveBeenCalled(); expect(ctx.saveMetadata).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
    expect(transaction.mock.calls.every(([stores,mode]) => mode === 'readonly' && stores.length === 1 && stores[0] === 'branches')).toBe(true);
});

test.each([false,true])('one native summary call also fills tables and enters current-state injection (custom=%s)', async custom => {
    const { newTable, saveTable } = await import('./tables');
    const { refreshDailyTables, dailyTableText } = await import('./bridge');
    const { runSummary, engineState } = await import('@/memory/engine');
    const { buildStateInjectionText } = await import('@/memory/inject');
    const { flushLeavesNow } = await import('@/memory/store');
    const view = await syncDaily(), def = newTable(view, '同次调用合成表');
    def.columns = [{ id:'name',name:'名称',type:'text',mode:'lock',description:'事项名',prompt:'从本轮正文提取' }];
    await saveTable(lib,view,def); await refreshDailyTables();
    ctx.name1='User';ctx.name2='Character';ctx.saveMetadataDebounced=vi.fn();
    const oldMode=api.apiSettings.summaryOnlyMode, oldPrompt=api.apiSettings.prompts.summary;
    api.apiSettings.summaryOnlyMode=false;api.apiSettings.prompts.summary=custom?'CUSTOM {{content}}':'';
    vi.spyOn(api,'engineActiveHere').mockReturnValue(true);vi.spyOn(api,'getChannelForTask').mockReturnValue(null);
    vi.spyOn(client,'mainApiAvailable').mockReturnValue(true);
    const request=vi.spyOn(client,'requestViaMainApi').mockResolvedValue(JSON.stringify({summary:'本轮摘要与表格',customTables:[{table_id:def.id,add:[{name:'玉佩约定'}],update:[]}]}));
    try {
        await runSummary(1,{checkResummary:false});
        expect(engineState.lastError).toBe(''); expect(request).toHaveBeenCalledTimes(1);
        const messages=request.mock.calls[0][0];
        expect(messages.map(m=>m.content).join('\n')).toContain('从本轮正文提取');
        expect(messages.map(m=>m.content).join('\n')).toContain('customTables');
        expect(ctx.chat[1].extra?.bbs_leaf?.text).toBe('本轮摘要与表格');
        expect(JSON.stringify(ctx.chat[1].extra?.bbs_leaf?.delta)).not.toContain('customTables');
        await syncDaily();await syncDaily();
        expect(await lib.all('custom_table_rows')).toHaveLength(1);expect(await lib.all('table_receipts')).toHaveLength(1);
        expect(dailyTableText()).toContain('玉佩约定');expect(buildStateInjectionText()).toContain('玉佩约定');
    } finally {api.apiSettings.summaryOnlyMode=oldMode;api.apiSettings.prompts.summary=oldPrompt;flushLeavesNow();}
});

test('host save failure retains a table operation, retry commits once without another model call',async()=>{
    const { newTable, saveTable, readTables, parseSummaryTables }=await import('./tables');
    const { attachTableResult }=await import('./summary-tables');
    const view=await syncDaily(),def=newTable(view,'重试表');def.columns=[{id:'v',name:'进展',type:'text',mode:'append',description:''}];
    await saveTable(lib,view,def);
    const inputs=await readTables(lib,view.branch),plan=parseSummaryTables([{table_id:def.id,add:[{v:'只追加一次'}],update:[]}],inputs,view.branch.id)!;
    attachTableResult(ctx.chat,1,plan);
    vi.mocked(ctx.saveChat).mockRejectedValueOnce(Error('合成聊天保存失败'));
    await expect(syncDaily()).rejects.toThrow('聊天保存失败');expect(await lib.all('custom_table_rows')).toHaveLength(0);
    await syncDaily();await syncDaily();expect(await lib.all('custom_table_rows')).toHaveLength(1);expect(await lib.all('table_receipts')).toHaveLength(1);
});

test('historical summary does not read current table rows and invalid source rows are not sent',async()=>{
    const { prepareSummaryTables }=await import('./summary-tables');
    const { newTable,saveTable,applyRows }=await import('./tables');
    let view=await syncDaily();const def=newTable(view,'时点表');def.columns=[{id:'v',name:'内容',type:'text',mode:'replace',description:''}];
    await saveTable(lib,view,def);view=await syncDaily();
    const stored=(await lib.get<any>('custom_table_defs',def.id))!;
    await applyRows(lib,view,stored,[{row_id:null,values:{v:'失效来源记录'}}],false,[view.memories[0].id]);
    ctx.chat.push(message(true,'新问题'),message(false,'新回复'));invalidateDaily();view=await syncDaily();
    const spy=vi.spyOn(lib,'transaction');
    expect(await prepareSummaryTables(view,ctx.chat,[1])).toBeNull();expect(spy).not.toHaveBeenCalled();spy.mockRestore();
    ctx.chat[0].mes='改写旧正文';invalidateDaily();view=await syncDaily();
    const request=await prepareSummaryTables(view,ctx.chat,[3]);expect(request?.user).not.toContain('失效来源记录');
});

test('latest-floor batch puts table changes beside floors in one request',async()=>{
 const {newTable,saveTable}=await import('./tables');const {refreshDailyTables}=await import('./bridge');
 const {batchBackfill,engineState}=await import('@/memory/engine');const {flushLeavesNow}=await import('@/memory/store');
 ctx.name1='User';ctx.name2='Character';ctx.saveMetadataDebounced=vi.fn();delete ctx.chat[1].extra!.bbs_leaf;
 ctx.chat.push(message(true,'另一问'),message(false,'另一段正文'));
 const view=await syncDaily(),def=newTable(view,'批量同次表');def.columns=[{id:'v',name:'值',type:'text',mode:'replace',description:''}];
 await saveTable(lib,view,def);await refreshDailyTables();
 vi.spyOn(api,'engineActiveHere').mockReturnValue(true);vi.spyOn(api,'getChannelForTask').mockReturnValue(null);vi.spyOn(client,'mainApiAvailable').mockReturnValue(true);
 const request=vi.spyOn(client,'requestViaMainApi').mockResolvedValue(JSON.stringify({floors:[{summary:'第一条'},{summary:'第二条'}],customTables:[{table_id:def.id,add:[{v:'整批净变化'}],update:[]}]}));
 const old=api.apiSettings.batchMaxFloors;api.apiSettings.batchMaxFloors=10;
 try{
  expect(await batchBackfill({floors:[1,3]})).toMatchObject({done:2});expect(engineState.lastError).toBe('');
  expect(request).toHaveBeenCalledTimes(1);expect(request.mock.calls[0][0].map(m=>m.content).join('\n')).toContain('与 floors 并列');
  await syncDaily();expect(await lib.all('custom_table_rows')).toHaveLength(1);
 }finally{api.apiSettings.batchMaxFloors=old;flushLeavesNow();}
});

test('an in-flight native summary cannot overwrite a newly edited table',async()=>{
 const {newTable,saveTable,applyRows}=await import('./tables');const {refreshDailyTables}=await import('./bridge');
 const {runSummary,engineState}=await import('@/memory/engine');const {flushLeavesNow}=await import('@/memory/store');
 ctx.name1='User';ctx.name2='Character';ctx.saveMetadataDebounced=vi.fn();
 const view=await syncDaily(),def=newTable(view,'冲突表');def.columns=[{id:'v',name:'值',type:'text',mode:'replace',description:''}];
 await saveTable(lib,view,def);await refreshDailyTables();
 vi.spyOn(api,'engineActiveHere').mockReturnValue(true);vi.spyOn(api,'getChannelForTask').mockReturnValue(null);vi.spyOn(client,'mainApiAvailable').mockReturnValue(true);
 vi.spyOn(client,'requestViaMainApi').mockImplementationOnce(async()=>{
  const current=await capture(lib,view.branch.id),stored=(await lib.get<any>('custom_table_defs',def.id))!;
  await applyRows(lib,current,stored,[{row_id:null,values:{v:'用户刚保存'}}],false);
  return JSON.stringify({summary:'迟到摘要',customTables:[{table_id:def.id,add:[{v:'迟到 AI 值'}],update:[]}]});
 });
 await runSummary(1,{checkResummary:false});expect(engineState.lastError).toContain('已改变');
 expect(ctx.chat[1].extra?.bbs_leaf?.text).toBe('合成旧摘要');expect((await lib.all<any>('custom_table_rows')).map(r=>r.values.v)).toEqual(['用户刚保存']);flushLeavesNow();
});


test('regenerating a historical leaf clears its superseded failed table request, even with identical text',async()=>{
 const {newTable,saveTable,readTables,parseSummaryTables,applyRows}=await import('./tables');
 const {attachTableResult,TABLE_OUTPUT_KEY}=await import('./summary-tables');
 const view=await syncDaily(),def=newTable(view,'失败后重摘表');def.columns=[{id:'v',name:'值',type:'text',mode:'append',description:''}];
 await saveTable(lib,view,def);
 const plan=parseSummaryTables([{table_id:def.id,add:[{v:'旧请求'}],update:[]}],await readTables(lib,view.branch),view.branch.id)!;
 attachTableResult(ctx.chat,1,plan);
 const current=await capture(lib,view.branch.id),stored=(await lib.get<any>('custom_table_defs',def.id))!;
 await applyRows(lib,current,stored,[{row_id:null,values:{v:'后续人工值'}}],false);
 await syncDaily();expect(dailyState.tableError).toContain('#1 楼');
 const receipts=await lib.all('table_receipts');
 attachTableResult(ctx.chat,1,null); // Same-text historical regeneration has no current table request.
 await syncDaily();expect(dailyState.tableError).toBe('');expect(ctx.chat[1].extra?.[TABLE_OUTPUT_KEY]).toBeUndefined();
 expect(await lib.all('table_receipts')).toEqual(receipts);expect((await lib.all<any>('custom_table_rows'))[0].values.v).toBe('后续人工值');
});

test('branch dropdown uses archived chat names, prioritizes source and reads metadata only', async () => {
    const parent = await syncDaily();
    ctx.getCurrentChatId = () => 'forked-chat';
    invalidateDaily();
    const bindings = await lib.all<any>('host_bindings');
    await lib.transaction(['host_bindings'], 'readwrite', async tx => {
        await tx.put('host_bindings', { ...bindings[0], id: 'foreign', scope: JSON.stringify(['other.png', '其他角色']) });
        await tx.put('host_bindings', { ...bindings[0], id: 'broken', branch: 'missing', scope: JSON.stringify(['synthetic.png', '失效聊天']) });
        await tx.put('host_bindings', { ...bindings[0], id: 'malformed', scope: 'not-json' });
    });
    const spy = vi.spyOn(lib, 'transaction');
    const options = await dailyBranchChoices();
    expect(options).toEqual([{ value: parent.branch.id, label: 'synthetic · 2 条消息 · 当前聊天的来源', inherited: true, length: 2, suggested: 2 }]);
    expect(spy.mock.calls.every(([stores, mode]) => mode === 'readonly' && stores.every(s => ['host_bindings', 'branches', 'history_snapshots'].includes(s)))).toBe(true);
});
test('branch dropdown discards results when chat switches during read', async () => {
    await syncDaily();
    ctx.getCurrentChatId = () => 'forked-chat';
    invalidateDaily();
    const original = lib.transaction.bind(lib);
    vi.spyOn(lib, 'transaction').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        ctx.getCurrentChatId = () => 'another-chat';
        return result;
    });
    await expect(dailyBranchChoices()).rejects.toThrow('聊天已切换');
});
test('named fork rejects changed text or missing identity without altering parent', async () => {
    const parent = await syncDaily();
    ctx.getCurrentChatId = () => 'forked-chat';
    invalidateDaily();
    const option = (await dailyBranchChoices())[0];
    ctx.chat[1].mes = '不同正文';
    await expect(confirmFork(option.value, 2)).rejects.toThrow('身份或正文不匹配');
    ctx.chat[1].mes = '合成答复';
    delete ctx.chat[1].extra!.mnemosyne_message_v1;
    await expect(confirmFork(option.value, 2)).rejects.toThrow('身份或正文不匹配');
    expect((await capture(lib, parent.branch.id)).refs).toEqual(parent.refs);
    expect(await lib.all('branches')).toHaveLength(1);
});
