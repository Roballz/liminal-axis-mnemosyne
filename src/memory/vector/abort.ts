/** 取消等待也必须结束 Promise；底层任务即使忽略取消，迟到结果也只会被丢弃。 */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('请求已取消')); };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}
