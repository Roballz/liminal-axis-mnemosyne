import { test, expect, vi } from 'vitest';
import { fixture } from './fixtures';
import { ForkEvidenceIndex } from './fork-evidence';
import * as payloads from './shared-payloads';

test('digest collisions never merge different generation evidence, sources, or branches', async () => {
    const f = await fixture(1);
    const hash = vi.spyOn(payloads, 'payloadKey').mockReturnValue('collision');
    try {
        await f.lib.transaction(['memory_revisions'], 'readonly', async tx => {
            const memory = f.view.memories[0], index = new ForkEvidenceIndex(tx);
            index.remember(memory);
            expect((await index.equivalent({...memory,id:'other-id',owner:'other-family'}))?.id).toBe(memory.id);
            for (const changed of [
                {...memory,declaration:'different declaration'},
                {...memory,basis:'different snapshot'},
                {...memory,inputRefs:[...memory.inputRefs, f.view.refs[0]]},
                {...memory,branch:'different branch'},
                {...memory,content:memory.content+' changed'},
            ]) expect(await index.equivalent(changed)).toBeUndefined();
        });
    } finally { hash.mockRestore(); f.lib.close(); }
});
