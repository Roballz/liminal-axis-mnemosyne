import { apiSettings, getChannelForTask, type ApiChannel, type TaskType } from './settings';
import { isInappropriateContentError, mainApiAvailable, requestCompletion, requestViaMainApi,
  type ChatMsg, type RequestOptions } from './client';

export interface TaskSendOptions extends RequestOptions {
  /** Reuse the caller's source guard immediately before sending the same input to a backup. */
  beforeFallback?: () => void;
}
export interface TaskSender {
  send: (messages: ChatMsg[], options?: TaskSendOptions) => Promise<string>;
  label: string;
}

const snapshot = (channel: ApiChannel): ApiChannel => ({ ...channel, excludeParams: [...channel.excludeParams] });

/** Only the summary engine opts in; other users of these channels keep their existing transport. */
export function resolveTaskSender(task: TaskType): TaskSender | { error: string } {
  const selected = getChannelForTask(task);
  const primary = selected ? snapshot(selected) : null;
  if (!primary && !mainApiAvailable()) {
    return { error: '未指派副 API 渠道,且当前主 API 不可用(请填好主 API 后重试,或为本任务单独指派渠道)' };
  }
  const fallback = apiSettings.fallbacks[task];
  const selectedBackup = fallback?.enabled
    ? apiSettings.channels.find(channel => channel.id === fallback.channelId) : undefined;
  const backup = selectedBackup && selectedBackup.id !== primary?.id && selectedBackup.url.trim() && selectedBackup.model.trim()
    ? snapshot(selectedBackup) : null;
  return {
    label: primary ? `渠道「${primary.name}」(${primary.model})` : '主 API(主界面当前在用)',
    async send(messages, options = {}) {
      options.signal?.throwIfAborted();
      try {
        return await (primary ? requestCompletion(primary, messages, options) : requestViaMainApi(messages, options));
      } catch (error) {
        if (!backup || options.signal?.aborted || !isInappropriateContentError(error)) throw error;
        options.beforeFallback?.();
        options.signal?.throwIfAborted();
        // No recursive catch: backup failures return to the caller's original retry/error flow.
        return requestCompletion(backup, messages, options);
      }
    },
  };
}
