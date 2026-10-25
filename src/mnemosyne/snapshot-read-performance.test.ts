import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import ts from 'typescript';
import { Library, freshLibraryName } from './db';
import { capture, forkBranch, snapshotRefs } from './canonical';
import { snapshotVariants } from './current-body';
import { sourceRefMatches, sourceRefResolver } from './source-equivalence';
import { editEvent, eventView } from './events';
import { fixture } from './fixtures';
import type { Block, Branch, SourceRef } from './model';

afterEach(() => vi.restoreAllMocks());
const block = (revision: string): Block => ({ id: 'block', schema: 1,
  entries: [{ message: 'message', revision }], variants: [0] });
function nativeReads() {
  const get = vi.spyOn(IDBObjectStore.prototype, 'get');
  return { get, count: (store: string) => get.mock.contexts.filter(context => (context as IDBObjectStore).name === store).length };
}

test('snapshot refs and variants share one native read per manifest block inside a transaction', async () => {
  const { lib, view } = await fixture(150);
  const reads = nativeReads();
  try {
    await lib.transaction(['manifest_blocks'], 'readonly', async tx => {
      for (let pass = 0; pass < 5; pass++) {
        const [refs, variants] = await Promise.all([snapshotRefs(tx, view.snapshot), snapshotVariants(tx, view.snapshot)]);
        expect(refs).toEqual(view.refs); expect(variants).toEqual(view.snapshot.variants);
      }
    });
    expect(view.snapshot.blocks).toHaveLength(3);
    expect(reads.count('manifest_blocks')).toBe(3);
  } finally { lib.close(); }
});

test('put, delete and add each invalidate cached or in-flight block reads in native request order', async () => {
  const lib = await Library.open(freshLibraryName());
  await lib.transaction(['manifest_blocks'], 'readwrite', tx => tx.add('manifest_blocks', block('original')));
  const reads = nativeReads();
  try {
    await lib.transaction(['manifest_blocks'], 'readwrite', async tx => {
      const original = tx.get<Block>('manifest_blocks', 'block');
      expect(tx.get<Block>('manifest_blocks', 'block')).toBe(original);
      const putting = tx.put('manifest_blocks', block('put'));
      const afterPut = tx.get<Block>('manifest_blocks', 'block');
      const [before, , updated] = await Promise.all([original, putting, afterPut]);
      expect(before?.entries[0].revision).toBe('original'); expect(updated?.entries[0].revision).toBe('put');
      expect(tx.get<Block>('manifest_blocks', 'block')).toBe(afterPut);

      const deleting = tx.delete('manifest_blocks', 'block');
      const afterDelete = tx.get<Block>('manifest_blocks', 'block');
      expect(tx.get<Block>('manifest_blocks', 'block')).toBe(afterDelete);
      const adding = tx.add('manifest_blocks', block('added'));
      const afterAdd = tx.get<Block>('manifest_blocks', 'block');
      const [, missing, , added] = await Promise.all([deleting, afterDelete, adding, afterAdd]);
      expect(missing).toBeUndefined(); expect(added?.entries[0].revision).toBe('added');
      expect(tx.get<Block>('manifest_blocks', 'block')).toBe(afterAdd);
    });
    expect(reads.count('manifest_blocks')).toBe(4);
  } finally { lib.close(); }
});

test('ordinary mutable stores retain independent native reads', async () => {
  const lib = await Library.open(freshLibraryName());
  await lib.transaction(['library_meta'], 'readwrite', tx => tx.add('library_meta', { id: 'meta', schema: 1 }));
  const reads = nativeReads();
  try {
    await lib.transaction(['library_meta'], 'readonly', async tx => {
      const rows = await Promise.all([tx.get('library_meta', 'meta'), tx.get('library_meta', 'meta')]);
      expect(rows[0]).toEqual(rows[1]); expect(rows[0]).not.toBe(rows[1]);
    });
    expect(reads.count('library_meta')).toBe(2);
  } finally { lib.close(); }
});

test('new transactions reread blocks and see updates made by another connection', async () => {
  const lib = await Library.open(freshLibraryName()), other = await Library.open(lib.db.name);
  await lib.transaction(['manifest_blocks'], 'readwrite', tx => tx.add('manifest_blocks', block('original')));
  const reads = nativeReads();
  try {
    expect((await lib.get<Block>('manifest_blocks', 'block'))?.entries[0].revision).toBe('original');
    expect((await lib.get<Block>('manifest_blocks', 'block'))?.entries[0].revision).toBe('original');
    await other.transaction(['manifest_blocks'], 'readwrite', tx => tx.put('manifest_blocks', block('other-connection')));
    expect((await lib.get<Block>('manifest_blocks', 'block'))?.entries[0].revision).toBe('other-connection');
    await other.transaction(['manifest_blocks'], 'readwrite', tx => tx.delete('manifest_blocks', 'block'));
    expect(await lib.get('manifest_blocks', 'block')).toBeUndefined();
    expect(reads.count('manifest_blocks')).toBe(4);
  } finally { other.close(); lib.close(); }
});

