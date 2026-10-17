import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import type { BackupDisk } from '@/st/native-backups';
import { capture, synchronize } from './canonical';
import { CoreBackups } from './core-backups';
import { ACTIVE_KEY, Library, activateLibrary, activeLibrary, freshLibraryName } from './db';
import { saveMemberships } from './event-memberships';
import { dailySettingsDefaults, settings } from './event-settings';
import { editEvent, eventView } from './events';
import { fixture } from './fixtures';
import { loadDailySettings, saveDailySettings } from './jobs';
import { eventCoverageUpgradeNeeded, eventPending, keepEventOverview } from './manual-events';
import { exportLibrary, restoreLibrary } from './migration';

class Disk implements BackupDisk {
    files = new Map<string, Blob>();
    async list() { return [...this.files.keys()]; }
    async read(key: string) { const value = this.files.get(key); if (!value) throw new Error('missing'); return value; }
    async write(key: string, value: Blob) { this.files.set(key, value); }
    async remove(key: string) { this.files.delete(key); }
    async readSettings() { return undefined; }
    async writeSettings() {}
}
const selectors = new Map<string, string>();
const libraries: Library[] = [];
const originalPrompt = apiSettings.prompts.eventOverview;
beforeEach(() => {
    selectors.clear();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => selectors.get(key) ?? null,
        setItem: (key: string, value: string) => { selectors.set(key, value); },
    });
    Object.assign(settings, dailySettingsDefaults);
});
afterEach(() => {
    libraries.splice(0).forEach(lib => lib.close());
    apiSettings.prompts.eventOverview = originalPrompt;
    Object.assign(settings, dailySettingsDefaults);
    vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function emptyLibrary(value?: Partial<typeof dailySettingsDefaults>) {
    const lib = await Library.open(freshLibraryName()); libraries.push(lib);
    if (value) await lib.transaction(['library_meta'], 'readwrite', tx => tx.put('library_meta', {
        id: 'daily-settings', schema: 1, value,
    } as any));
    return lib;
}

test.each(['file', 'disk'] as const)('%s restore reloads saved settings before sync; retained event coverage and real source invalidation survive', async route => {
    const { lib, input, branch, view } = await fixture(1); libraries.push(lib);
    await activateLibrary(lib);
    Object.assign(settings, { overviewMaterialMode: 'summary', overviewMaxChars: 1400, overviewBatchTokens: 91000, chains: 4, excerptChars: 700 });
    await saveDailySettings();
    const created = await saveMemberships(lib, view, { mode: 'add', memories: view.memories.map(m => m.id), eventIds: [], newTitle: '合成保留事件' });
    let current = await capture(lib, branch.id);
    let card = (await eventView(lib, current)).cards[0];
    await editEvent(lib, current, created.created!, { ...card.meta, overview: '人工核对后保留的合成概要' });
    current = await capture(lib, branch.id);
    await keepEventOverview(lib, current, created.created!);
    const pack = await exportLibrary(lib), backups = new CoreBackups(new Disk());
    const saved = await backups.save(lib, 'manual');
    if (saved.state !== 'saved') throw new Error('fixture backup not saved');
    const previous = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'body', overviewMaxChars: 300, overviewBatchTokens: 20000 });
    await activateLibrary(previous);
    apiSettings.prompts.eventOverview = '独立的宿主提示词，不随核心库切换';
    const hostSettings = JSON.stringify(apiSettings);
    expect(settings.overviewMaterialMode).toBe('body');

    // Actual functions used by the file-import and disk-panel entry paths. No manual settings load.
    const restored = route === 'file' ? await restoreLibrary(pack) : await backups.restore(saved.entry.key, saved.entry.checksum);
    libraries.push(restored);
    expect(await activeLibrary()).toBe(restored);
    expect(selectors.get(ACTIVE_KEY)).toBe(restored.db.name);
    expect(settings).toMatchObject({ overviewMaterialMode: 'summary', overviewMaxChars: 1400, overviewBatchTokens: 91000, chains: 4, excerptChars: 700 });
    expect(JSON.stringify(apiSettings)).toBe(hostSettings);
    card = (await eventView(restored, await capture(restored, branch.id))).cards[0];
    expect(card.meta.overviewCoverage).toBe(1);
    expect(card.meta.overviewMaterialMode).toBe('summary');
    expect(card.meta.overview).toBe('人工核对后保留的合成概要');
    expect(eventCoverageUpgradeNeeded(card)).toBe(false);
    expect(eventPending(card)).toBe(false);

    await synchronize(restored, input);
    card = (await eventView(restored, await capture(restored, branch.id))).cards[0];
    expect(eventCoverageUpgradeNeeded(card)).toBe(false); expect(eventPending(card)).toBe(false);
    input.messages[1].content += ' 原文确实发生变化';
    await synchronize(restored, input);
    card = (await eventView(restored, await capture(restored, branch.id))).cards[0];
    expect(eventPending(card)).toBe(true); expect(card.blocked).toBe(true);
    expect(card.meta.overviewCoverage).toBe(1); // Reloading settings never silently approves changed sources.
});

