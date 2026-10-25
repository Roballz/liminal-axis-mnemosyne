import { afterEach, expect, test, vi } from 'vitest';
import * as canonical from './canonical';
import * as events from './events';
import { previewEventResync } from './event-resync';
import { fixture } from './fixtures';
import { Library, Transaction } from './db';
import { compatibleTableHead } from './table-history';
import { STORES, row, type Branch, type CapturedView, type EventChain, type EventRevision,
    type Membership, type MemoryRevision, type TableCommit } from './model';

afterEach(() => vi.restoreAllMocks());

/** Controlled projection inputs isolate matching work; integration fixtures below
 * and the fork/resync suites continue to check real stored source/cutoff evidence. */
function matchingFixture(count: number) {
    let textReads = 0;
    const refs = [{ message: 'message', revision: 'source' }];
    const makeView = (branch: string): CapturedView => ({
        branch: { ...row('branch'), id: branch, story: 'story', head: `${branch}-snapshot`, view: `${branch}-view`, epoch: 1,
            fork: branch === 'child' ? { branch: 'parent', snapshot: 'parent-snapshot', length: 1, anchor: refs[0] } : null },
        snapshot: { ...row('snapshot'), id: `${branch}-snapshot`, story: 'story', branch, blocks: [], previous: null,
            length: 1, created: 1, variants: [0] }, refs,
        selection: { ...row('view'), branch, selections: {} }, sources: new Map(), cutoff: 1,
        memories: Array.from({ length: count }, (_, index): MemoryRevision => ({
            ...row('memory'), id: `${branch}-${index}`, story: 'story', branch, owner: `${branch}-family-${index}`,
            hostId: `host-${index}`, get content() { textReads++; return `text-${index}`; }, fingerprint: '',
            basis: `${branch}-snapshot`, inputRefs: refs, coverage: [], dependencies: [], declaration: null,
            level: 0, anchor: 'message', storyTime: '', recall: true, visibility: 'public', seed: false,
        })),
    });
    const parent = makeView('parent'), child = makeView('child');
    const parentCards: events.EventCard[] = [], childChains: EventChain[] = [];
    const childRows = new Map<string, { revisions: EventRevision[]; memberships: Membership[]; progress: [] }>();
    const revisions = new Map([...parent.memories, ...child.memories].map(memory => [memory.id, memory]));
    const get = vi.fn(async (_store: string, id: string) => revisions.get(id));
    const tx = { get, all: async (store: string, _index: string, owner: string) => {
        const values = childRows.get(owner);
        return store === 'event_revisions' ? values?.revisions ?? [] : store === 'event_memberships' ? values?.memberships ?? [] : [];
    } };
    const lib = { transaction: async (_stores: unknown, _mode: unknown, fn: (tx: unknown) => unknown) => fn(tx),
        all: async (_store: unknown, _index: unknown, branch: string) => branch === 'parent' ? parentCards.map(card => card.chain) : childChains,
    } as unknown as Library;
    vi.spyOn(canonical, 'capture').mockResolvedValue(parent);
    vi.spyOn(canonical, 'current').mockResolvedValue(true);
    vi.spyOn(canonical, 'summarySources').mockImplementation(async (_tx, memory) => memory.inputRefs);
    vi.spyOn(canonical, 'statuses').mockImplementation(async () => new Map(child.memories.map(memory => [memory.id, 'valid'])));
    vi.spyOn(events, 'eventView').mockImplementation(async () => ({ cards: parentCards, valid: parent.memories,
        validity: new Map(parent.memories.map(memory => [memory.id, 'valid'])), storedCount: parentCards.length }));
    const addCard = (id: string, blocked = false) => {
        const chain: EventChain = { ...row('event'), id, story: 'story', branch: 'parent', created: 10 };
        const meta: EventRevision = { ...row('revision'), story: 'story', branch: 'parent', owner: id,
            title: 'same title', status: 'open', keywords: [], snapshot: 'parent-snapshot', cutoff: 1, epoch: 1,
            created: 20, refs: ['parent-0'], overview: '' };
        const card: events.EventCard = { chain, meta, members: [], progress: [], blocked,
            history: { revisions: [meta, { ...meta, id: 'same-signature' }], memberships: [], progress: [] }, inheritanceKey: 'new' };
        parentCards.push(card); return card;
    };
    const addChild = (card: events.EventCard, id = 'legacy') => {
        const chain: EventChain = { ...card.chain, id, branch: 'child' };
        childChains.push(chain); childRows.set(id, { revisions: [{ ...card.meta, id: `${id}-revision`, owner: id, branch: 'child' }], memberships: [], progress: [] });
        return chain;
    };
    return { parent, child, lib, revisions, parentCards, childRows, get, addCard, addChild, textReads: () => textReads };
}

