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
it('缺失的破限配置跟随内置默认,不自动开启 Query 破限', async () => {
  mock.ctx.extensionSettings.mnemosyne_daily = { prompts: { summary: '保留摘要模板' } };
  const { apiSettings, hydrateSettings } = await import('./settings'); hydrateSettings();
  expect(apiSettings.prompts.jailbreak).toBe('');
  expect(apiSettings.prompts.summary).toBe('保留摘要模板');
  expect(apiSettings.vector.queryRewriteJailbreak).toBe(false);
});
it.each(['', '  自定义破限正文  ', '<sanctuary_override_directive>已保存旧文本</sanctuary_override_directive>'])
('升级/保存/重载保留原始破限值 %s 和用户开关', async jailbreak => {
  mock.ctx.extensionSettings.mnemosyne_daily = {
    prompts: { jailbreak, summary: '保留摘要模板' }, vector: { queryRewriteJailbreak: true },
  };
  let settings = await import('./settings'); settings.hydrateSettings();
  expect(settings.apiSettings.prompts.jailbreak).toBe(jailbreak);
  expect(settings.apiSettings.vector.queryRewriteJailbreak).toBe(true);
  settings.apiSettings.vector.queryRewriteJailbreak = false;
  await (await import('vue')).nextTick();
  const saved = JSON.parse(JSON.stringify(mock.ctx.extensionSettings.mnemosyne_daily));
  vi.resetModules(); mock.ctx.extensionSettings = { mnemosyne_daily: saved };
  settings = await import('./settings'); settings.hydrateSettings();
  expect(settings.apiSettings.prompts.jailbreak).toBe(jailbreak);
  expect(settings.apiSettings.prompts.summary).toBe('保留摘要模板');
  expect(settings.apiSettings.vector.queryRewriteJailbreak).toBe(false);
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
it('正文边界旧配置默认、非法值回退与保存重载', async () => {
  mock.ctx.extensionSettings.mnemosyne_daily = { bodyStartTag: '<bad>', bodyEndTag: 5 };
  let settings = await import('./settings'); settings.hydrateSettings();
  expect(settings.apiSettings.bodyStartTag).toBe('bbs_start');
  expect(settings.apiSettings.bodyEndTag).toBe('bbs_end');
  settings.apiSettings.bodyStartTag = 'globalTime'; settings.apiSettings.bodyEndTag = 'endTime';
  await (await import('vue')).nextTick();
  const saved = JSON.parse(JSON.stringify(mock.ctx.extensionSettings.mnemosyne_daily));
  expect(saved).toMatchObject({ bodyStartTag: 'globalTime', bodyEndTag: 'endTime' });
  vi.resetModules(); mock.ctx.extensionSettings = { mnemosyne_daily: saved };
  settings = await import('./settings'); settings.hydrateSettings();
  expect(settings.apiSettings.bodyStartTag).toBe('globalTime');
  expect(settings.apiSettings.bodyEndTag).toBe('endTime');
});
