import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mock = vi.hoisted(() => ({ ctx: { extensionSettings: {} as Record<string, any>, saveSettingsDebounced: vi.fn() } }));
vi.mock('@/st/context', () => ({ getContext: () => mock.ctx }));
let events: EventTarget;
const tick = async () => (await import('vue')).nextTick();
const saved = () => mock.ctx.extensionSettings.mnemosyne_daily;
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules();
  mock.ctx.extensionSettings = {}; mock.ctx.saveSettingsDebounced.mockReset();
  events = new EventTarget(); vi.stubGlobal('window', events);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(async () => {
  await tick(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function ready() {
  const settings = await import('./settings'); settings.hydrateSettings();
  await tick(); settings.flushSettingsNow(); mock.ctx.saveSettingsDebounced.mockClear();
  return settings;
}

test('pre-hydration edits and explicit flush cannot overwrite stored server settings', async () => {
  const settings = await import('./settings');
  mock.ctx.extensionSettings.mnemosyne_daily = { bodyStartTag: 'serverValue' };
  settings.apiSettings.bodyStartTag = 'notHydrated'; await tick();
  settings.flushSettingsNow(); await vi.advanceTimersByTimeAsync(2_000);
  expect(saved()).toEqual({ bodyStartTag: 'serverValue' }); expect(mock.ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  settings.hydrateSettings(); expect(settings.apiSettings.bodyStartTag).toBe('serverValue');
  expect(saved().bodyStartTag).toBe('serverValue'); // Migration/default initialization stays immediate.
});

test('continuous input coalesces the full clone and preserves a detached final snapshot', async () => {
  const settings = await ready();
  settings.apiSettings.prompts.summary = 'synthetic long prompt '.repeat(20_000);
  await tick(); settings.flushSettingsNow(); mock.ctx.saveSettingsDebounced.mockClear();
  const serialized = vi.spyOn(JSON, 'stringify');
  for (let i = 0; i < 12; i++) {
    settings.apiSettings.vector.embedding.url = `https://synthetic.invalid/${i}`;
    await tick(); await vi.advanceTimersByTimeAsync(10);
  }
  expect(serialized).not.toHaveBeenCalled(); expect(mock.ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(serialized.mock.calls.filter(([value]) => value === settings.apiSettings)).toHaveLength(1);
  expect(mock.ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
  expect(saved().vector.embedding.url).toBe('https://synthetic.invalid/11');
  expect(saved().prompts.summary).toBe(settings.apiSettings.prompts.summary);
  settings.apiSettings.vector.embedding.url = 'later edit';
  expect(saved().vector.embedding.url).toBe('https://synthetic.invalid/11');
});

test('a continuous stream reaches the bounded maximum wait and a later batch still saves', async () => {
  const settings = await ready(); const serialized = vi.spyOn(JSON, 'stringify');
  for (let i = 0; i < 10; i++) {
    settings.apiSettings.bodyStartTag = `tag${i}`;
    await tick(); await vi.advanceTimersByTimeAsync(100);
  }
  expect(saved().bodyStartTag).toBe('tag9');
  expect(serialized.mock.calls.filter(([value]) => value === settings.apiSettings)).toHaveLength(1);
  settings.apiSettings.bodyStartTag = 'nextBatch'; await tick(); await vi.advanceTimersByTimeAsync(200);
  expect(saved().bodyStartTag).toBe('nextBatch');
  expect(serialized.mock.calls.filter(([value]) => value === settings.apiSettings)).toHaveLength(2);
});

test('explicit flush cancels both timers and saves current empty, false and zero values', async () => {
  const settings = await ready();
  settings.apiSettings.vector.knowledge.delimiter = '';
  settings.apiSettings.vector.enabled = false; settings.apiSettings.keepRecent = 0;
  await tick(); settings.flushSettingsNow();
  expect(saved().vector.knowledge.delimiter).toBe(''); expect(saved().vector.enabled).toBe(false); expect(saved().keepRecent).toBe(0);
  expect(mock.ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000); expect(mock.ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
});

test('pagehide flushes pending input, including a last edit before the Vue watcher runs', async () => {
  const settings = await ready();
  settings.apiSettings.bodyEndTag = 'beforeHide'; await tick();
  events.dispatchEvent(new Event('pagehide'));
  expect(saved().bodyEndTag).toBe('beforeHide'); expect(mock.ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000); expect(mock.ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
  settings.apiSettings.bodyEndTag = 'lastSynchronousEdit';
  events.dispatchEvent(new Event('pagehide'));
  expect(saved().bodyEndTag).toBe('lastSynchronousEdit');
});

test('deferred snapshot reads the current host settings container when it flushes', async () => {
  const settings = await ready(), previous = mock.ctx.extensionSettings;
  settings.apiSettings.bodyStartTag = 'currentContainer'; await tick();
  mock.ctx.extensionSettings = {};
  await vi.advanceTimersByTimeAsync(200);
  expect(saved().bodyStartTag).toBe('currentContainer');
  expect(previous.mnemosyne_daily.bodyStartTag).not.toBe('currentContainer');
});

test('shared channels and excludes sync promptly while unrelated edits do no fingerprint work', async () => {
  const settings = await ready(), dispatch = vi.spyOn(events, 'dispatchEvent');
  const serialized = vi.spyOn(JSON, 'stringify');
  settings.apiSettings.vector.knowledge.delimiter = 'delimiter'; await tick();
  expect(serialized).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  const channel = { ...settings.newChannel(), name: 'Synthetic channel' };
  settings.apiSettings.channels.push(channel); settings.apiSettings.excludedChars.push('Synthetic excluded'); await tick();
  expect(mock.ctx.extensionSettings.mnemosyne_api_channels.channels[0].name).toBe('Synthetic channel');
  expect(mock.ctx.extensionSettings.mnemosyne_exclude_settings.excludedChars).toEqual(['Synthetic excluded']);
  expect(saved().channels).toEqual([]); // Whole-settings cloning remains deferred.
  expect(dispatch.mock.calls.map(([event]) => event.type)).toEqual([
    'st-baibai-api-channels:changed', 'st-baibai-exclude-settings:changed',
  ]);
  expect(serialized.mock.calls.filter(([value]) => value === settings.apiSettings)).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(200);
  expect(saved().channels[0].name).toBe('Synthetic channel'); expect(saved().excludedChars).toEqual(['Synthetic excluded']);
});

test('incoming shared updates keep local unrelated edits and do not echo back', async () => {
  const settings = await ready(), dispatch = vi.spyOn(events, 'dispatchEvent');
  settings.apiSettings.bodyStartTag = 'localDraft'; await tick();
  const channels = mock.ctx.extensionSettings.mnemosyne_api_channels;
  mock.ctx.extensionSettings.mnemosyne_api_channels = { ...channels, revision: channels.revision + 1,
    channels: [{ ...settings.newChannel(), name: 'External channel' }] };
  const excludes = mock.ctx.extensionSettings.mnemosyne_exclude_settings;
  mock.ctx.extensionSettings.mnemosyne_exclude_settings = { ...excludes, revision: excludes.revision + 1,
    excludedChars: ['External excluded'], customStripTags: ['external_tag'] };
  events.dispatchEvent(new CustomEvent('st-baibai-api-channels:changed'));
  events.dispatchEvent(new CustomEvent('st-baibai-exclude-settings:changed'));
  await tick();
  expect(dispatch).toHaveBeenCalledTimes(2); // Only the two incoming events, no echo.
  expect(settings.apiSettings.channels[0].name).toBe('External channel');
  expect(settings.apiSettings.excludedChars).toEqual(['External excluded']);
  expect(settings.apiSettings.customStripTags).toEqual(['external_tag']);
  await vi.advanceTimersByTimeAsync(200);
  expect(saved().bodyStartTag).toBe('localDraft'); expect(saved().channels[0].name).toBe('External channel');
  expect(saved().excludedChars).toEqual(['External excluded']); expect(saved().customStripTags).toEqual(['external_tag']);
  expect(dispatch).toHaveBeenCalledTimes(2);
});
