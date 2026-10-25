import { afterEach, expect, it, vi } from 'vitest';
import { apiSettings } from '@/api/settings';
import { classifyNpcPresence, createNpcPresenceClassifier, findCurrentSceneId, sceneId, sceneRelation } from './apply';
import { buildStateInjectionText } from './inject';
import { memory } from './store';
import { createEmptyMemory, type MemNpc, type MemScene, type NpcPresence } from './types';

const original = { summaryOnlyMode: apiSettings.summaryOnlyMode, injection: { ...apiSettings.injection } };
afterEach(() => {
  vi.unstubAllGlobals();
  apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  Object.assign(apiSettings.injection, original.injection);
  Object.assign(memory, createEmptyMemory());
});

function scene(...path: string[]): MemScene {
  return { id: sceneId(path), path, name: path.at(-1)!, parentId: path.length > 1 ? sceneId(path.slice(0, -1)) : '',
    createdAt: 0, updatedAt: 0 };
}
const npc = (location = '', follow = false): MemNpc => ({ id: `npc:${location}`, name: `人物${location}`,
  location, follow, createdAt: 0, updatedAt: 0 });

function countMaps<T>(run: () => T) {
  const OriginalMap = Map;
  let maps = 0, entries = 0;
  const sceneMaps = new Set<unknown>();
  let sceneEntries = 0;
  class CountedMap extends OriginalMap<unknown, unknown> {
    constructor(values?: Iterable<readonly [unknown, unknown]> | null) { super(values); maps++; }
    override set(key: unknown, value: unknown) {
      entries++;
      if (typeof key === 'string' && key.startsWith('scene:') && value && typeof value === 'object' && 'path' in value) {
        sceneMaps.add(this); sceneEntries++;
      }
      return super.set(key, value);
    }
  }
  vi.stubGlobal('Map', CountedMap);
  try { return { value: run(), maps, entries, sceneMaps: sceneMaps.size, sceneEntries }; }
  finally { vi.unstubAllGlobals(); }
}

// Retain the previous lookup shape only as a measured regression baseline.
function previousPresence(n: MemNpc, scenes: MemScene[], here: string, path?: string[]): NpcPresence {
  if (n.follow) return 'present';
  const fallback = () => n.location?.trim() && here.trim()
    && (n.location.trim().includes(here.trim()) || here.trim().includes(n.location.trim())) ? 'present' : 'absent';
  const current = scenes.find(s => s.id === findCurrentSceneId(scenes, here, path));
  if (!current) return fallback();
  const located = scenes.find(s => s.id === findCurrentSceneId(scenes, n.location ?? ''));
  if (!located) return fallback();
  const rel = sceneRelation(current.path, located.path);
  return rel === 'same' ? 'present' : rel === 'near' ? 'nearby' : 'absent';
}

it.each([50, 100])('shares one index for 10 NPCs and %i scenes instead of nested full-tree lookups', size => {
  const scenes = Array.from({ length: size }, (_, i) => scene(`地点${String(i).padStart(3, '0')}终`));
  const here = scenes.at(-1)!;
  const npcs = Array.from({ length: 10 }, () => npc(here.name));
  const before = countMaps(() => npcs.map(n => previousPresence(n, scenes, here.name, here.path)));
  const after = countMaps(() => npcs.map(createNpcPresenceClassifier(scenes, here.name, here.path)));
  expect(after.value).toEqual(before.value);
  expect(after.value).toEqual(Array(10).fill('present'));
  expect({ maps: before.maps, entries: before.entries }).toEqual({ maps: 20 * size, entries: 20 * size * size });
  expect({ maps: after.maps, entries: after.entries }).toEqual({ maps: 1, entries: size });
});

it('preserves path priority, prefix fallback, tie order, nearby boundaries and unknown-location fallback', () => {
  const scenes = [scene('城'), scene('城', '东楼'), scene('城', '东楼', '房间'), scene('城', '东楼', '厨房'),
    scene('城', '西楼'), scene('城', '西楼', '房间')];
  const classify = createNpcPresenceClassifier(scenes, '房间', ['城', '西楼', '房间', '不存在的床边']);
  expect(classify(npc('房间'))).toBe('absent'); // 同深度同名时仍采用数组中的第一个东楼节点。
  expect(classify(npc('城西楼房间'))).toBe('absent'); // 保留模糊匹配同深度首命中的旧规则。
  const east = createNpcPresenceClassifier(scenes, '房间', ['城', '东楼', '房间']);
  expect(['房间', '厨房', '西楼'].map(place => east(npc(place))))
    .toEqual(['present', 'nearby', 'absent']);
  expect(east(npc('', true))).toBe('present');
  expect(east(npc())).toBe('absent');
  expect(createNpcPresenceClassifier([], '森林营地')(npc('营地'))).toBe('present');
  expect(createNpcPresenceClassifier(scenes, '未知荒野')(npc('未知荒野'))).toBe('present');
  for (const here of ['', '房间', '城西楼房间', '未知荒野']) {
    for (const path of [undefined, ['城', '西楼', '房间'], ['缺失地点']]) {
      const batch = createNpcPresenceClassifier(scenes, here, path);
      for (const n of [npc(), npc('房间'), npc('厨房'), npc('城'), npc('陌生位置'), npc('', true)]) {
        expect(batch(n)).toBe(previousPresence(n, scenes, here, path));
        expect(classifyNpcPresence(n, scenes, here, path)).toBe(batch(n));
      }
    }
  }
});

it('rebuilds each batch after in-place scene/location changes and preserves first duplicate-id resolution', () => {
  const scenes = [scene('城', '房间'), { ...scene('城', '房间'), path: ['其他', '房间'] }, scene('城', '厨房')];
  expect(createNpcPresenceClassifier(scenes, '房间', ['城', '房间'])(npc('房间'))).toBe('present');
  const atKitchen = npc('厨房');
  expect(createNpcPresenceClassifier(scenes, '房间', ['城', '房间'])(atKitchen)).toBe('nearby');
  scenes[2].path = ['别城', '另一楼', '厨房'];
  expect(createNpcPresenceClassifier(scenes, '房间', ['城', '房间'])(atKitchen)).toBe('absent');
  expect(createNpcPresenceClassifier(scenes, '厨房', ['别城', '另一楼', '厨房'])(atKitchen)).toBe('present');
});

it('uses one shared NPC index in the real state-injection batch', () => {
  Object.assign(memory, createEmptyMemory());
  apiSettings.summaryOnlyMode = false;
  Object.assign(apiSettings.injection, { scenes: true, npcs: true, items: false });
  memory.scenes = Array.from({ length: 50 }, (_, i) => scene(`地点${String(i).padStart(3, '0')}终`));
  memory.state.location = memory.scenes.at(-1)!.name;
  memory.state.locationPath = memory.scenes.at(-1)!.path;
  const withoutNpcs = countMaps(buildStateInjectionText);
  memory.npcs = Array.from({ length: 10 }, (_, i) => ({ ...npc(memory.state.location), id: `npc:${i}`, name: `角色${i}` }));
  const withNpcs = countMaps(buildStateInjectionText);
  expect(withNpcs.sceneMaps - withoutNpcs.sceneMaps).toBe(1);
  expect(withNpcs.sceneEntries - withoutNpcs.sceneEntries).toBe(50);
  for (const n of memory.npcs) expect(withNpcs.value).toContain(n.name);
});
