import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { Library, freshLibraryName } from './db';
import { capture, forkBranch, statuses, synchronize, type HostObservation } from './canonical';
import { observation } from './fixtures';
import { applyRows, newTable, readTables, saveTable } from './tables';
import { fingerprint, type Block, type Revision, type Snapshot, type SourceBody, type TableDef } from './model';

function bodyOnly(count: number, width: number, scope = 'body-only'): HostObservation {
    return { scope, memories: [], messages: Array.from({ length: count }, (_, i) => ({
        key: `floor-${i}`, role: i % 2 ? 'assistant' : 'user', swipe: 0,
        content: `合成原文 ${i}：${'正文🙂'.repeat(width)}`,
    })) };
}
async function size(lib: Library) {
    const bodies = await lib.all<SourceBody>('source_bodies');
    const revisions = await lib.all<Revision>('source_revisions');
    const snapshots = await lib.all<Snapshot>('history_snapshots');
    const blocks = await lib.all<Block>('manifest_blocks');
    return {
        bodies: bodies.length,
        characters: bodies.reduce((n, b) => n + b.content.length, 0),
        revisions: revisions.length, snapshots: snapshots.length, blocks: blocks.length,
        tables: (await lib.all('table_history')).length,
        variants: snapshots.reduce((n, s) => n + (s.variants?.length ?? 0), 0) +
            blocks.reduce((n, b) => n + (b.variants?.length ?? 0), 0),
    };
}
async function textAt(lib: Library, branch: string, index = 1) {
    const view = await capture(lib, branch);
    return view.sources.get(view.refs[index].revision)!.content;
}
async function writeTable(lib: Library, branch: string, value: string) {
    let view = await capture(lib, branch);
    const def = newTable(view, '合成状态');
    def.columns = [{ id: 'v', name: '状态', type: 'text', description: '', mode: 'replace' }];
    await saveTable(lib, view, def);
    view = await capture(lib, branch);
    await applyRows(lib, view, (await lib.get<TableDef>('custom_table_defs', def.id))!,
        [{ row_id: null, values: { v: value } }], false);
}

