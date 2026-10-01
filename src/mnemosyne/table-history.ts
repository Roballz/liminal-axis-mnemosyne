import type { Transaction } from './db';
import { snapshotRefs } from './canonical';
import { check, equal, row, type Branch, type Snapshot, type SourceRef, type TableCommit, type TableDef, type TableRow } from './model';

export const TABLE_STORES = ['branches', 'custom_table_defs', 'custom_table_rows', 'table_receipts',
    'table_history', 'history_snapshots', 'manifest_blocks'] as const;

async function projection(tx: Transaction, branch: string) {
    return { defs: await tx.all<TableDef>('custom_table_defs', 'branch', branch),
        rows: await tx.all<TableRow>('custom_table_rows', 'branch', branch) };
}

/** Called BEFORE the first mutation, including before adopting a changed body Head. */
export async function ensureTableHistory(tx: Transaction, branch: Branch) {
    if (branch.tableHead) return;
    const state = await projection(tx, branch.id);
    const snapshot = await tx.get<Snapshot>('history_snapshots', branch.head);
    check(snapshot, '表格基线缺少正文快照');
    const commit: TableCommit = { ...row('th'), story: branch.story, branch: branch.id,
        previous: null, parent: null, snapshot: branch.head,
        // An empty database is known empty before its first table. Existing legacy values are not backdated.
        cutoff: state.defs.length || state.rows.length ? snapshot.length : 0,
        sequence: 1, depth: 0, kind: 'baseline', operation: '', checkpoint: true, gap: false, ...state };
    await tx.add('table_history', commit);
    branch.tableHead = commit.id;
    branch.tableHistoryGap = false;
}

export async function recordTableWrite(tx: Transaction, branch: Branch, defs: TableDef[], rows: TableRow[], operation: string) {
    check(branch.tableHead, '表格历史未初始化');
    const prior = await tx.get<TableCommit>('table_history', branch.tableHead);
    const snapshot = await tx.get<Snapshot>('history_snapshots', branch.head);
    check(prior && snapshot, '表格历史不完整');
    const sequence = prior.sequence + 1;
    const checkpoint = prior.depth >= 63;
    // Projection retains abandoned tombstones for old receipts. They must not enter a new checkpoint.
    const base = checkpoint ? await tableStateAt(tx, prior.id) : { defs: [], rows: [] };
    const state = {
        defs: [...new Map([...base.defs, ...defs].map(d => [d.id, d])).values()],
        rows: [...new Map([...base.rows, ...rows].map(r => [r.id, r])).values()] };
    const commit: TableCommit = { ...row('th'), story: branch.story, branch: branch.id,
        previous: prior.id, parent: prior.id, snapshot: branch.head, cutoff: snapshot.length,
        sequence, depth: checkpoint ? 0 : prior.depth + 1, kind: 'write', operation, checkpoint, gap: !!branch.tableHistoryGap, ...state };
    await tx.add('table_history', commit);
    branch.tableHead = commit.id;
}

export async function tableStateAt(tx: Transaction, head: string | null) {
    const chain: TableCommit[] = [], seen = new Set<string>();
    while (head) {
        check(!seen.has(head), '表格历史循环'); seen.add(head);
        const commit = await tx.get<TableCommit>('table_history', head);
        check(commit, '表格历史缺失'); chain.push(commit);
        if (commit.checkpoint) break;
        head = commit.parent;
    }
    const defs = new Map<string, TableDef>(), rows = new Map<string, TableRow>();
    for (const commit of chain.reverse()) {
        for (const def of commit.defs) defs.set(def.id, def);
        for (const record of commit.rows) rows.set(record.id, record);
    }
    return { defs: [...defs.values()], rows: [...rows.values()] };
}

async function compatible(tx: Transaction, commit: TableCommit, refs: SourceRef[], variants?: number[]) {
    if (commit.cutoff > refs.length) return false;
    const snapshot = await tx.get<Snapshot>('history_snapshots', commit.snapshot);
    check(snapshot, '表格历史来源快照缺失');
    if (!equal((await snapshotRefs(tx, snapshot)).slice(0, commit.cutoff), refs.slice(0, commit.cutoff))) return false;
    // Legacy snapshots cannot attest a non-default swipe identity.
    const old = snapshot.variants?.slice(0, commit.cutoff) ?? Array(commit.cutoff).fill(0);
    const next = variants?.slice(0, commit.cutoff) ?? Array(commit.cutoff).fill(0);
    return equal(old, next);
}

export async function compatibleTableHead(tx: Transaction, head: string | undefined, refs: SourceRef[], variants?: number[]) {
    const seen = new Set<string>();
    while (head) {
        check(!seen.has(head), '表格历史循环'); seen.add(head);
        const commit = await tx.get<TableCommit>('table_history', head);
        check(commit, '表格历史缺失');
        if (await compatible(tx, commit, refs, variants)) return commit;
        head = commit.parent ?? undefined;
    }
    return null;
}