test('1000 resync candidates encode each exact narrative signature once', async () => {
    const data = matchingFixture(1000);
    const plan = await previewEventResync(data.lib, data.child);
    expect(plan.ids.size).toBe(1000);
    expect(data.textReads()).toBe(2000);
});

test('a missing bottom mapping cascades through a reverse-ordered dependency chain with one revision read each', async () => {
    const data = matchingFixture(200);
    for (let i = 1; i < 200; i++) {
        data.parent.memories[i].dependencies = [`parent-${i - 1}`];
        data.child.memories[i].dependencies = [`child-${i - 1}`];
    }
    Object.defineProperty(data.child.memories[0], 'content', { value: 'changed bottom' });
    data.parent.memories.reverse(); data.child.memories.reverse();
    const plan = await previewEventResync(data.lib, data.child);
    expect(plan.ids.size).toBe(0);
    expect(data.get).toHaveBeenCalledTimes(398);
});

test('duplicate child narratives remain ambiguous before source comparisons', async () => {
    const data = matchingFixture(1), duplicate = { ...data.child.memories[0], id: 'duplicate', owner: 'duplicate-family' };
    data.child.memories.push(duplicate); data.revisions.set(duplicate.id, duplicate);
    data.addCard('event');
    const plan = await previewEventResync(data.lib, data.child);
    expect(plan.ids.size).toBe(0); expect(plan.cards).toEqual([]);
    expect(plan.entries[0].reason).toContain('来源摘要');
});

test('repeated historical signatures count once, but a blocked second parent still creates legacy ambiguity', async () => {
    const data = matchingFixture(1), card = data.addCard('first');
    data.addChild(card);
    let plan = await previewEventResync(data.lib, data.child);
    expect(plan.entries[0].action).toBe('replace');
    data.addCard('second', true);
    plan = await previewEventResync(data.lib, data.child);
    expect(plan.cards).toEqual([]);
    expect(plan.entries[0].reason).toContain('多个'); expect(plan.entries[1].reason).toContain('来源摘要');
});

test('exact receipts take precedence over ambiguous legacy matches and uncertain same-title copies are not duplicated', async () => {
    const data = matchingFixture(1), card = data.addCard('first');
    const target = data.addChild(card, 'exact');
    target.inheritance = { version: 1, branch: 'parent', event: 'first', epoch: 1, archived: false, key: 'old' };
    data.addChild(card, 'legacy-one'); data.addChild(card, 'legacy-two');
    let plan = await previewEventResync(data.lib, data.child);
    expect(plan.replacements.get('first')).toBe('exact');
    target.inheritance = undefined;
    for (const rows of data.childRows.values()) rows.revisions.push({ ...rows.revisions[0], id: row('revision').id });
    plan = await previewEventResync(data.lib, data.child);
    expect(plan.cards).toEqual([]); expect(plan.entries[0].reason).toContain('同名');
});

test('300 metadata epochs advance through membership history once', async () => {
    const { lib, view, branch } = await fixture(1);
    let reads = 0;
    try {
        const chain: EventChain = { ...row('event'), story: branch.story, branch: branch.id, created: 1 };
        await lib.transaction(STORES, 'readwrite', async tx => {
            await tx.add('event_chains', chain);
            for (let epoch = 1; epoch <= 300; epoch++) {
                await tx.add('event_revisions', { ...row('revision'), story: branch.story, branch: branch.id, owner: chain.id,
                    title: `title-${epoch}`, status: 'open', keywords: [], snapshot: branch.head, cutoff: 2, epoch,
                    created: epoch, refs: [], overview: '' } as EventRevision);
                await tx.add('event_memberships', { ...row('member'), story: branch.story, branch: branch.id, owner: chain.id,
                    memory: view.memories[0].id, kind: 'progress', origin: 'manual', locked: true, active: epoch % 2 === 1,
                    epoch, snapshot: branch.head, cutoff: 2 } as Membership);
            }
            await tx.put('branches', { ...branch, epoch: 301 } as Branch);
        });
        const current = await canonical.capture(lib, branch.id), all = Transaction.prototype.all;
        vi.spyOn(Transaction.prototype, 'all').mockImplementation(async function (this: Transaction, store, index, key) {
            const rows = await all.call(this, store, index, key);
            if (store === 'event_memberships') for (const row of rows as Membership[]) {
                const value = row.memory; Object.defineProperty(row, 'memory', { enumerable: true, get: () => { reads++; return value; } });
            }
            return rows as any;
        });
        const projection = await events.eventView(lib, current, true);
        expect(projection.cards[0].history?.revisions).toHaveLength(300);
        expect(projection.cards[0].meta.title).toBe('title-300');
        expect(projection.cards[0].members).toHaveLength(0);
        expect(reads).toBeLessThan(2400); // Old per-epoch prefix traversal alone reads 45150 members.
    } finally { lib.close(); }
});

