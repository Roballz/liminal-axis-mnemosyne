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
