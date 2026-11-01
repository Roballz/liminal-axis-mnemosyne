import { describe, expect, it } from 'vitest';
import { collectAutoSummaryRoots, selectAutoSummaryBatch, type AutoSummaryLeaf } from './auto-resummary';
import type { MemSummary } from './types';

const leaves = (floors: number[]): AutoSummaryLeaf[] => floors.map(floor => ({
  id: `leaf-${floor}`, text: `Floor ${floor}`, createdAt: floor, floor,
}));
const comp = (id: string, childIds: string[], overrides: Partial<MemSummary> = {}): MemSummary => ({
  id, text: id, level: 1, createdAt: 0, auto: true, childIds, ...overrides,
});

describe('automatic summary coverage', () => {
  it('keeps old cross-gap summaries and overlapping retained roots out of new automatic batches', () => {
    const roots = collectAutoSummaryRoots(leaves([1, 3, 5, 7]), [
      comp('old-gap', ['leaf-1', 'leaf-5']), comp('next', ['leaf-7']),
    ], [1, 3, 5, 7]);
    expect(roots.map(n => [n.id, n.contiguous])).toEqual([
      ['old-gap', false], ['leaf-3', false], ['next', true],
    ]);
    expect(selectAutoSummaryBatch(roots, 1, 2)).toEqual([]);
  });

  it.each(['missing', 'duplicate', 'empty', 'cycle'])('rejects %s child coverage without discarding source nodes', kind => {
    const childIds = { missing: ['leaf-1', 'gone'], duplicate: ['leaf-1', 'leaf-1', 'leaf-5'],
      empty: [], cycle: ['leaf-1', 'bad'] }[kind]!;
    const summaries = [comp('bad', childIds), comp('next', ['leaf-7'])];
    const before = JSON.stringify(summaries);
    const roots = collectAutoSummaryRoots(leaves([1, 3, 5, 7]), summaries, [1, 3, 5, 7]);
    expect(selectAutoSummaryBatch(roots, 1, 2)).toEqual([]);
    expect(roots.find(n => n.id === 'next')?.contiguous).toBe(true);
    expect(JSON.stringify(summaries)).toBe(before);
  });

  it('accepts explicit adjacent imported ranges and checks their ancestors with the same coverage rules', () => {
    const imported = [comp('first', [], { imported: true, importedFloorStart: 0, importedFloorEnd: 3 }),
      comp('second', [], { imported: true, importedFloorStart: 4, importedFloorEnd: 7 })];
    const roots = collectAutoSummaryRoots([], imported, [1, 3, 5, 7]);
    expect(selectAutoSummaryBatch(roots, 1, 2).map(n => n.id)).toEqual(['first', 'second']);
    const parent = collectAutoSummaryRoots([], [...imported, comp('parent', ['second', 'first'], { level: 2 })], [1, 3, 5, 7]);
    expect(parent).toMatchObject([{ id: 'parent', floorLo: 0, floorHi: 7, contiguous: true }]);
  });

  it('does not turn unknown or out-of-chat imported ranges into continuous inputs', () => {
    const roots = collectAutoSummaryRoots([], [comp('future', [], {
      imported: true, importedFloorStart: 0, importedFloorEnd: 99,
    }), comp('unknown', [])], [1, 3]);
    expect(roots.every(n => !n.contiguous)).toBe(true);
    expect(selectAutoSummaryBatch(roots, 1, 2)).toEqual([]);
  });

  it('visits child references linearly through a deep forest instead of re-expanding each ancestor', () => {
    const floors = Array.from({ length: 512 }, (_, i) => i * 2 + 1);
    const inputs = leaves(floors), summaries: MemSummary[] = [];
    let ids = inputs.map(n => n.id), level = 0, reads = 0, references = 0;
    while (ids.length > 1) {
      level += 1;
      const next: string[] = [];
      for (let i = 0; i < ids.length; i += 2) {
        const id = `L${level}-${i}`;
        const children = new Proxy(ids.slice(i, i + 2), {
          get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
            return Reflect.get(target, property, receiver);
          },
        });
        references += children.length;
        summaries.push(comp(id, children, { level }));
        next.push(id);
      }
      ids = next;
    }
    const roots = collectAutoSummaryRoots(inputs, summaries, floors);
    expect(roots).toMatchObject([{ level: 9, firstAi: 0, lastAi: 511, contiguous: true }]);
    expect(reads).toBeLessThanOrEqual(references * 3);
  });
});
