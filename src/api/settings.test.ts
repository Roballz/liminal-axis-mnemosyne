import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ ctx: { extensionSettings: {} as Record<string, unknown>, saveSettingsDebounced: vi.fn() } }));
vi.mock('@/st/context', () => ({ getContext: () => mock.ctx }));
let storage: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); storage = new Map(); mock.ctx.extensionSettings = {};
  mock.ctx.saveSettingsDebounced.mockClear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
it('新安装默认关闭成功预览', async () => {
  const { apiSettings, hydrateSettings } = await import('./settings');
  expect(apiSettings.summarySuccessPreviewEnabled).toBe(false);
  hydrateSettings();
  expect(apiSettings.summarySuccessPreviewEnabled).toBe(false);
});
it.each([undefined, null, 'true', 1])('旧配置缺失或非法值 %s 都关闭', async value => {
  mock.ctx.extensionSettings.mnemosyne_daily = { summarySuccessPreviewEnabled: value };
  const { apiSettings, hydrateSettings } = await import('./settings'); hydrateSettings();
  expect(apiSettings.summarySuccessPreviewEnabled).toBe(false);
});
it('开关写入宿主设置；JSON导出/重新载入保留 true 和 false', async () => {
  let settings = await import('./settings'); settings.hydrateSettings();
  for (const enabled of [true, false]) {
    settings.apiSettings.summarySuccessPreviewEnabled = enabled;
    await (await import('vue')).nextTick();
    const exported = JSON.stringify(mock.ctx.extensionSettings.mnemosyne_daily);
    expect(JSON.parse(exported).summarySuccessPreviewEnabled).toBe(enabled);
    vi.resetModules(); mock.ctx.extensionSettings = { mnemosyne_daily: JSON.parse(exported) };
    settings = await import('./settings'); settings.hydrateSettings();
    expect(settings.apiSettings.summarySuccessPreviewEnabled).toBe(enabled);
  }
});
it('旧本地存储迁移缺字段时默认关闭', async () => {
  storage.set('bbs.api.v1', JSON.stringify({ enabled: true }));
  const { apiSettings, hydrateSettings } = await import('./settings'); hydrateSettings();
  expect(apiSettings.summarySuccessPreviewEnabled).toBe(false);
  expect((mock.ctx.extensionSettings.mnemosyne_daily as any).summarySuccessPreviewEnabled).toBe(false);
});
