import { expect, test } from 'vitest';
import type { MemSummary } from '@/memory/types';
import type { MemoryRevision } from './model';
import { unarchivedHigherSummaryRows } from './unarchived-higher-summaries';

test('only persistent, unselected structural summaries enter the unarchived review queue', () => {
    const summary = (id: string, changes: Partial<MemSummary> = {}): MemSummary => ({ id, level: 1,
        text: id + ' 的原文', childIds: ['leaf'], createdAt: 1, auto: false, ...changes });
    const summaries = [summary('selected'), summary('retired-L1'), summary('retired-L2', { level: 2, childIds: ['retired-L1'] }),
        summary('atomic', { imported: true, childIds: [] }), summary('missing-source', { childIds: [] })];
    const view = { memories: [{ hostId: 'selected' } as MemoryRevision] };
    const before = JSON.stringify(summaries);
    expect(unarchivedHigherSummaryRows(view, summaries)).toEqual([
        { id: 'retired-L1', level: 1, text: 'retired-L1 的原文' }, { id: 'retired-L2', level: 2, text: 'retired-L2 的原文' },
    ]);
    expect(JSON.stringify(summaries)).toBe(before);
    view.memories.push({ hostId: 'retired-L1' } as MemoryRevision);
    expect(unarchivedHigherSummaryRows(view, summaries).map(row => row.id)).toEqual(['retired-L2']);
});