describe('current source body retention', () => {
    test.each([{ floors: 4, width: 4096 }, { floors: 130, width: 64 }])(
        'bounds 1,000 edits and 1,000 swipes before and after a table rollback: $floors floors',
        async ({ floors, width }) => {
            const lib = await Library.open(freshLibraryName());
            const input = bodyOnly(floors, width), base = input.messages[1].content;
            try {
                const branch = await synchronize(lib, input);
                for (const phase of ['plain', 'after-table-rollback']) {
                    if (phase === 'after-table-rollback') await writeTable(lib, branch.id, '历史人工值');
                    input.messages[1].content = `${base}:${phase}:0000`;
                    input.messages[1].swipe = 0;
                    await synchronize(lib, input);
                    // The rollback witness may initially be the live head; separate it once before measuring.
                    input.messages[1].content = `${base}:${phase}:warm`;
                    await synchronize(lib, input);
                    const before = await size(lib);
                    for (let i = 1; i <= 1000; i++) {
                        input.messages[1].content = `${base}:${phase}:${String(i).padStart(4, '0')}`;
                        await synchronize(lib, input);
                    }
                    const edited = await size(lib);
                    expect(edited).toEqual(before);
                    for (let i = 1; i <= 1000; i++) {
                        input.messages[1].swipe = i % 2;
                        await synchronize(lib, input);
                    }
                    const swiped = await size(lib);
                    expect(swiped).toEqual(edited);
                    expect(swiped.bodies).toBe(floors);
                    expect(swiped.characters).toBe(input.messages.reduce((n, m) => n + m.content.length, 0));
                    expect(swiped.revisions).toBeLessThanOrEqual(floors + 4);
                    expect(swiped.snapshots).toBeLessThanOrEqual(5);
                    expect(swiped.blocks).toBeLessThanOrEqual(Math.ceil(floors / 128) + 4);
                    expect(swiped.variants).toBeLessThanOrEqual(floors + 4 * 128);
                    expect(swiped.tables).toBeLessThanOrEqual(4);
                    expect(await textAt(lib, branch.id)).toBe(input.messages[1].content);
                    if (phase === 'after-table-rollback') {
                        expect(await readTables(lib, (await capture(lib, branch.id)).branch)).toEqual([]);
                    }
                    console.info('current-body retention measurement', { floors, phase, edits: 1000, swipes: 1000, ...swiped });
                }
                for (const snapshot of await lib.all<Snapshot>('history_snapshots')) {
                    expect(snapshot).toMatchObject({ snapshotSchema: 2, previous: null });
                    expect(snapshot.variants).toBeUndefined();
                }
                for (const descriptor of await lib.all<Revision>('source_revisions')) {
                    expect(descriptor.bodySchema).toBe(1);
                    expect(descriptor.content).toBeUndefined();
                }
            } finally { lib.close(); }
        }, 300000,
    );

    test.each(['parent', 'child'] as const)('preserves the other branch body when %s first creates a shared revision', async creator => {
        const lib = await Library.open(freshLibraryName());
        const parentInput = bodyOnly(4, 64, 'parent');
        try {
            const parent = await synchronize(lib, parentInput);
            const child = await forkBranch(lib, await capture(lib, parent.id), 'child');
            const childInput = structuredClone(parentInput); childInput.scope = 'child';
            const [first, second] = creator === 'parent' ? [parentInput, childInput] : [childInput, parentInput];
            const firstBranch = creator === 'parent' ? parent : child;
            const secondBranch = creator === 'parent' ? child : parent;
            const original = parentInput.messages[1].content;
            first.messages[1].content = '共享的新正文🙂';
            await synchronize(lib, first);
            expect(await textAt(lib, secondBranch.id)).toBe(original);
            second.messages[1].content = first.messages[1].content;
            await synchronize(lib, second);
            const firstView = await capture(lib, firstBranch.id), secondView = await capture(lib, secondBranch.id);
            expect(firstView.refs[1]).toEqual(secondView.refs[1]);
            const shared = firstView.refs[1].revision;
            first.messages[1].content = '仅创建分支再次修改';
            await synchronize(lib, first);
            expect(await textAt(lib, secondBranch.id)).toBe('共享的新正文🙂');
            expect((await lib.get<SourceBody>('source_bodies', shared))?.content).toBe('共享的新正文🙂');
            second.messages[1].content = '另一分支独立修改';
            await synchronize(lib, second);
            expect(await textAt(lib, firstBranch.id)).toBe('仅创建分支再次修改');
            expect(await textAt(lib, secondBranch.id)).toBe('另一分支独立修改');
            expect(await lib.get('source_bodies', shared)).toBeUndefined();
        } finally { lib.close(); }
    });

    test('delete and regrow rehydrates exact content without keeping deleted payload', async () => {
        const lib = await Library.open(freshLibraryName());
        const input = bodyOnly(4, 64);
        try {
            const branch = await synchronize(lib, input), old = await capture(lib, branch.id);
            const removed = input.messages.pop()!, ref = old.refs.at(-1)!;
            await synchronize(lib, input);
            expect(await lib.get('source_bodies', ref.revision)).toBeUndefined();
            expect((await capture(lib, branch.id)).refs).toHaveLength(3);
            input.messages.push(removed);
            await synchronize(lib, input);
            const regrown = await capture(lib, branch.id);
            expect(regrown.refs.at(-1)).toEqual(ref);
            expect(regrown.sources.get(ref.revision)?.content).toBe(removed.content);
            expect((await size(lib)).bodies).toBe(4);
            expect((await lib.get<Revision>('source_revisions', ref.revision))?.bodyHash).toBe(await fingerprint(removed.content));
        } finally { lib.close(); }
    });

    test('summary and table evidence retain descriptors; old capture never substitutes the current body', async () => {
        const lib = await Library.open(freshLibraryName());
        const input = observation(1);
        try {
            const branch = await synchronize(lib, input), old = await capture(lib, branch.id);
            await writeTable(lib, branch.id, 'A 的表格状态');
            const original = input.messages[1].content;
            input.messages[1].content = 'B 的正文'; input.messages[1].swipe = 1;
            await synchronize(lib, input);
            let current = await capture(lib, branch.id);
            expect((await statuses(lib, current)).get(old.memories[0].id)).toBe('needs_review');
            expect(await lib.get('history_snapshots', old.snapshot.id)).toBeDefined();
            const evidence = await lib.get<Revision>('source_revisions', old.refs[1].revision);
            expect(evidence).toMatchObject({ bodySchema: 1, bodyLength: original.length, bodyHash: await fingerprint(original) });
            expect(evidence?.content).toBeUndefined();
            expect(await lib.get('source_bodies', old.refs[1].revision)).toBeUndefined();
            await expect(capture(lib, branch.id, undefined, old.snapshot.id)).rejects.toThrow('正文未保留');
            expect(await textAt(lib, branch.id)).toBe('B 的正文');
            expect(await readTables(lib, current.branch)).toEqual([]);
            input.messages[1].content = original; input.messages[1].swipe = 0;
            await synchronize(lib, input);
            current = await capture(lib, branch.id);
            expect(current.refs[1]).toEqual(old.refs[1]);
            expect((await statuses(lib, current)).get(old.memories[0].id)).toBe('valid');
            expect(current.sources.get(old.refs[1].revision)?.content).toBe(original);
            // Returning to A restores source validity, not abandoned business state.
            expect(await readTables(lib, current.branch)).toEqual([]);
            expect((await lib.all('table_history')).length).toBeLessThanOrEqual(4);
        } finally { lib.close(); }
    });
});