test('source resolver preserves first matching duplicate message and directional exact role repairs', () => {
  const old = { message: 'm', revision: 'old' }, approved = { message: 'm', revision: 'approved' };
  const branch: Branch = { id: 'branch', schema: 1, story: 'story', head: 'snapshot', view: 'view', epoch: 1, fork: null,
    sourceRoleRepairSchema: 1, sourceRoleRepairs: [{ before: old, after: approved, confirmedAt: 1 }] };
  const refs: SourceRef[] = [{ message: 'm', revision: 'unrelated' }, approved, old,
    { ...approved }, { message: 'other', revision: 'approved' }];
  const find = vi.spyOn(refs, 'find').mockImplementation(() => { throw Error('full ref scan'); });
  const repairs = vi.spyOn(branch.sourceRoleRepairs!, 'some');
  const resolve = sourceRefResolver(branch, refs);
  expect(resolve(old)).toBe(approved); // Approved earlier ref wins even over a later exact ref.
  const approvalChecks = repairs.mock.calls.length;
  for (let i = 0; i < 100; i++) expect(resolve({ ...old })).toBe(approved);
  expect(repairs).toHaveBeenCalledTimes(approvalChecks); expect(find).not.toHaveBeenCalled();
  expect(resolve(approved)).toBe(approved);
  expect(resolve({ message: 'm', revision: 'future' })).toBeUndefined();
  expect(resolve({ message: 'other', revision: 'old' })).toBeUndefined();
  expect(sourceRefResolver(branch, [old])(approved)).toBeUndefined(); // Repair never runs backwards.
  expect(sourceRefResolver({ ...branch, sourceRoleRepairSchema: undefined }, refs)(old)).toBe(old);
});

test('a real fork copies sources, mappings and events without parent.refs.find or parent.refs.some', async () => {
  const { lib, branch, view } = await fixture(40);
  try {
    await editEvent(lib, view, null, { title: 'Indexed fork', status: 'open', keywords: [],
      overview: 'Synthetic inherited overview', summarized: [view.memories[0].id] },
    { memory: view.memories[0].id, active: true, kind: 'progress' });
    const parent = await capture(lib, branch.id);
    const find = vi.spyOn(parent.refs, 'find').mockImplementation(() => { throw Error('parent.refs.find'); });
    const some = vi.spyOn(parent.refs, 'some').mockImplementation(() => { throw Error('parent.refs.some'); });
    const child = await forkBranch(lib, parent, 'indexed-child');
    expect(find).not.toHaveBeenCalled(); expect(some).not.toHaveBeenCalled();
    const copied = await capture(lib, child.id);
    expect(copied.refs).toEqual(parent.refs); expect(copied.memories).toHaveLength(40);
    const inherited = (await eventView(lib, copied)).cards;
    expect(inherited).toHaveLength(1); expect(inherited[0].meta.overview).toBe('Synthetic inherited overview');
    expect(inherited[0].members).toHaveLength(1);
    const bindings = await lib.all<any>('host_bindings', 'branch', child.id);
    expect(await lib.all('message_mappings', 'owner', bindings[0].id)).toHaveLength(parent.refs.length);
  } finally { lib.close(); }
});

test('the production floor matcher handles a 5000-level shared DAG and retains short-circuit checks', () => {
  const source = readFileSync(new URL('./events.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('            const matches = (node: MaterialFloors)'), end = source.indexOf('            return floors.every', begin);
  expect(begin).toBeGreaterThan(-1); expect(end).toBeGreaterThan(begin);
  const factory = new Function('memo', 'positions', 'record', 'view', 'evidence', 'sourceRefMatches',
    ts.transpile(source.slice(begin, end), { target: ts.ScriptTarget.ES2022 }) + '\nreturn matches;');
  type Node = { messages: string[]; dependencies: Node[] };
  let root: Node = { messages: ['message'], dependencies: [] };
  for (let i = 0; i < 5000; i++) root = { messages: [], dependencies: [root] };
  root = { messages: [], dependencies: [root, root] };
  const ref = { message: 'message', revision: 'revision' }, positions = new Map([['message', 0]]);
  const view = { branch: {}, refs: [ref], snapshot: { variants: [0] } }, evidence = { refs: [ref], variants: [0] };
  const memo = new Map<Node, boolean>(), verify = vi.fn(sourceRefMatches);
  const matches = factory(memo, positions, { cutoff: 1 }, view, evidence, verify);
  expect(matches(root)).toBe(true); expect(memo.size).toBe(5002); expect(verify).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) expect(matches(root)).toBe(true);
  expect(verify).toHaveBeenCalledTimes(1);

  const untouched = vi.fn(() => { throw Error('ineligible branch must not visit children'); });
  const hidden = { get messages(): string[] { return untouched(); }, dependencies: [] };
  expect(matches({ messages: ['missing-message'], dependencies: [hidden] })).toBe(false);
  const invalidChild = { messages: ['missing-message'], dependencies: [] };
  expect(matches({ messages: [], dependencies: [invalidChild, hidden] })).toBe(false);
  expect(untouched).not.toHaveBeenCalled();
  const differentCutoff = factory(new Map(), positions, { cutoff: 0 }, view, evidence, verify);
  expect(differentCutoff(root)).toBe(false); // A separate record group cannot reuse the earlier proof.
});
