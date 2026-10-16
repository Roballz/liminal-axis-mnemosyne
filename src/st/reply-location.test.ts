import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { locateReply } from './reply-location';
import type { STContext } from './context';
let ctx: STContext;
beforeEach(() => {
    ctx = { chat: [{ mes: '旧楼原文', swipe_id: 2 }], characterId: 0, getCurrentChatId: () => 'one',
        executeSlashCommandsWithOptions: vi.fn().mockResolvedValue(''), saveChat: vi.fn() } as unknown as STContext;
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
});
afterEach(() => vi.unstubAllGlobals());
test('native command supports unrendered/virtualized history without a DOM or synthetic edit', async () => {
    await expect(locateReply(0, () => true)).resolves.toBe('requested');
    expect(ctx.executeSlashCommandsWithOptions).toHaveBeenCalledExactlyOnceWith('/chat-jump 0', { handleParserErrors: false, handleExecutionErrors: false });
    expect(ctx.saveChat).not.toHaveBeenCalled(); expect(ctx.chat[0].mes).toBe('旧楼原文');
});
test.each([-1, 1, 0.5, NaN, Infinity, '0 | /gen'])('invalid numeric target %s never executes a command', async floor => {
    await expect(locateReply(floor as number, () => true)).rejects.toThrow('重新检查');
    expect(ctx.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
});
test('missing API, unsupported command and host error use explicit fallback, not false success', async () => {
    ctx.executeSlashCommandsWithOptions = undefined;
    await expect(locateReply(0, () => true)).resolves.toBe('unsupported');
    ctx.executeSlashCommandsWithOptions = vi.fn().mockRejectedValue(new Error('Unknown command'));
    await expect(locateReply(0, () => true)).resolves.toBe('unsupported');
    ctx.executeSlashCommandsWithOptions = vi.fn().mockResolvedValue({ isError: true });
    await expect(locateReply(0, () => true)).resolves.toBe('unsupported');
});
test.each(['context', 'identity', 'body', 'swipe', 'epoch'])('navigation rejects changed %s after host await', async kind => {
    let release!: () => void, valid = true;
    ctx.executeSlashCommandsWithOptions = vi.fn().mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const request = locateReply(0, () => valid);
    if (kind === 'context') ctx = { ...ctx, getCurrentChatId: () => 'two' };
    if (kind === 'identity') ctx.chat[0] = { ...ctx.chat[0] };
    if (kind === 'body') ctx.chat[0].mes += ' changed';
    if (kind === 'swipe') ctx.chat[0].swipe_id = 3;
    if (kind === 'epoch') valid = false;
    release(); await expect(request).rejects.toThrow('重新检查');
});
