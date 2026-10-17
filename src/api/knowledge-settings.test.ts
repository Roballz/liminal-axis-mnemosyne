import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ ctx: { extensionSettings: {} as Record<string, unknown>, saveSettingsDebounced: vi.fn() } }));
vi.mock('@/st/context', () => ({ getContext: () => mock.ctx }));
beforeEach(() => {
  vi.resetModules(); mock.ctx.extensionSettings = {};
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
it('分隔符修改写入原有设置并在重新载入后原样保留，包括编辑中的空值', async () => {
  let settings = await import('./settings'); settings.hydrateSettings();
  expect(settings.apiSettings.vector.knowledge.delimiter).toBe('=========');
  for (const delimiter of ['.*', ' ✦✦✦ ', '']) {
    settings.apiSettings.vector.knowledge.delimiter = delimiter;
    await (await import('vue')).nextTick();
    const saved = JSON.parse(JSON.stringify(mock.ctx.extensionSettings.mnemosyne_daily));
    expect(saved.vector.knowledge.delimiter).toBe(delimiter);
    vi.resetModules(); mock.ctx.extensionSettings = { mnemosyne_daily: saved };
    settings = await import('./settings'); settings.hydrateSettings();
    expect(settings.apiSettings.vector.knowledge.delimiter).toBe(delimiter);
  }
});
it.each([undefined, null, 4])('旧设置或非法分隔符 %s 仍使用默认符号', async delimiter => {
  mock.ctx.extensionSettings.mnemosyne_daily = { vector: { knowledge: { delimiter } } };
  const settings = await import('./settings'); settings.hydrateSettings();
  expect(settings.apiSettings.vector.knowledge.delimiter).toBe('=========');
});
