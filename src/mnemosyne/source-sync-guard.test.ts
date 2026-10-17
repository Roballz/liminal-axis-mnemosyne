import { expect, test } from 'vitest';
import { fixture } from './fixtures';
import { sourceSyncBaseline } from './source-sync-guard';
import { synchronize } from './canonical';

test('no-loss preflight still rejects a concurrently advanced head inside the write transaction', async () => {
    const { lib, input } = await fixture(2);
    const token = (await sourceSyncBaseline(lib, input))!;
    const advanced = structuredClone(input);
    advanced.messages.push({ key: 'new', role: 'user', content: '并发追加', swipe: 0 });
    const branch = await synchronize(lib, advanced);
    await expect(synchronize(lib, input, { ...token, isCurrent: () => true })).rejects.toThrow('校验后档案');
    expect((await lib.get<any>('branches', branch.id)).head).toBe(branch.head); lib.close();
});

test('rebound binding and late host invalidation abort deletion transaction without losing text', async () => {
    const { lib, input, branch } = await fixture(2);
    input.messages.pop(); input.memories.pop();
    const token = (await sourceSyncBaseline(lib, input))!;
    await lib.transaction(['host_bindings'], 'readwrite', async tx => {
        const changed = { ...token.binding, generation: token.binding.generation + 1 };
        await tx.put('host_bindings', changed);
    });
    await expect(synchronize(lib, input, { ...token, isCurrent: () => true })).rejects.toThrow('绑定已变化');
    const fresh = (await sourceSyncBaseline(lib, input))!;
    let checks = 0;
    await expect(synchronize(lib, input, { ...fresh, isCurrent: () => ++checks === 1 })).rejects.toThrow('事务回滚');
    expect((await lib.get<any>('branches', branch.id)).head).toBe(branch.head);
    expect(await lib.all('source_bodies')).toHaveLength(4); lib.close();
});

test('shortened edits and alternate swipes retain identity checks without a protection decision', async () => {
    const { lib, input } = await fixture(2);
    const original = await sourceSyncBaseline(lib, input);
    input.messages[1].content = '短';
    expect(await sourceSyncBaseline(lib, input)).toEqual(original);
    input.messages[1].swipe = 1;
    expect(await sourceSyncBaseline(lib, input)).toEqual(original);
    expect(original).not.toHaveProperty('needsProtection'); lib.close();
});
