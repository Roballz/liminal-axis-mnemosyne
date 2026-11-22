import { expect, test } from 'vitest';
import { fixture } from './fixtures';
import { capture, forkBranch, keepSummary, statuses, synchronize } from './canonical';
import { confirmRoleRepairs, previewRoleRepairs } from './source-role-repair';
import { exportLibrary, restoreLibrary } from './migration';
import type { Review } from './model';

test.each(['leaf', 'high'] as const)('a parent-confirmed coverage-only role repair remains valid on inherited %s evidence', async target => {
    const { lib, input, branch } = await fixture(2);
    try {
        input.messages[1].role = 'system';
        input.memories[0].content = '使用旧角色来源生成的摘要';
        await synchronize(lib, input);
        const old = await capture(lib, branch.id);
        // Inputs and claimed coverage are distinct provenance fields. This leaf
        // covers the repaired assistant while its explicit input is unaffected.
        if (target === 'leaf') {
            input.memories[0].inputRefs = [old.refs[0]];
            input.memories[0].coverage = old.refs.slice(0, 2);
            input.memories[0].basisSnapshot = old.snapshot.id;
        }
        input.memories.push({ hostId: 'high', content: '依赖已确认叶子的上层总结', level: 1,
            anchorKey: null, children: ['leaf-0'], storyTime: '', seed: false, enabled: true,
            ...(target === 'high' ? { coverage: old.refs.slice(0, 2), basisSnapshot: old.snapshot.id } : {}) });
        await synchronize(lib, input);
        input.messages[1].role = 'assistant';
        await synchronize(lib, input);
        let parent = await capture(lib, branch.id);
        const repair = await previewRoleRepairs(lib, parent, [parent.refs[1]]);
        expect(repair).toHaveLength(1);
        await confirmRoleRepairs(lib, parent, repair, () => true);
        parent = await capture(lib, branch.id);
        expect([...await statuses(lib, parent)].every(([, state]) => state === 'valid')).toBe(true);

        const child = await forkBranch(lib, parent, 'coverage-role-child');
        const copied = await capture(lib, child.id);
        expect(copied.branch.sourceRoleRepairs).toBeUndefined();
        expect([...await statuses(lib, copied)].every(([, state]) => state === 'valid')).toBe(true);
        await synchronize(lib, { ...input, scope: 'coverage-role-child' });
        expect([...await statuses(lib, await capture(lib, child.id))].every(([, state]) => state === 'valid')).toBe(true);
        const restored = await restoreLibrary(await exportLibrary(lib), false);
        try {
            expect([...await statuses(restored, await capture(restored, child.id))].every(([, state]) => state === 'valid')).toBe(true);
        } finally { restored.close(); }

        input.messages[1].content += '真实正文改写';
        await synchronize(lib, { ...input, scope: 'coverage-role-child' });
        const edited = await capture(lib, child.id), current = await statuses(lib, edited);
        expect(current.get(edited.memories.find(m => m.hostId === 'leaf-0')!.id)).toBe('needs_review');
        expect(current.get(edited.memories.find(m => m.hostId === 'high')!.id)).toBe('needs_review');
        expect([...await statuses(lib, await capture(lib, branch.id))].every(([, state]) => state === 'valid')).toBe(true);
    } finally { lib.close(); }
});

test('a copied legacy approval survives host swipe-number normalization when every source identity and body is unchanged', async () => {
    const { lib, input, branch } = await fixture(1);
    try {
        input.memories.push({ hostId: 'high', content: '依赖人工保留叶子的总结', level: 1,
            anchorKey: null, children: ['leaf-0'], storyTime: '', seed: false, enabled: true });
        await synchronize(lib, input);
        let parent = await capture(lib, branch.id);
        const leaf = parent.memories.find(m => m.level === 0)!;
        input.messages[1].content = '父分支人工确认可继续使用旧摘要的正文';
        input.messages[1].swipe = 2;
        await synchronize(lib, input);
        await keepSummary(lib, await capture(lib, branch.id), leaf.id);
        // A still-supported old package has an explicit snapshot-bound approval.
        await lib.transaction(['reviews'], 'readwrite', async tx => {
            for (const review of await tx.all<Review>('reviews', 'branch', branch.id)) {
                const { reviewSchema, sourceRefs, coverage, dependencies, ...legacy } = review;
                await tx.put('reviews', legacy);
            }
        });
        parent = await capture(lib, branch.id);
        expect([...await statuses(lib, parent)].every(([, state]) => state === 'valid')).toBe(true);
        const child = await forkBranch(lib, parent, 'legacy-swipe-child');
        const copied = await capture(lib, child.id);
        expect([...await statuses(lib, copied)].every(([, state]) => state === 'valid')).toBe(true);
        input.messages[1].swipe = 0;
        await synchronize(lib, { ...input, scope: 'legacy-swipe-child' });
        const normalized = await capture(lib, child.id);
        expect(normalized.refs).toEqual(copied.refs);
        expect(normalized.snapshot.id).not.toBe(copied.snapshot.id);
        expect([...await statuses(lib, normalized)].every(([, state]) => state === 'valid')).toBe(true);
        const inheritedReviews = await lib.all<Review>('reviews', 'branch', child.id);
        expect(inheritedReviews).toMatchObject([{ reviewSchema: 2, sourceRefs: parent.refs }]);
        const restored = await restoreLibrary(await exportLibrary(lib), false);
        try {
            expect([...await statuses(restored, await capture(restored, child.id))].every(([, state]) => state === 'valid')).toBe(true);
        } finally { restored.close(); }
        input.messages[1].content += '后来的真实改写';
        await synchronize(lib, { ...input, scope: 'legacy-swipe-child' });
        expect([...await statuses(lib, await capture(lib, child.id))].every(([, state]) => state === 'needs_review')).toBe(true);
        expect([...await statuses(lib, await capture(lib, branch.id))].every(([, state]) => state === 'valid')).toBe(true);
    } finally { lib.close(); }
});

test('a replaced own message identity cannot be inherited as an unchanged legacy summary', async () => {
    const { lib, input, branch } = await fixture(1);
    try {
        input.messages[0].key = 'different-message-with-identical-text';
        input.messages[1].swipe = 2;
        await synchronize(lib, input);
        const parent = await capture(lib, branch.id);
        expect(parent.memories).toEqual([]);
        const child = await forkBranch(lib, parent, 'legacy-changed-identity');
        const reviews = await lib.all<Review>('reviews', 'branch', child.id);
        expect(reviews).toEqual([]);
        expect((await capture(lib, child.id)).memories).toEqual([]);
        await exportLibrary(lib);
    } finally { lib.close(); }
});