/** Keep projection identities/tombstones for receipts, but never restore old concurrency counters. */
async function adoptProjection(tx: Transaction, branch: Branch, target: { defs: TableDef[]; rows: TableRow[] }) {
    const current = await projection(tx, branch.id);
    const defs = new Map(target.defs.map(d => [d.id, d]));
    const rows = new Map(target.rows.map(r => [r.id, r]));
    for (const old of current.defs) {
        const value = defs.get(old.id);
        defs.set(old.id, { ...(value ?? old), deleted: value?.deleted ?? true,
            version: Math.max(old.version, value?.version ?? 0) + 1,
            dataVersion: Math.max(old.dataVersion ?? 0, value?.dataVersion ?? 0) + 1 });
    }
    for (const old of current.rows) {
        const value = rows.get(old.id);
        rows.set(old.id, { ...(value ?? old), deleted: value?.deleted ?? true,
            version: Math.max(old.version, value?.version ?? 0) + 1 });
    }
    for (const def of defs.values()) await tx.put('custom_table_defs', def);
    for (const record of rows.values()) await tx.put('custom_table_rows', record);
}

export async function reconcileTableHistory(tx: Transaction, branch: Branch, refs: SourceRef[], variants?: number[]) {
    check(branch.tableHead, '表格历史未初始化');
    const prior = (await tx.get<TableCommit>('table_history', branch.tableHead))!;
    const target = await compatibleTableHead(tx, prior.id, refs, variants);
    if (target?.id === prior.id) return;
    await adoptProjection(tx, branch, await tableStateAt(tx, target?.id ?? null));
    const commit: TableCommit = { ...row('th'), story: branch.story, branch: branch.id,
        previous: prior.id, parent: target?.id ?? null, snapshot: branch.head, cutoff: refs.length,
        sequence: prior.sequence + 1, depth: target ? target.depth + 1 : 0, kind: 'restore', operation: '', checkpoint: !target,
        gap: !target || target.gap, defs: [], rows: [] };
    await tx.add('table_history', commit);
    branch.tableHead = commit.id;
    branch.tableHistoryGap = commit.gap;
}

/** Copy eligible state ancestry once. No mutable parent table/row is shared with the child. */
export async function inheritTableHistory(tx: Transaction, parent: Branch, branch: Branch, refs: SourceRef[],
    variants: number[] | undefined, mapMemory: (id: string) => Promise<string | undefined>) {
    await ensureTableHistory(tx, parent);
    const target = await compatibleTableHead(tx, parent.tableHead, refs, variants);
    const ancestry: TableCommit[] = [];
    let cursor = target;
    while (cursor) {
        ancestry.push(cursor);
        cursor = cursor.parent ? (await tx.get<TableCommit>('table_history', cursor.parent))! : null;
    }
    const tables = new Map<string, string>(), rows = new Map<string, string>(), commits = new Map<string, string>();
    const mapped = (map: Map<string, string>, key: string, prefix: string) => {
        if (!map.has(key)) map.set(key, row(prefix).id);
        return map.get(key)!;
    };
    for (const source of ancestry.reverse()) {
        const defs = source.defs.map(def => ({ ...def, id: mapped(tables, def.id, 'table'), branch: branch.id }));
        const records: TableRow[] = [];
        for (const record of source.rows) {
            const sources: string[] = [];
            for (const id of record.sources) {
                const copied = await mapMemory(id);
                check(copied, '继承表格历史来源缺失');
                sources.push(copied);
            }
            records.push({ ...record, id: mapped(rows, record.id, 'row'), owner: mapped(tables, record.owner!, 'table'),
                branch: branch.id, sources });
        }
        const parentId = source.parent ? commits.get(source.parent) ?? null : null;
        const copied: TableCommit = { ...source, id: mapped(commits, source.id, 'th'), branch: branch.id,
            previous: parentId, parent: parentId, snapshot: branch.head, kind: 'inherit', operation: '', defs, rows: records };
        await tx.add('table_history', copied);
        branch.tableHead = copied.id;
    }
    branch.tableHistoryGap = !target || target.gap;
    if (!target) {
        const baseline: TableCommit = { ...row('th'), story: branch.story, branch: branch.id, previous: null, parent: null,
            snapshot: branch.head, cutoff: refs.length, sequence: 1, depth: 0, kind: 'inherit', operation: '',
            checkpoint: true, gap: true, defs: [], rows: [] };
        await tx.add('table_history', baseline); branch.tableHead = baseline.id;
    }
    await adoptProjection(tx, branch, await tableStateAt(tx, branch.tableHead!));
    await tx.put('branches', parent);
}
