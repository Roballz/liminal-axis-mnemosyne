import { expect, test, vi } from 'vitest';
import { createNodeFloorIndex, selectViewNodes, type ViewNode } from './select';

const leaf = (i: number): ViewNode => ({ id: `leaf-${i}`, kind: 'leaf', level: 0, text: `Summary ${i}`,
  createdAt: i, childIds: [], msgIndex: i, active: true });
const comp = (id: string, childIds: string[]): ViewNode => ({ id, kind: 'comp', level: 1, text: id,
  createdAt: 1, childIds, msgIndex: -1, active: true });
function chain(count: number) {
  const byId = new Map<string, ViewNode>();
  let root = leaf(0); byId.set(root.id, root);
  for (let i = 1; i < count; i++) {
    const child = leaf(i); byId.set(child.id, child);
    root = comp(`comp-${i}`, [root.id, child.id]); byId.set(root.id, root);
  }
  return { byId, roots: [root] };
}

test('1000 nested prefixes evaluate each leaf once and traverse each edge only a constant number of times', () => {
  const view = chain(1000), lookup = vi.spyOn(view.byId, 'get');
  const eligible = vi.fn((node: ViewNode) => node.msgIndex !== 0);
  const selected = selectViewNodes(view, eligible);
  expect(selected.map(node => node.msgIndex)).toEqual(Array.from({ length: 999 }, (_, i) => i + 1));
  expect(eligible).toHaveBeenCalledTimes(1000);
  expect(lookup.mock.calls.length).toBeLessThanOrEqual(4_000);
});

test('incomplete ancestors split only the affected branch and preserve eligible atomic imports', () => {
  const a = leaf(1), b = leaf(3), c = leaf(4);
  const broken = comp('broken', [a.id, 'missing']);
  const whole = comp('whole', [b.id, c.id]);
  const imported = { ...comp('imported', []), atomic: true, floorStart: 8, floorEnd: 20 };
  const root = comp('root', [broken.id, whole.id]);
  const byId = new Map([a, b, c, broken, whole, root, imported].map(node => [node.id, node]));
  expect(selectViewNodes({ byId, roots: [imported, root] }, () => true).map(node => node.id))
    .toEqual([a.id, whole.id, imported.id]);
  expect(selectViewNodes({ byId, roots: [imported, root] }, node => node.id !== b.id).map(node => node.id))
    .toEqual([a.id, c.id, imported.id]);
});

test('all 1000 prefix ranges share one traversal and repeat lookups perform no descendant reads', () => {
  const view = chain(1000), lookup = vi.spyOn(view.byId, 'get');
  const range = createNodeFloorIndex(view.byId);
  expect(range(view.roots[0])).toEqual([0, 999]);
  for (const node of view.byId.values()) expect(range(node)[1]).toBeGreaterThanOrEqual(0);
  expect(lookup).toHaveBeenCalledTimes(1998);
  lookup.mockClear();
  for (const node of view.byId.values()) range(node);
  expect(lookup).not.toHaveBeenCalled();
});

test('cyclic or dangling forest data neither recurses forever nor hides reachable leaves', () => {
  const item = leaf(20), a = comp('a', ['b']), b = comp('b', ['a', item.id, 'missing']);
  const byId = new Map([a, b, item].map(node => [node.id, node]));
  const range = createNodeFloorIndex(byId);
  expect(range(a)).toEqual([20, 20]); expect(range(b)).toEqual([20, 20]);
  expect(selectViewNodes({ byId, roots: [a] }, () => true)).toEqual([item]);
});
