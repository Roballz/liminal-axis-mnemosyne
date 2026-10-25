import type { Transaction } from './db';
import { check, row, type CompactMemoryView, type MemorySelectionNode, type MemoryView, type MemoryRevision } from './model';

type StoredView = MemoryView | CompactMemoryView;
type Entry = MemorySelectionNode['entries'][number];
const LEAF_SIZE = 64;
export const compactMemoryView = (view: StoredView): view is CompactMemoryView => 'selectionSchema' in view;

/** Routing only: complete family IDs, never this hash, determine identity. */
export function selectionPath(family: string): string {
    let hash = 2166136261;
    for (let i = 0; i < family.length; i++) hash = Math.imul(hash ^ family.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function validateSelectionNode(node: MemorySelectionNode): void {
    check(node && node.schema === 1 && typeof node.branch === 'string' &&
        typeof node.prefix === 'string' && /^[a-f0-9]{0,8}$/.test(node.prefix) &&
        node.children && typeof node.children === 'object' && !Array.isArray(node.children) &&
        Array.isArray(node.entries) && Number.isSafeInteger(node.count) && node.count > 0,
    '摘要选择节点格式非法');
    const children = Object.entries(node.children);
    check(children.every(([edge, id]) => /^[a-f0-9]$/.test(edge) && typeof id === 'string' && !!id) &&
        (children.length ? !node.entries.length && node.prefix.length < 8 :
            node.entries.length > 0 && node.count === node.entries.length &&
            (node.entries.length <= LEAF_SIZE || node.prefix.length === 8)), '摘要选择节点结构非法');
    const families = new Set<string>();
    for (const entry of node.entries) {
        check(Array.isArray(entry) && entry.length === 3 && typeof entry[0] === 'string' && !!entry[0] &&
            typeof entry[1] === 'string' && !!entry[1] && Number.isSafeInteger(entry[2]) && entry[2] >= 0 &&
            !families.has(entry[0]) && selectionPath(entry[0]).startsWith(node.prefix), '摘要选择条目非法');
        families.add(entry[0]);
    }
}

/** Validate shared nodes once, without expanding every historical mapping.
 * Fixed hash prefixes make duplicate families across separate child paths impossible. */
export function validateMemorySelections(views: StoredView[], nodes: MemorySelectionNode[],
    memory: (id: string) => MemoryRevision): void {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const roots: string[] = [];
    for (const node of nodes) {
        validateSelectionNode(node);
        for (const [family, id] of node.entries) {
            const revision = memory(id);
            check(revision.owner === family && revision.branch === node.branch, '摘要选择错误');
        }
        let count = 0;
        for (const [edge, id] of Object.entries(node.children)) {
            const child = byId.get(id);
            check(child && child.branch === node.branch && child.prefix === node.prefix + edge,
                '摘要选择节点缺失、循环或跨分支');
            count += child.count;
        }
        if (Object.keys(node.children).length) check(count === node.count, '摘要选择节点计数错误');
    }
    for (const view of views) {
        if (!compactMemoryView(view)) {
            check(view.selections && typeof view.selections === 'object' && !Array.isArray(view.selections), '摘要选择视图格式非法');
            for (const [family, id] of Object.entries(view.selections)) {
                const revision = memory(id);
                check(revision.owner === family && revision.branch === view.branch, '摘要选择错误');
            }
            continue;
        }
        check(view.selectionSchema === 2 && !('selections' in view) && Number.isSafeInteger(view.count) && view.count >= 0 &&
            (view.root === null ? view.count === 0 : typeof view.root === 'string' && !!view.root && view.count > 0),
        '摘要选择视图格式非法');
        if (view.root) {
            const root = byId.get(view.root);
            check(root && root.branch === view.branch && root.prefix === '' && root.count === view.count,
                '摘要选择根缺失、计数错误或跨分支');
            roots.push(root.id);
        }
    }
    const reachable = new Set<string>();
    while (roots.length) {
        const id = roots.pop()!;
        if (reachable.has(id)) continue;
        reachable.add(id);
        roots.push(...Object.values(byId.get(id)!.children));
    }
    check(reachable.size === nodes.length, '未提交孤立摘要选择节点');
}

/** Read one root's exact persisted ordering, including valid imported sparse ranks. */
async function selectionEntries(view: CompactMemoryView,
    load: (id: string) => Promise<MemorySelectionNode | undefined>): Promise<Entry[]> {
    check(view.selectionSchema === 2 && Number.isSafeInteger(view.count) && view.count >= 0 &&
        (view.root === null ? view.count === 0 : typeof view.root === 'string' && !!view.root && view.count > 0),
    '摘要选择视图格式非法');
    const entries: Entry[] = [], nodes = new Map<string, MemorySelectionNode>();
    let queue = view.root ? [{ id: view.root, prefix: '' }] : [];
    while (queue.length) {
        const batch = queue; queue = [];
        const values = await Promise.all(batch.map(item => load(item.id)));
        for (let i = 0; i < batch.length; i++) {
            const { id, prefix } = batch[i], node = values[i];
            check(node && !nodes.has(id) && node.id === id && node.branch === view.branch && node.prefix === prefix,
                '摘要选择节点缺失、循环或跨分支');
            validateSelectionNode(node); nodes.set(id, node);
            entries.push(...node.entries);
            for (const [edge, child] of Object.entries(node.children)) queue.push({ id: child, prefix: prefix + edge });
        }
    }
    for (const node of nodes.values()) if (Object.keys(node.children).length)
        check(Object.values(node.children).reduce((sum, id) => sum + nodes.get(id)!.count, 0) === node.count,
            '摘要选择节点计数错误');
    check(entries.length === view.count && new Set(entries.map(entry => entry[0])).size === view.count,
        '摘要选择视图计数或身份错误');
    entries.sort((a, b) => a[2] - b[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return entries;
}

/** Materialize only a requested view, keeping its original enumeration order.
 * Immutable nodes may be shared by any number of historical views. */
export async function materializeMemoryView(view: StoredView,
    load: (id: string) => Promise<MemorySelectionNode | undefined>): Promise<MemoryView> {
    if (!compactMemoryView(view)) return view;
    const entries = await selectionEntries(view, load);
    const { selectionSchema: _schema, root: _root, count: _count, ...identity } = view;
    return { ...identity, selections: Object.fromEntries(entries.map(([family, revision]) => [family, revision])) };
}

/** New views use a persistent hash trie. Only changed leaf buckets and their
 * ancestors are written; old view IDs, old nodes and legacy full maps remain intact. */
export async function publishMemoryView(tx: Transaction, view: MemoryView, previous?: MemoryView): Promise<void> {
    const old = previous ? await tx.rawGet<StoredView>('memory_views', previous.id) : undefined;
    check(!old || old.branch === view.branch, '摘要选择前驱跨分支');
    const reusable = old && compactMemoryView(old) ? old : undefined;
    const loaded = new Map<string, MemorySelectionNode>();
    const load = async (id: string) => {
        let node = loaded.get(id);
        if (!node) { node = await tx.get<MemorySelectionNode>('memory_selection_nodes', id); check(node, '摘要选择节点缺失'); loaded.set(id, node); }
        check(node.branch === view.branch, '摘要选择节点跨分支'); validateSelectionNode(node);
        return node;
    };
    // Read actual stored ranks instead of assuming imported ranks equal Object.entries
    // positions. Transaction-local node reads reuse capture's work, never another snapshot.
    const before = new Map((reusable ? await selectionEntries(reusable, load) : []).map(entry => [entry[0], entry]));
    const after = new Map(Object.entries(view.selections)
        .map(([family, revision], order): [string, Entry] => [family, [family, revision, order]]));
    const changes = new Map<string, Entry | undefined>();
    for (const [family, value] of after) {
        const prior = before.get(family);
        if (!prior || prior[1] !== value[1] || prior[2] !== value[2]) changes.set(family, value);
    }
    for (const family of before.keys()) if (!after.has(family)) changes.set(family, undefined);
    const write = async (prefix: string, entries: Entry[], children: Record<string, string>, count: number) => {
        const node: MemorySelectionNode = { ...row('msn'), branch: view.branch, prefix, children, entries, count };
        await tx.add('memory_selection_nodes', node); loaded.set(node.id, node); return node.id;
    };
    const build = async (prefix: string, entries: Entry[]): Promise<string | null> => {
        if (!entries.length) return null;
        if (entries.length <= LEAF_SIZE || prefix.length === 8) return write(prefix, entries, {}, entries.length);
        const groups = new Map<string, Entry[]>();
        for (const entry of entries) {
            const edge = selectionPath(entry[0])[prefix.length];
            const group = groups.get(edge) ?? []; group.push(entry); groups.set(edge, group);
        }
        const children: Record<string, string> = {};
        for (const [edge, group] of groups) children[edge] = (await build(prefix + edge, group))!;
        return write(prefix, [], children, entries.length);
    };
    const update = async (id: string | null, prefix: string, edits: Map<string, Entry | undefined>): Promise<string | null> => {
        if (!edits.size) return id;
        if (!id) return build(prefix, [...edits.values()].filter((entry): entry is Entry => !!entry));
        const oldNode = await load(id); check(oldNode.prefix === prefix, '摘要选择节点路径错误');
        if (!Object.keys(oldNode.children).length) {
            const entries = new Map(oldNode.entries.map(entry => [entry[0], entry]));
            for (const [family, entry] of edits) if (entry) entries.set(family, entry); else entries.delete(family);
            return build(prefix, [...entries.values()]);
        }
        const children = { ...oldNode.children }, groups = new Map<string, Map<string, Entry | undefined>>();
        for (const [family, entry] of edits) {
            const edge = selectionPath(family)[prefix.length];
            const group = groups.get(edge) ?? new Map(); group.set(family, entry); groups.set(edge, group);
        }
        let count = oldNode.count;
        for (const [edge, group] of groups) {
            if (children[edge]) count -= (await load(children[edge])).count;
            const child = await update(children[edge] ?? null, prefix + edge, group);
            if (child) { children[edge] = child; count += (await load(child)).count; } else delete children[edge];
        }
        return count ? write(prefix, [], children, count) : null;
    };
    const root = await update(reusable?.root ?? null, '', changes);
    const { selections: _selections, ...identity } = view;
    await tx.add('memory_views', { ...identity, selectionSchema: 2, root, count: after.size } as CompactMemoryView);
}