test('table rollback reuses one source prefix for 300 commits while preserving variant rejection', async () => {
    const { lib, view, branch } = await fixture(300);
    try {
        let head: string | undefined;
        await lib.transaction(STORES, 'readwrite', async tx => {
            for (let i = 0; i < 300; i++) {
                const commit: TableCommit = { ...row('table-history'), story: branch.story, branch: branch.id,
                    previous: head ?? null, parent: head ?? null, snapshot: branch.head, cutoff: view.refs.length,
                    sequence: i + 1, depth: 0, kind: 'write', operation: '', checkpoint: true, gap: false, defs: [], rows: [] };
                await tx.add('table_history', commit); head = commit.id;
            }
        });
        const mismatch = view.snapshot.variants!.slice(); mismatch[mismatch.length - 1] = 1;
        const gets = vi.spyOn(Transaction.prototype, 'get');
        const result = await lib.transaction(STORES, 'readonly', tx => compatibleTableHead(tx, head, view.refs, mismatch));
        expect(result).toBeNull();
        expect(gets.mock.calls.filter(([store]) => store === 'history_snapshots')).toHaveLength(1);
        expect(gets.mock.calls.filter(([store]) => store === 'manifest_blocks')).toHaveLength(view.snapshot.blocks.length);
        const ok = await lib.transaction(STORES, 'readonly', tx => compatibleTableHead(tx, head, view.refs, view.snapshot.variants));
        expect(ok?.id).toBe(head);
    } finally { lib.close(); }
});

test('nested summary floor proofs are shared across metadata and membership checks at the same cutoff', async () => {
    const count = 120, { lib, input, branch, view } = await fixture(count);
    try {
        for (let i = 0; i < count; i++) input.memories[i].inputRefs = [view.refs[i * 2 + 1]];
        for (let i = 0; i < count; i++) input.memories.push({ ...input.memories[0], hostId: `high-${i}`,
            content: `nested-${i}`, level: i + 1, anchorKey: null, inputRefs: [], coverage: [],
            children: i ? [`high-${i - 1}`, `leaf-${i}`] : ['leaf-0'] });
        await canonical.synchronize(lib, input);
        let current = await canonical.capture(lib, branch.id);
        const high = current.memories.filter(memory => memory.level > 0);
        const chain: EventChain = { ...row('event'), story: branch.story, branch: branch.id, created: 1 };
        await lib.transaction(STORES, 'readwrite', async tx => {
            await tx.add('event_chains', chain);
            for (const [index, memory] of high.entries()) {
                const epoch = index + 1;
                await tx.add('event_revisions', { ...row('revision'), story: branch.story, branch: branch.id, owner: chain.id,
                    title: `nested-${epoch}`, status: 'open', keywords: [], snapshot: current.snapshot.id,
                    cutoff: current.cutoff, epoch, created: epoch, refs: [memory.id], overview: '' } as EventRevision);
                await tx.add('event_memberships', { ...row('member'), story: branch.story, branch: branch.id, owner: chain.id,
                    memory: memory.id, kind: 'progress', origin: 'manual', locked: true, active: true,
                    epoch, snapshot: current.snapshot.id, cutoff: current.cutoff } as Membership);
            }
            await tx.put('branches', { ...current.branch, epoch: count + 10 } as Branch);
        });
        current = await canonical.capture(lib, branch.id);
        const validity = await canonical.statuses(lib, current);
        expect([...validity.values()].every(value => value === 'valid')).toBe(true);
        let reads = 0;
        current.refs = current.refs.map(ref => ({ revision: ref.revision, get message() { reads++; return ref.message; } }));
        const projection = await events.eventView(lib, current, true, undefined, false, { validity });
        expect(projection.cards[0].history?.revisions).toHaveLength(count);
        expect(projection.cards[0].members).toHaveLength(count);
        expect(reads).toBeLessThan(count * 12);
    } finally { lib.close(); }
});
