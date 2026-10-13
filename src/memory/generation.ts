import { engineActiveHere } from '@/api/settings';
import { dailyInstalled, hostScope, syncDaily, preparePromptHistory } from '@/mnemosyne/bridge';
import { getContext } from '@/st/context';
import { handleGenerationIntercept } from './engine';
import { refreshInjection } from './inject';
import { runVectorRecall, shouldRecallForType } from './vector/recall';

/** 宿主在组装提示词前 await；基础记忆同步不能依赖可选的向量召回。 */
export async function prepareGeneration(abort: (immediately: boolean) => void, type: string | undefined): Promise<void> {
  const scope = hostScope(), chat = getContext()?.chat;
  const sameChat = () => {
    if (hostScope() === scope && getContext()?.chat === chat) return true;
    // 只中止旧生成；全局注入槽可能已经属于新聊天，不能由旧任务清除。
    abort(true);
    return false;
  };
  try {
    if (await handleGenerationIntercept(type, abort) || !sameChat()) return;
    if (!shouldRecallForType(type)) return;
    if (engineActiveHere() && dailyInstalled()) {
      try {
        // swipe/重新生成会立即撤销摘要权限；不要抢在防抖归档完成前读取空槽。
        await syncDaily();
      } catch (error) {
        // 保持既有归档失败降级：不重用失效摘要，不把可选记忆故障变成生成硬阻塞。
        console.warn('[柏宝书] 生成前记忆同步失败(仅使用仍有效的注入)', error);
      }
      if (!sameChat()) return;
      refreshInjection();
    }
    await runVectorRecall();
    if (!sameChat()) return;
    // Optional recall may attempt another full sync. Recover the read-only prefix
    // afterwards, without ever accepting the not-yet-created swipe as an archive.
    if (engineActiveHere() && dailyInstalled()) {
      const prepared = await preparePromptHistory(type);
      if (!sameChat()) return;
      if (prepared) refreshInjection();
    }
  } catch (error) {
    if (!sameChat()) return;
    console.error('[柏宝书] 生成拦截器异常(放行本次生成)', error);
  }
}
