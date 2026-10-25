import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as model from './model';
import { ReplyFinality, REPLY_FINALITY_KEY, hasTTErrorMarker, type ReplyHost, type ReplyMessage } from './reply-finality';
const message = (mes: string, is_user = false): ReplyMessage => ({ mes, is_user, extra: {} });
let host: ReplyHost, guard: ReplyFinality;
const receipt = (m = host.chat.at(-1)!) => m.extra?.[REPLY_FINALITY_KEY] as any;
const processor = (messageId = host.chat.length - 1) => ({ messageId, isFinished: false, isStopped: false, abortController: { signal: { aborted: false } } });
const save = async (floor: number, text = host.chat[floor].mes) => {
    guard.confirmEdit(floor, text); host.chat[floor].mes = text;
    guard.editStarted(floor); await guard.edited(floor);
};
const stream = () => {
    guard.start('normal'); host.chat.push(message('流式片段'));
    const p = processor(); host.processor = p; return p;
};
const finish = async () => {
    host.processor!.isFinished = true; await guard.end(); await guard.received(host.chat.length - 1);
};
beforeEach(() => { host = { scope: 'chat-a', chat: [message('历史正文 500 502 429'), message('用户问题', true)] }; guard = new ReplyFinality(() => host); });
afterEach(() => vi.restoreAllMocks());

test('ordinary unmarked historical bodies and status numbers remain eligible; only exact marker lines are uncertain', async () => {
    host.chat.push(message('我说：[API Error] 不是剧情外错误'), message('[API Error]\n用户引用', true));
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    expect(hasTTErrorMarker('剧情正文\n[API Error]\n服务失败')).toBe(true);
    expect(hasTTErrorMarker('剧情正文\n[API 错误]\n服务失败', '[API 错误]')).toBe(true);
    expect(hasTTErrorMarker('正文接着[API Error]失败')).toBe(false); // Unmarked/inline failures are not fully classifiable.
    host.chat.push(message('故事中的文档：\n[API Error]\n引用内容'));
    await expect(guard.assertArchivable()).rejects.toThrow('疑似 API 错误'); // Deliberate heuristic collision.
    await save(host.chat.length - 1);
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
});

test('pre-generation stable context archives; quiet, impersonate and dry runs do not create a stuck generation', async () => {
    const revision = guard.revision;
    for (const type of ['quiet', 'impersonate']) guard.start(type);
    guard.start('normal', {}, true); expect(guard.revision).toBe(revision);
    guard.start('normal'); await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    host.chat.push(message('刚发送的问题', true));
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    host.chat.push(message('实际助手楼')); host.processor = processor();
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    await finish(); await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
});

test('received/rendered/ended and per-chunk gen_finished are not streaming completion', async () => {
    const p = stream();
    (host.chat.at(-1) as any).gen_finished = new Date();
    await guard.observe(); await guard.received(2); await guard.end();
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    expect(receipt().state).toBe('pending');
    p.isFinished = true; await guard.received(2);
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
});

