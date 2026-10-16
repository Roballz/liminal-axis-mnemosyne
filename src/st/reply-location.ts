import { getContext } from './context';

/** Request native navigation, including TT's virtualized history. Never edit/save.
 * TT returns an empty result even when no DOM target was found: do not claim success. */
export async function locateReply(floor: number, valid: () => boolean): Promise<'requested' | 'unsupported'> {
    const ctx = getContext(), chat = ctx?.chat, message = chat?.[floor];
    if (!ctx || !message || !Number.isSafeInteger(floor) || floor < 0 || !valid()) throw new Error('楼层已变化，请重新检查后定位');
    const text = message.mes, swipe = message.swipe_id ?? 0, chatId = ctx.getCurrentChatId(), character = ctx.characterId, group = ctx.groupId;
    const current = () => {
        const now = getContext();
        return valid() && now?.chat === chat && now.getCurrentChatId() === chatId && now.characterId === character &&
            now.groupId === group && chat[floor] === message && message.mes === text && (message.swipe_id ?? 0) === swipe;
    };
    if (!ctx.executeSlashCommandsWithOptions) return 'unsupported';
    let result: unknown;
    try {
        result = await ctx.executeSlashCommandsWithOptions(`/chat-jump ${floor}`, { handleParserErrors: false, handleExecutionErrors: false });
    } catch {
        if (!current()) throw new Error('聊天或楼层已变化，请重新检查后定位');
        return 'unsupported';
    }
    if (!current()) throw new Error('聊天或楼层已变化，请重新检查后定位');
    if (result && typeof result === 'object' && ('isError' in result && result.isError || 'isAborted' in result && result.isAborted)) return 'unsupported';
    return 'requested';
}
