import { describe, test, expect } from 'vitest';
import { fixture, observation } from './fixtures';
import { synchronize, capture, statuses, keepSummary, forkBranch } from './canonical';
import { STORES, type Revision, type MemoryRevision, type Branch, type Snapshot, type Block } from './model';
describe('canonical identity and immutable selections', () => {
    test('same text in different messages and stories is not identity', async () => {
        const { lib, input, view } = await fixture(2);
        input.messages.forEach(m => m.content = '完全相同');
        const b = await synchronize(lib, input);
        const a = await capture(lib, b.id);
        expect(new Set(a.refs.map(r => r.message)).size).toBe(4);
        const other = await synchronize(lib, { ...input, scope: 'other-chat' });
        const c = await capture(lib, other.id);
        expect(c.branch.story).not.toBe(a.branch.story);
        expect(c.refs.every(r => !a.refs.some(v => r.message === v.message))).toBe(true);
        expect(view.refs[0].message).toBe(a.refs[0].message);
        lib.close();
    });
    test('identical sync creates no duplicate canonical records', async () => {
        const { lib, input, branch } = await fixture();
        const before = await Promise.all(STORES.map(s => lib.all(s).then(r => r.length)));
        const result = await synchronize(lib, input);
        const after = await Promise.all(STORES.map(s => lib.all(s).then(r => r.length)));
        expect(after).toEqual(before);
        expect(result).toEqual(branch);
        lib.close();
    });
    test('editing an old floor archives a revision and requires review without rewriting provenance', async () => {
        const { lib, input, view } = await fixture();
        const original = view.memories[0];
        input.messages[1].content += '正文编辑';
        const branch = await synchronize(lib, input);
        const next = await capture(lib, branch.id);
        expect(next.refs[1].message).toBe(view.refs[1].message);
        expect(next.refs[1].revision).not.toBe(view.refs[1].revision);
        expect((await lib.get<Revision>('source_revisions', view.refs[1].revision))?.content).toBe(view.sources.get(view.refs[1].revision)?.content);
        expect((await statuses(lib, next)).get(original.id)).toBe('needs_review');
        expect(next.memories[0].inputRefs).toEqual([]);
        expect(next.memories[0].basis).toBe(original.basis);
        lib.close();
    });
    test('manual compatible review applies to one Head, not future edits', async () => {
        const { lib, input, view } = await fixture();
        input.messages[1].content += '修改';
        let b = await synchronize(lib, input);
        let v = await capture(lib, b.id);
        await keepSummary(lib, v, view.memories[0].id);
        v = await capture(lib, b.id);
        expect((await statuses(lib, v)).get(view.memories[0].id)).toBe('valid');
        input.messages[1].content += '再次修改';
        b = await synchronize(lib, input);
        v = await capture(lib, b.id);
        expect((await statuses(lib, v)).get(view.memories[0].id)).toBe('needs_review');
        lib.close();
    });
    test('swipe A B A reuses message and old revision but publishes a new Head', async () => {
        const { lib, input, view } = await fixture();
        const original = input.messages[1].content;
        input.messages[1].content = '第二页';
        input.messages[1].swipe = 1;
        let b = await synchronize(lib, input);
        let v = await capture(lib, b.id);
        expect(v.refs[1].message).toBe(view.refs[1].message);
        expect((await statuses(lib, v)).get(view.memories[0].id)).toBe('needs_review');
        input.messages[1].content = original;
        input.messages[1].swipe = 0;
        b = await synchronize(lib, input);
        v = await capture(lib, b.id);
        expect(v.refs[1]).toEqual(view.refs[1]);
        expect(v.snapshot.id).not.toBe(view.snapshot.id);
        expect((await statuses(lib, v)).get(view.memories[0].id)).toBe('valid');
        lib.close();
    });
    test('deletion hides current material but does not erase history', async () => {
        const { lib, input, view } = await fixture();
        const removed = view.refs[1];
        input.messages.splice(1, 1);
        input.memories.shift();
        const b = await synchronize(lib, input);
        const v = await capture(lib, b.id);
        expect(v.refs.some(r => r.message === removed.message)).toBe(false);
        expect(v.memories.some(m => m.id === view.memories[0].id)).toBe(false);
        expect(await lib.get('source_revisions', removed.revision)).toBeDefined();
        expect(await lib.get('memory_revisions', view.memories[0].id)).toBeDefined();
        lib.close();
    });
    test('cutoff rejects summaries declared beyond the prefix', async () => {
        const { lib, branch, view } = await fixture();
        const old = await capture(lib, branch.id, 4);
        const states = await statuses(lib, old);
        expect(states.get(view.memories[0].id)).toBe('valid');
        expect(states.get(view.memories[4].id)).toBe('out_of_scope');
        lib.close();
    });
    test('hierarchical memory replacement marks only actual dependents for rebuild', async () => {
        const { lib, input, branch } = await fixture(2);
        input.memories.push({ ...input.memories[0], hostId: 'L1', level: 1, children: ['leaf-0', 'leaf-1'], anchorKey: null, content: '合成高层摘要' });
        await synchronize(lib, input);
        input.memories[0].content = '替换后的摘要';
        await synchronize(lib, input);
        const v = await capture(lib, branch.id), states = await statuses(lib, v);
        expect(states.get(v.memories.find(m => m.hostId === 'L1')!.id)).toBe('needs_rebuild');
        expect(states.get(v.memories.find(m => m.hostId === 'leaf-1')!.id)).toBe('valid');
        lib.close();
    });
    test('same-content user append reuses full manifest blocks without copying historical bodies', async () => {
        const { lib } = await fixture(1);
        const input = observation(130, 'long');
        let b = await synchronize(lib, input);
        const v = await capture(lib, b.id);
        const count = (await lib.all('source_revisions')).length;
        input.messages.push({ key: 'new-message', role: 'user', content: '下一楼', swipe: 0 });
        b = await synchronize(lib, input);
        const next = await capture(lib, b.id);
        expect(next.snapshot.blocks.slice(0, 2)).toEqual(v.snapshot.blocks.slice(0, 2));
        expect((await lib.all('source_revisions')).length).toBe(count + 1);
        lib.close();
    });
    test('IDB transaction failure rolls back all associated stores', async () => {
        const { lib, branch } = await fixture();
        await expect(lib.transaction(['branches', 'library_meta'], 'readwrite', async (tx) => {
            await tx.put('branches', { ...branch, epoch: 999 } as Branch);
            await tx.add('library_meta', { id: 'fault', schema: 1 });
            throw new Error('injected save failure');
        })).rejects.toThrow('injected save failure');
        expect((await lib.get<Branch>('branches', branch.id))?.epoch).toBe(branch.epoch);
        expect(await lib.get('library_meta', 'fault')).toBeUndefined();
        lib.close();
    });
    test('duplicate host identities fail without silently matching content', async () => {
        const { lib, input } = await fixture();
        input.messages[1].key = input.messages[0].key;
        await expect(synchronize(lib, input)).rejects.toThrow('身份重复');
        lib.close();
    });
    test('private and explicitly disabled memories never become eligible', async () => {
        const { lib, input, branch } = await fixture();
        input.memories[0].private = true;
        input.memories[1].enabled = false;
        await synchronize(lib, input);
        const v = await capture(lib, branch.id), s = await statuses(lib, v);
        expect(s.get(v.memories[0].id)).toBe('excluded');
        expect(s.get(v.memories[1].id)).toBe('excluded');
        lib.close();
    });
    test('fork records a fixed source prefix independent of later parent edits', async () => {
        const { lib, input, branch } = await fixture();
        const parent = await capture(lib, branch.id, 4);
        const child = await forkBranch(lib, parent, 'fork');
        input.messages[1].content = '父线改写';
        await synchronize(lib, input);
        const v = await capture(lib, child.id);
        expect(v.refs).toEqual(parent.refs);
        expect(child.fork?.snapshot).toBe(parent.snapshot.id);
        expect(v.branch.story).toBe(branch.story);
        lib.close();
    });
});
