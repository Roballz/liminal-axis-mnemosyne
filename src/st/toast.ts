/**
 * 轻量 toast 封装。ST 全局挂着 toastr(jQuery 插件),直接用它弹非模态提示。
 * 拿不到时静默退回 console.log,绝不抛错(提示失败不应影响主流程)。
 */

type ToastType = 'info' | 'success' | 'warning' | 'error';

interface Toastr {
  info: (msg: string, title?: string, options?: { escapeHtml: boolean }) => void;
  success: (msg: string, title?: string, options?: { escapeHtml: boolean }) => void;
  warning: (msg: string, title?: string, options?: { escapeHtml: boolean }) => void;
  error: (msg: string, title?: string, options?: { escapeHtml: boolean }) => void;
}

export function toast(message: string, type: ToastType = 'info', escapeHtml = false): void {
  try {
    const t = (window as unknown as { toastr?: Toastr }).toastr;
    if (t && typeof t[type] === 'function') {
      if (escapeHtml) t[type](message, '柏宝书', { escapeHtml: true });
      else t[type](message, '柏宝书');
      return;
    }
  } catch {
    /* toastr 不可用 → 退回日志 */
  }
  console.log('[柏宝书]', message);
}