test.each(['manual', 'error'])('%s stop remains blocked even when isFinished is true and received is emitted', async kind => {
    const p = stream(); await guard.observe();
    p.isFinished = true; p.abortController.signal.aborted = true; p.isStopped = kind === 'error';
    await guard.end(); await guard.received(2);
    expect(receipt().state).toBe('aborted');
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    host = JSON.parse(JSON.stringify({ ...host, processor: null })); guard = new ReplyFinality(() => host);
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    host.chat[2].mes += '没有明确确认的自动修改';
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('mid-stream attachment creates pending evidence rather than treating a live fragment as history', async () => {
    host.chat.push(message('加载插件时正在生成')); host.processor = processor();
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    expect(receipt().state).toBe('pending');
    host.processor.abortController!.signal!.aborted = true; host.processor.isFinished = true;
    await guard.end(); await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('non-stream requires both received exact body and ended; UI ended alone never succeeds', async () => {
    guard.start(); host.chat.push(message('非流式答复')); await guard.received(2);
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    await guard.end(); await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    guard.start(); host.chat.push(message('未知未完成答复')); await guard.end();
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('localized TT synthetic success-shaped error and appended line marker remain uncertain', async () => {
    host.errorLabel = '[API 错误]'; const p = stream();
    host.chat[2].mes = '生成到一半的故事\n[API 错误]\n请求失败';
    p.isFinished = true; await guard.end(); await guard.received(2);
    expect(receipt().state).toBe('uncertain');
    await expect(guard.assertArchivable()).rejects.toThrow('疑似 API 错误');
});

test('automatic EDITED/UPDATED, cancel, mismatched text and expired intent cannot approve a stopped body', async () => {
    const p = stream(); p.abortController.signal.aborted = true; p.isFinished = true; await guard.end();
    guard.editStarted(2); await guard.edited(2);
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    guard.confirmEdit(2, '确认的正文'); guard.cancelEdit(); host.chat[2].mes = '确认的正文'; guard.editStarted(2); await guard.edited(2);
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    guard.confirmEdit(2, '其他正文'); guard.editStarted(2); await guard.edited(2);
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    guard.confirmEdit(2, host.chat[2].mes); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000);
    guard.editStarted(2); await guard.edited(2);
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('explicit confirmation accepts unchanged or edited stopped fragment only, not another blocked floor', async () => {
    const p = stream(); p.abortController.signal.aborted = true; p.isFinished = true; await guard.end();
    await save(2); expect(receipt().state).toBe('edited');
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    host.processor = null; guard.start(); host.chat.push(message('第二段未确认片段')); await guard.end();
    await save(2, '只确认第一段');
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    await save(3, '确认第二段'); await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
});

test('late received hash result cannot cross a new generation or a chat switch', async () => {
    stream(); host.processor!.isFinished = true;
    let release!: (s: string) => void;
    vi.spyOn(model, 'fingerprint').mockImplementationOnce(() => new Promise(r => { release = r; }));
    const pending = guard.received(2), old = host.chat[2];
    guard.start('regenerate'); old.mes = '新一代片段'; release('old-hash'); await pending;
    expect(receipt(old).hash).toBe(''); await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    const other = [message('另一个聊天的正常正文')]; host = { scope: 'chat-b', chat: other };
    await guard.received(0); await guard.end();
    expect(receipt(other[0])).toBeUndefined(); await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
});

test('confirm intent cannot cross chat or generation changes', async () => {
    stream(); await guard.stop(); guard.confirmEdit(2, '保留');
    host = { scope: 'chat-b', chat: [message('保留')] };
    guard.editStarted(0); await guard.edited(0); expect(receipt()).toBeUndefined();
    guard.confirmEdit(0, '保留'); guard.start('regenerate');
    guard.editStarted(0); await guard.edited(0); expect(receipt()).toBeUndefined();
});

test('durable complete receipt survives explicit clone, rename and floor move; aborted receipt is never laundered', async () => {
    stream(); await finish();
    const good = JSON.parse(JSON.stringify(host.chat[2]));
    host = { scope: 'renamed-child', chat: [good] }; guard.reset();
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    receipt(good).state = 'aborted'; host.chat.unshift(message('新增早期楼', true));
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('pending swipe receipts follow active swipe extra; selecting another historical page does not complete the failed page', async () => {
    host.chat.push({ ...message('第一页'), swipe_id: 1, swipes: ['第一页'], swipe_info: [{ extra: {} }] });
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    guard.start('swipe'); host.chat[2].mes = '新候选片段'; host.chat[2].swipes!.push('新候选片段'); host.chat[2].swipe_info!.push({ extra: {} });
    host.processor = processor(); await guard.observe(); host.processor.isFinished = true; host.processor.abortController!.signal!.aborted = true; await guard.end();
    const failed = host.chat[2].swipe_info![1].extra![REPLY_FINALITY_KEY];
    expect(failed).toMatchObject({ state: 'aborted', swipe: 1 });
    host.chat[2].swipe_id = 0; host.chat[2].mes = '第一页'; host.chat[2].extra = host.chat[2].swipe_info![0].extra;
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    host.chat[2].swipe_id = 1; host.chat[2].mes = '新候选片段'; host.chat[2].extra = host.chat[2].swipe_info![1].extra;
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('verified derived sidecar refresh preserves completion, but concurrent edit or aborted body cannot be blessed', async () => {
    stream(); await finish(); const before = host.chat[2].mes;
    host.chat[2].mes += '<bbs_items>已验证旁注</bbs_items>'; guard.reconcileDerived(2, before);
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    const next = host.chat[2].mes;
    host.chat[2].mes += '<bbs_vars>新旁注</bbs_vars>'; guard.reconcileDerived(2, next);
    host.chat[2].mes = '异步校验期间其他编辑';
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    receipt().state = 'aborted'; guard.reconcileDerived(2, next);
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('whole-scan guard catches earlier-floor mutation while hashing a later receipt', async () => {
    await save(0); host.chat.push(message('第二个确认楼')); await save(2);
    const original = model.fingerprint;
    vi.spyOn(model, 'fingerprint').mockImplementation(async value => {
        const hash = await original(value);
        if (value === '第二个确认楼') host.chat[0].mes = '前楼已改变';
        return hash;
    });
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test.each(['processor', 'swipe'])('whole-scan token catches %s state-only mutation during hashing', async kind => {
    stream(); await finish();
    host.chat[2].swipes = ['流式片段'];
    const original = model.fingerprint;
    vi.spyOn(model, 'fingerprint').mockImplementation(async value => {
        const hash = await original(value);
        if (kind === 'processor') host.processor!.abortController!.signal!.aborted = true;
        else host.chat[2].swipes = [];
        return hash;
    });
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('unknown receipt versions remain uncertain and successful receipt hash mismatch is never generic edit approval', async () => {
    stream(); await finish(); guard.reset(); host.processor = null;
    receipt().version = 2;
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    receipt().version = 1; host.chat[2].mes += '没有确认的改写';
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('first stream token quarantines unchanged continue body before TT writes its first chunk, and later tokens do not recopy receipts', async () => {
    host.chat.pop(); guard.start('continue'); host.processor = processor(0);
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    await guard.streaming(); const first = receipt(host.chat[0]);
    expect(first.state).toBe('pending');
    host.chat[0].mes += '续写片段'; await guard.streaming();
    expect(receipt(host.chat[0])).toBe(first);
    host = JSON.parse(JSON.stringify({ ...host, processor: null })); guard.reset();
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test('multiple confirmations replace intent; consumed intent cannot approve a later automatic rewrite', async () => {
    const p = stream(); p.isFinished = true; p.abortController.signal.aborted = true; await guard.stop();
    guard.confirmEdit(2, '第一次'); guard.confirmEdit(2, '第二次');
    host.chat[2].mes = '第二次'; guard.editStarted(2); await guard.edited(2);
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    host.chat[2].mes = '自动改写'; guard.editStarted(2); await guard.edited(2);
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});


test('terminal processor evidence permits only explicit save after API error when UI END is missing', async () => {
    const p = stream(); host.chat[2].mes = '完整正文\n[API Error]\n尾部错误'; p.isFinished = true;
    await guard.received(2); host.processor = null;
    expect(receipt().state).toBe('uncertain');
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    await save(2, '完整正文');
    expect(receipt().state).toBe('edited');
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
});

test.each(['active-after-end', 'initial-processor', 'replacement-processor', 'wrong-floor', 'no-processor'])('%s cannot provide terminal evidence for native save', async kind => {
    if (kind === 'initial-processor') host.processor = { ...processor(2), isFinished: true };
    guard.start(); host.chat.push(message('完整正文\n[API Error]\n错误'));
    if (kind !== 'no-processor' && kind !== 'initial-processor') host.processor = processor(kind === 'wrong-floor' ? 0 : 2);
    if (host.processor && kind !== 'active-after-end') host.processor.isFinished = true;
    if (kind === 'wrong-floor') await guard.observe();
    else await guard.received(2);
    if (kind === 'active-after-end') await guard.end();
    if (kind === 'replacement-processor') host.processor = { ...processor(2), isFinished: true };
    await save(2, '完整正文');
    expect(receipt()?.state).not.toBe('edited');
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});

test.each(['generation', 'chat', 'swipe', 'intent', 'processor'])('edit hashing cannot authorize a changed %s', async kind => {
    const p = stream(); p.isFinished = true; p.isStopped = true; await guard.stop();
    guard.confirmEdit(2, '已核对正文'); host.chat[2].mes = '已核对正文'; guard.editStarted(2);
    let release!: (s: string) => void;
    vi.spyOn(model, 'fingerprint').mockImplementationOnce(() => new Promise(r => { release = r; }));
    const edited = guard.edited(2), original = host.chat[2];
    if (kind === 'generation') guard.start('regenerate');
    if (kind === 'chat') host = { scope: 'chat-b', chat: [message('另一个聊天')] };
    if (kind === 'swipe') original.swipe_id = 1;
    if (kind === 'intent') guard.cancelEdit();
    if (kind === 'processor') host.processor = processor(2);
    release('not-accepted');
    expect(await edited).not.toBe(true);
    expect(receipt(original).hash).toBe('');
});


test.each(['initial-stopped', 'initial-aborted', 'wrong-floor-stopped', 'wrong-floor-aborted', 'replacement-stopped', 'replacement-aborted'])('%s cannot impersonate this generation stopping', async kind => {
    const stopped = kind.endsWith('stopped');
    const unrelated = { ...processor(kind.startsWith('wrong-floor') ? 0 : 2), isFinished: true,
        isStopped: stopped, abortController: { signal: { aborted: !stopped } } };
    if (kind.startsWith('initial')) host.processor = unrelated;
    guard.start(); host.chat.push(message('未确认正文\n[API Error]\n错误'));
    if (kind.startsWith('replacement')) { host.processor = processor(2); await guard.observe(); }
    host.processor = unrelated;
    await guard.observe(); await guard.received(2);
    await save(2, '手改后的正文');
    expect(receipt()?.state).not.toBe('edited');
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
});


test('deleted generation candidate cannot crash a native save on an older floor', async () => {
    const p = stream(); await guard.observe(); p.isFinished = true;
    host.chat.pop(); host.processor = null;
    await expect(save(0, '用户核对后的历史正文')).resolves.toBeUndefined();
    expect(receipt(host.chat[0]).state).toBe('edited');
});

// Diagnosis only: v1.4.9 history blocker reported after newer normal replies.
test.each(['uncertain', 'aborted', 'cleaned-with-stale-receipt'])('old %s floor survives later replies and latest edit; exact old-floor confirmation recovers it', async kind => {
    host.errorLabel = '[API错误]';
    const oldProcessor = stream(), oldFloor = 2;
    host.chat[oldFloor].mes = '早先已完整输出的正文\n[API错误]\n尾部报错';
    oldProcessor.isFinished = true;
    if (kind === 'aborted') oldProcessor.abortController.signal.aborted = true;
    await guard.received(oldFloor);
    const oldMessage = host.chat[oldFloor];
    if (kind === 'cleaned-with-stale-receipt') oldMessage.mes = '早先已完整输出的正文';
    const unchangedReceipt = JSON.stringify(receipt(oldMessage));
    host.processor = null;
    // Many ordinary later floors do not retroactively approve an old receipt.
    for (let i = 0; i < 50; i++) host.chat.push(message(`后续问题 ${i}`, true), message(`后续正常答复 ${i}`));
    host.chat.push(message('最新问题', true));
    const latestProcessor = stream(), latestFloor = host.chat.length - 1;
    host.chat[latestFloor].mes = '最新正常答复'; latestProcessor.isFinished = true;
    await guard.end(); await guard.received(latestFloor); host.processor = null;
    await save(latestFloor, '用户修改后的最新答复');
    expect(receipt(host.chat[latestFloor]).state).toBe('edited');
    expect(JSON.stringify(receipt(oldMessage))).toBe(unchangedReceipt);
    await expect(guard.assertArchivable()).rejects.toThrow('暂不归档');
    // Opening the exact old floor and saving unchanged is an explicit choice too.
    const oldText = oldMessage.mes;
    await save(oldFloor);
    expect(oldMessage.mes).toBe(oldText);
    expect(receipt(oldMessage).state).toBe('edited');
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
});

test.each(['streaming', 'uncreated', 'pending', 'aborted', 'api_error', 'changed', 'unknown'] as const)('read-only diagnosis and archival gate agree on %s floor/swipe/reason', async expected => {
    host.chat.push(message('待检查正文'));
    const m = host.chat[2];
    m.extra![REPLY_FINALITY_KEY] = { version: 1, epoch: 1, scope: host.scope, floor: 2, swipe: 0,
        state: 'complete', hash: await model.fingerprint(m.mes) };
    if (expected === 'streaming') host.processor = processor(2);
    if (expected === 'uncreated') { m.swipe_id = 1; m.swipes = ['旧正文']; }
    if (expected === 'pending' || expected === 'aborted') receipt(m).state = expected;
    if (expected === 'api_error') receipt(m).state = 'uncertain';
    if (expected === 'changed') m.mes += '未确认改动';
    if (expected === 'unknown') receipt(m).version = 99;
    const before = JSON.stringify(host), revision = guard.revision;
    const page = await guard.inspectBlockers();
    expect(page.items.map(({ floor, swipe, reason }) => ({ floor, swipe, reason }))).toEqual([{ floor: 2, swipe: m.swipe_id ?? 0, reason: expected }]);
    expect(page.current()).toBe(true); expect(page.next).toBeUndefined();
    expect(JSON.stringify(host)).toBe(before); expect(guard.revision).toBe(revision);
    try { await guard.assertArchivable(false); throw new Error('expected quarantine'); }
    catch (e) { expect(e).toMatchObject({ blocker: { floor: 2, swipe: m.swipe_id ?? 0, reason: expected } }); }
});

test('diagnostic pages bound new hashing and results, do not observe/stamp, and keep an explicit partial cursor', async () => {
    host.chat = Array.from({ length: 250 }, (_, i) => ({ ...message(`正文 ${i}`), extra: {
        [REPLY_FINALITY_KEY]: { version: 1, epoch: 1, scope: host.scope, floor: i, swipe: 0, state: 'complete', hash: 'hash' },
    } }));
    const before = JSON.stringify(host), revision = guard.revision;
    const hash = vi.spyOn(model, 'fingerprint').mockResolvedValue('hash');
    const observe = vi.spyOn(guard, 'observe'), stamp = vi.spyOn(guard as any, 'stamp'), candidate = vi.spyOn(guard as any, 'candidate');
    const first = await guard.inspectBlockers();
    expect(first).toMatchObject({ items: [], examined: 100, total: 250, next: { offset: 100 } });
    expect(hash).toHaveBeenCalledTimes(100);
    const second = await guard.inspectBlockers(first.next);
    expect(second.examined).toBe(200); expect(hash).toHaveBeenCalledTimes(200);
    expect(observe).not.toHaveBeenCalled(); expect(stamp).not.toHaveBeenCalled(); expect(candidate).not.toHaveBeenCalled();
    expect(JSON.stringify(host)).toBe(before); expect(guard.revision).toBe(revision);
    host.chat[0].mes += '前页正文改变';
    expect(first.current()).toBe(false); // Old page evidence cannot navigate; continuation is not archival authority.
    const third = await guard.inspectBlockers(second.next);
    expect(third.examined).toBe(250); expect(hash).toHaveBeenCalledTimes(250);
    host.chat = Array.from({ length: 40 }, () => message('[API Error]\n待核对'));
    const issues = await guard.inspectBlockers();
    expect(issues.items).toHaveLength(10); expect(issues.next?.offset).toBe(10); expect(issues.examined).toBe(10);
});

test('read-only candidate resolution does not advance the run floor/page or create a receipt', async () => {
    guard.start(); host.chat.push(message('刚发送的用户消息', true), message('未完成候选'));
    const before = JSON.stringify((guard as any).run), body = JSON.stringify(host.chat);
    const page = await guard.inspectBlockers();
    expect(page.items[0]).toMatchObject({ floor: 3, reason: 'pending' });
    expect(JSON.stringify((guard as any).run)).toBe(before); expect(JSON.stringify(host.chat)).toBe(body);
});

test.each(['chat', 'body', 'swipe', 'generation'])('late diagnostic hash cannot expose a stale %s target', async kind => {
    host.chat[0].extra![REPLY_FINALITY_KEY] = { version: 1, epoch: 1, swipe: 0, state: 'pending', hash: 'hash' };
    let release!: (s: string) => void;
    vi.spyOn(model, 'fingerprint').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = guard.inspectBlockers();
    if (kind === 'chat') host = { scope: 'other', chat: host.chat.slice() };
    if (kind === 'body') host.chat[0].mes += '新正文';
    if (kind === 'swipe') host.chat[0].swipe_id = 1;
    if (kind === 'generation') guard.start();
    release('hash'); await expect(pending).rejects.toThrow('重新检查');
});

test('page access stays local across long user-only tails and continuation validation never revisits a prefix', async () => {
    host.chat = []; guard.start();
    const touched = new Set<number>();
    host.chat = new Proxy(host.chat, { get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) touched.add(Number(property));
        return Reflect.get(target, property, receiver);
    } });
    // Start again to bind the proxy identity; all 320 users count toward the page budget.
    guard.start(); host.chat.push(...Array.from({ length: 320 }, () => message('用户正文', true)), message('等待确认的回复'));
    let cursor: Awaited<ReturnType<ReplyFinality['inspectBlockers']>>['next'];
    for (let offset = 0; offset < 300; offset += 100) {
        touched.clear(); const page = await guard.inspectBlockers(cursor);
        expect(page.examined).toBe(offset + 100);
        expect([...touched].every(i => i >= offset && i < offset + 100)).toBe(true);
        expect(touched.size).toBe(100);
        cursor = page.next;
        touched.clear(); expect(cursor!.current()).toBe(true); expect(touched.size).toBe(0);
    }
    touched.clear(); const last = await guard.inspectBlockers(cursor);
    expect(last.items[0]).toMatchObject({ floor: 320, reason: 'pending' });
    expect(last.next).toBeUndefined(); expect(touched.size).toBe(21);
});

test('first-error UI evidence validates only its exact target, not the archive gate whole-chat snapshot', async () => {
    const touched = new Set<number>();
    host.chat = new Proxy([message('[API Error]\n待确认'), ...Array.from({ length: 300 }, () => message('正常历史正文'))], {
        get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) touched.add(Number(property));
            return Reflect.get(target, property, receiver);
        },
    });
    let issue: any;
    try { await guard.assertArchivable(false); } catch (e) { issue = (e as any).blocker; }
    touched.clear(); expect(issue.current()).toBe(true); expect([...touched]).toEqual([0]);
    host.chat[0].mes += '修改'; expect(issue.current()).toBe(false);
});

test('completed receipts reuse exact body checks; a new stream does not rehash the completed prefix', async () => {
    host.chat = Array.from({ length: 120 }, (_, i) => message(`已完成正文 ${i} ${'合成内容'.repeat(80)}`));
    await Promise.all(host.chat.map(async (m, floor) => {
        m.extra![REPLY_FINALITY_KEY] = { version: 1, epoch: 1, scope: host.scope, floor, swipe: 0,
            state: 'complete', hash: await model.fingerprint(m.mes) };
    }));
    const hash = vi.spyOn(model, 'fingerprint');
    const first = await guard.assertArchivable(false);
    expect(hash).toHaveBeenCalledTimes(120); expect(first()).toBe(true);
    hash.mockClear();
    const second = await guard.assertArchivable(false);
    expect(second()).toBe(true); expect(hash).not.toHaveBeenCalled();
    const page = await guard.inspectBlockers();
    expect(page.items).toEqual([]); expect(page.examined).toBe(100); expect(hash).not.toHaveBeenCalled();

    stream();
    await expect(guard.assertArchivable(false)).rejects.toMatchObject({ blocker: { reason: 'streaming' } });
    await expect(guard.assertSummaryPrefix(120)).resolves.toBeTypeOf('function');
    expect(hash).not.toHaveBeenCalled();
    await finish(); hash.mockClear();
    await guard.assertArchivable(false);
    expect(hash).toHaveBeenCalledTimes(1); expect(hash).toHaveBeenCalledWith('流式片段');
    hash.mockClear(); await guard.assertArchivable(false); expect(hash).not.toHaveBeenCalled();
});

test.each(['same-length-body', 'swipe', 'pending', 'aborted', 'version', 'hash'] as const)('cached completion rejects an unnotified %s mutation', async kind => {
    host.chat = [message('已确认甲')]; await save(0);
    const before = await guard.assertArchivable(false), hash = vi.spyOn(model, 'fingerprint');
    if (kind === 'same-length-body') host.chat[0].mes = '已确认乙';
    if (kind === 'swipe') host.chat[0].swipe_id = 1;
    if (kind === 'pending' || kind === 'aborted') receipt().state = kind;
    if (kind === 'version') receipt().version = 2;
    if (kind === 'hash') receipt().hash = 'different-hash';
    expect(before()).toBe(false);
    await expect(guard.assertArchivable(false)).rejects.toThrow('暂不归档');
    expect(hash).toHaveBeenCalledTimes(1);
    // Rejected entries never become reusable successful proofs.
    await expect(guard.assertArchivable(false)).rejects.toThrow('暂不归档');
    expect(hash).toHaveBeenCalledTimes(2);
});

test.each(['receipt-replaced', 'receipt-epoch', 'message-replaced', 'chat-array', 'scope', 'floor', 'reset'] as const)('exact receipt reuse requires the same %s context', async kind => {
    host.chat = [message('已确认正文')]; await save(0); await guard.assertArchivable(false);
    const hash = vi.spyOn(model, 'fingerprint');
    if (kind === 'receipt-replaced') host.chat[0].extra![REPLY_FINALITY_KEY] = { ...receipt() };
    if (kind === 'receipt-epoch') receipt().epoch++;
    if (kind === 'message-replaced') host.chat[0] = structuredClone(host.chat[0]);
    if (kind === 'chat-array') host.chat = host.chat.slice();
    if (kind === 'scope') host.scope = 'renamed-chat';
    if (kind === 'floor') host.chat.unshift(message('新增早期用户楼', true));
    if (kind === 'reset') guard.reset();
    // Durable receipts can survive explicit copies/renames, but must be validated anew.
    await expect(guard.assertArchivable(false)).resolves.toBeTypeOf('function');
    expect(hash).toHaveBeenCalledTimes(1);
    await guard.assertArchivable(false); expect(hash).toHaveBeenCalledTimes(1);
});

test('cache hits still check active processor, uncreated swipe and stopped candidate state', async () => {
    stream(); await finish(); await guard.assertArchivable(false);
    const hash = vi.spyOn(model, 'fingerprint');
    host.processor!.isFinished = false;
    await expect(guard.assertArchivable(false)).rejects.toMatchObject({ blocker: { reason: 'streaming' } });
    expect(hash).not.toHaveBeenCalled();
    host.processor!.isFinished = true;
    host.chat[2].swipes = [];
    await expect(guard.assertArchivable(false)).rejects.toMatchObject({ blocker: { reason: 'uncreated' } });
    expect(hash).not.toHaveBeenCalled();
    delete host.chat[2].swipes;
    // stop() marks the run synchronously, before its asynchronous aborted receipt is stamped.
    const stopped = guard.stop();
    await stopped;
    await expect(guard.assertArchivable(false)).rejects.toMatchObject({ blocker: { reason: 'aborted' } });
});

test('cached error-marker proof is invalidated when the localized host label changes', async () => {
    host.errorLabel = '[旧错误]'; host.chat = [message('完整正文\n[新错误]\n尾部错误')];
    host.chat[0].extra![REPLY_FINALITY_KEY] = { version: 1, epoch: 1, scope: host.scope, floor: 0, swipe: 0,
        state: 'complete', hash: await model.fingerprint(host.chat[0].mes) };
    await guard.assertArchivable(false);
    const hash = vi.spyOn(model, 'fingerprint'); host.errorLabel = '[新错误]';
    await expect(guard.assertArchivable(false)).rejects.toMatchObject({ blocker: { reason: 'api_error' } });
    expect(hash).toHaveBeenCalledTimes(1);
});

test.each(['earlier-body', 'current-body', 'receipt', 'chat', 'chat-array-in-place', 'scope-in-place', 'generation', 'processor'] as const)('an asynchronous cache miss cannot approve a changed %s', async kind => {
    host.chat = [message('已确认甲')]; await save(0); await guard.assertArchivable(false);
    host.chat.push(message('新增确认楼')); await save(1);
    const expected = await model.fingerprint(host.chat[1].mes), original = model.fingerprint;
    let release!: (hash: string) => void;
    const hash = vi.spyOn(model, 'fingerprint').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = guard.assertArchivable(false);
    await Promise.resolve(); expect(release).toBeTypeOf('function');
    if (kind === 'earlier-body') host.chat[0].mes = '已确认乙';
    if (kind === 'current-body') host.chat[1].mes = '当前未确认楼';
    if (kind === 'receipt') receipt().state = 'pending';
    if (kind === 'chat') host = { scope: 'other-chat', chat: host.chat.slice() };
    if (kind === 'chat-array-in-place') host.chat = host.chat.slice();
    if (kind === 'scope-in-place') host.scope = 'other-chat';
    if (kind === 'generation') guard.start('regenerate');
    if (kind === 'processor') host.processor = processor(1);
    release(expected); await expect(pending).rejects.toThrow('暂不归档');
    expect(hash).toHaveBeenCalledTimes(1); // Earlier exact completed floor used its cached proof.
    if (kind === 'current-body') {
        host.chat[1].mes = '新增确认楼'; hash.mockImplementation(original); hash.mockClear();
        await guard.assertArchivable(false);
        expect(hash).toHaveBeenCalledTimes(1); // The late body mismatch did not prime a cache entry.
    }
});

test('derived-sidecar writes revoke only their exact cached receipt and cannot bless later manual changes', async () => {
    stream(); await finish(); await guard.assertArchivable(false);
    const originalText = host.chat[2].mes;
    host.chat[2].mes += '<bbs_items>已验证旁注</bbs_items>';
    guard.reconcileDerived(2, originalText);
    await expect(guard.assertArchivable()).resolves.toBeTypeOf('function');
    const hash = vi.spyOn(model, 'fingerprint');
    await guard.assertArchivable(false); expect(hash).not.toHaveBeenCalled();
    host.chat[2].mes = host.chat[2].mes.replace('已验证旁注', '未验证旁注');
    await expect(guard.assertArchivable(false)).rejects.toMatchObject({ blocker: { reason: 'changed' } });
    expect(hash).toHaveBeenCalledTimes(1);
});
