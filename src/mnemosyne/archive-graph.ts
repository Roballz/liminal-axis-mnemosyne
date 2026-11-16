import { check, type Row, type Store } from './model';

export type RecordLink = [Store, string];
/** Explicit schema edges. Never interpret story text, table cells or arbitrary strings as IDs. */
export function recordLinks(store: Store, value: Row): RecordLink[] {
    const r = value as any, result: RecordLink[] = [];
    const add = (store: Store, id: unknown) => { if (typeof id === 'string' && id) result.push([store, id]); };
    const many = (store: Store, ids: unknown) => { if (Array.isArray(ids)) for (const id of ids) add(store, id); };
    const sources = (refs: unknown) => { if (Array.isArray(refs)) for (const ref of refs) {
        add('source_messages', ref?.message); add('source_revisions', ref?.revision);
    } };
    add('stories', r.story); add('branches', r.branch);
    switch (store) {
        case 'branches':
            add('history_snapshots', r.head); add('memory_views', r.view); add('table_history', r.tableHead);
            add('history_snapshots', r.legacyHead);
            if (r.fork) { add('branches', r.fork.branch); add('history_snapshots', r.fork.snapshot); sources([r.fork.anchor]); }
            for (const pair of r.sourceRoleRepairs ?? []) sources([pair.before, pair.after]);
            break;
        case 'source_revisions': add('source_messages', r.owner); add('host_bindings', r.provenance?.binding); break;
        case 'source_bodies': add('source_revisions', r.id); add('source_messages', r.owner); break;
        case 'history_snapshots': add('history_snapshots', r.previous); many('manifest_blocks', r.blocks); break;
        case 'manifest_blocks': sources(r.entries); break;
        case 'message_mappings': add('host_bindings', r.owner); add('source_messages', r.message); break;
        case 'memories': add('host_bindings', r.owner); break;
        case 'memory_revisions':
            add('memories', r.owner); add('history_snapshots', r.sourceRecovery?.snapshot ?? r.basis);
            if (!r.sourceRecovery) { sources(r.inputRefs); sources(r.coverage); }
            many('memory_revisions', r.dependencies); add('source_messages', r.anchor); break;
        case 'memory_views':
            if (r.selectionSchema === 2) add('memory_selection_nodes', r.root);
            else for (const [family, revision] of Object.entries(r.selections ?? {})) { add('memories', family); add('memory_revisions', revision); }
            break;
        case 'memory_selection_nodes':
            many('memory_selection_nodes', Object.values(r.children));
            for (const [family, revision] of r.entries) { add('memories', family); add('memory_revisions', revision); }
            break;
        case 'reviews':
            add('memory_revisions', r.owner); add('history_snapshots', r.snapshot);
            sources(r.sourceRefs); sources(r.coverage); many('memory_revisions', r.dependencies); break;
        case 'event_revisions':
            add('event_chains', r.owner); add('history_snapshots', r.snapshot);
            many('memory_revisions', r.refs); many('memory_revisions', r.summarized);
            add('memory_revisions', r.latestProgress?.memory); break;
        case 'event_memberships': add('event_chains', r.owner); add('history_snapshots', r.snapshot); add('memory_revisions', r.memory); break;
        case 'event_progress': add('event_chains', r.owner); add('history_snapshots', r.snapshot); many('memory_revisions', r.memories); break;
        case 'event_processing_receipts':
            add('history_snapshots', r.snapshot); add('memory_views', r.view); many('memory_revisions', r.memories); break;
        case 'custom_table_rows': add('custom_table_defs', r.owner); many('memory_revisions', r.sources); sources(r.bodySources); break;
        case 'table_receipts':
            add('custom_table_defs', r.owner); add('history_snapshots', r.snapshot); many('memory_revisions', r.sources); sources(r.bodySources); break;
        case 'table_history':
            add('table_history', r.previous); add('table_history', r.parent); add('history_snapshots', r.snapshot);
            for (const def of r.defs) add('custom_table_defs', def.id);
            for (const row of r.rows) {
                add('custom_table_rows', row.id); add('custom_table_defs', row.owner);
                many('memory_revisions', row.sources); sources(row.bodySources);
            }
            break;
    }
    return result;
}

/** Iterative traversal visits shared DAGs once. A missing edge is an error, never permission to delete. */
export function markRecords(roots: RecordLink[], get: (store: Store, id: string) => Row | undefined,
    links = recordLinks): Map<Store, Set<string>> {
    const live = new Map<Store, Set<string>>(), queue = roots.slice();
    while (queue.length) {
        const [store, id] = queue.pop()!;
        let ids = live.get(store);
        if (ids?.has(id)) continue;
        const row = get(store, id); check(row, `保留数据的引用缺失 ${store}/${id}`);
        if (!ids) live.set(store, ids = new Set());
        ids.add(id);
        for (const link of links(store, row)) queue.push(link);
    }
    return live;
}