test('activating a legacy library resets only daily options to defaults without saving fabricated settings', async () => {
    const previous = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'body', overviewMaxChars: 1800 });
    await activateLibrary(previous);
    const legacy = await emptyLibrary({ interval: 77 });
    await activateLibrary(legacy);
    expect(settings).toEqual({ ...dailySettingsDefaults, interval: 77 });
    expect((await legacy.get<any>('library_meta', 'daily-settings'))?.value).toEqual({ interval: 77 });
});

test.each(['file', 'disk'] as const)('%s restore settings read failure leaves the old selector and runtime settings intact', async route => {
    const { lib } = await fixture(1); libraries.push(lib);
    const pack = await exportLibrary(lib), backups = new CoreBackups(new Disk());
    const saved = await backups.save(lib, 'manual');
    if (saved.state !== 'saved') throw new Error('fixture backup not saved');
    const previous = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'body', overviewMaxChars: 333 });
    await activateLibrary(previous);
    const before = { ...settings }, get = Library.prototype.get;
    vi.spyOn(Library.prototype, 'get').mockImplementation(function (this: Library, store, key) {
        if (this !== previous && store === 'library_meta' && key === 'daily-settings') return Promise.reject(new Error('synthetic settings read failed'));
        return get.call(this, store, key);
    });
    await expect(route === 'file' ? restoreLibrary(pack) : backups.restore(saved.entry.key, saved.entry.checksum)).rejects.toThrow('synthetic settings read failed');
    expect(await activeLibrary()).toBe(previous);
    expect(selectors.get(ACTIVE_KEY)).toBe(previous.db.name);
    expect(settings).toEqual(before);
    expect(await previous.all('library_meta')).toHaveLength(1);
});

test('selector write failure does not replace runtime settings or the active library', async () => {
    const previous = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'body' });
    await activateLibrary(previous);
    const next = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'summary' });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('synthetic selector failure'); });
    await expect(activateLibrary(next)).rejects.toThrow('synthetic selector failure');
    expect(await activeLibrary()).toBe(previous);
    expect(selectors.get(ACTIVE_KEY)).toBe(previous.db.name);
    expect(settings.overviewMaterialMode).toBe('body');
});

test('disk restore rechecks the existing page guard after reading settings and before activation', async () => {
    const { lib } = await fixture(1); libraries.push(lib);
    const backups = new CoreBackups(new Disk()), saved = await backups.save(lib, 'manual');
    if (saved.state !== 'saved') throw new Error('fixture backup not saved');
    const previous = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'body' });
    await activateLibrary(previous);
    let release!: () => void, current = true;
    const get = Library.prototype.get;
    vi.spyOn(Library.prototype, 'get').mockImplementation(function (this: Library, store, key) {
        if (this !== previous && store === 'library_meta' && key === 'daily-settings')
            return new Promise(resolve => { release = () => resolve(undefined); });
        return get.call(this, store, key);
    });
    const restoring = backups.restore(saved.entry.key, saved.entry.checksum, () => current);
    await vi.waitFor(() => expect(release).toBeDefined());
    current = false;
    const rejected = expect(restoring).rejects.toThrow('新库未启用');
    release(); await rejected;
    expect(await activeLibrary()).toBe(previous);
    expect(selectors.get(ACTIVE_KEY)).toBe(previous.db.name);
    expect(settings.overviewMaterialMode).toBe('body');
});

test('a delayed settings read from the previous library cannot overwrite restored settings', async () => {
    const previous = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'body' });
    await activateLibrary(previous);
    let release!: (value: any) => void;
    const oldRead = vi.spyOn(previous, 'get').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = loadDailySettings();
    await vi.waitFor(() => expect(oldRead).toHaveBeenCalledOnce());
    const next = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'summary', overviewMaxChars: 1700 });
    await activateLibrary(next);
    release({ value: { ...dailySettingsDefaults, overviewMaterialMode: 'body', overviewMaxChars: 250 } });
    await pending;
    expect(settings.overviewMaterialMode).toBe('summary'); expect(settings.overviewMaxChars).toBe(1700);
});

test('same-turn old then new settings reads cannot reapply the previous library after activation', async () => {
    const previous = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'body' });
    await activateLibrary(previous);
    const next = await emptyLibrary({ ...dailySettingsDefaults, overviewMaterialMode: 'summary' });
    let releaseOld!: (value: any) => void, releaseNew!: (value: any) => void;
    const oldRead = vi.spyOn(previous, 'get').mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }));
    const newRead = vi.spyOn(next, 'get').mockImplementationOnce(() => new Promise(resolve => { releaseNew = resolve; }));
    const pending = loadDailySettings();
    await vi.waitFor(() => expect(oldRead).toHaveBeenCalledOnce());
    const activating = activateLibrary(next);
    await vi.waitFor(() => expect(newRead).toHaveBeenCalledOnce());
    // Deliberately resolve both before yielding. The old load must not await a captured old active promise.
    releaseOld({ value: { ...dailySettingsDefaults, overviewMaterialMode: 'body', overviewMaxChars: 250 } });
    releaseNew({ value: { ...dailySettingsDefaults, overviewMaterialMode: 'summary', overviewMaxChars: 1700 } });
    await Promise.all([pending, activating]);
    expect(await activeLibrary()).toBe(next);
    expect(settings.overviewMaterialMode).toBe('summary'); expect(settings.overviewMaxChars).toBe(1700);
});
