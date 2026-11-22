import { test, expect } from 'vitest';
import type { MemSummary } from '@/memory/types';
import { higherRevisionSteps } from './summary-edit-plan';

const summary = (id: string, level: number, childIds: string[]): MemSummary =>
    ({ id, level, childIds, text: id, createdAt: 1, auto: false });

test('only structural ancestors enter the queue, lower levels first with stable sibling order', () => {
    const summaries = [summary('l2', 2, ['l1-a', 'l1-b']), summary('unrelated', 1, ['other']),
        summary('l1-a', 1, ['leaf']), summary('l1-b', 1, ['leaf']), summary('l3', 3, ['l2'])];
    const steps = higherRevisionSteps(summaries, 'leaf', new Map([['leaf', 601], ['other', 1283]]));
    expect(steps.map(step => step.hostId)).toEqual(['l1-a', 'l1-b', 'l2', 'l3']);
    expect(steps.every(step => step.label.includes('#601'))).toBe(true);
    expect(higherRevisionSteps(summaries, 'l2', new Map()).map(step => step.hostId)).toEqual(['l3']);
    expect(higherRevisionSteps(summaries, 'l3', new Map())).toEqual([]);
});

test('invalid self and same-level edges cannot send the editor back to its source', () => {
    const summaries = [summary('l1', 1, ['leaf', 'l1']), summary('l2', 2, ['l1', 'peer']),
        summary('peer', 2, ['l2'])];
    expect(higherRevisionSteps(summaries, 'leaf', new Map()).map(step => step.hostId)).toEqual(['l1', 'l2']);
});

test('a long ancestor chain is traversed without recursion or duplicate steps', () => {
    const summaries = Array.from({ length: 2000 }, (_, i) => summary('s' + i, i + 1, [i ? 's' + (i - 1) : 'leaf']));
    const steps = higherRevisionSteps(summaries, 'leaf', new Map([['leaf', 1]]));
    expect(steps).toHaveLength(2000);
    expect(steps.at(-1)).toMatchObject({ hostId: 's1999', level: 2000, label: 'L2000 总结 · #1 楼' });
});
