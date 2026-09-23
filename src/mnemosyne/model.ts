/** Daily-library v1 is independent of the older B provider's physical protocol. */
export const SCHEMA = 1;
export const STORES = [
    'stories', 'branches', 'source_messages', 'source_revisions', 'history_snapshots',
    'manifest_blocks', 'host_bindings', 'message_mappings', 'memories', 'memory_revisions',
    'memory_views', 'reviews', 'event_chains', 'event_revisions', 'event_memberships',
    'event_progress', 'event_processing_receipts', 'custom_table_defs', 'custom_table_rows',
    'table_receipts', 'library_meta',
] as const;
export type Store = typeof STORES[number];
export interface Row {
    id: string;
    schema: 1;
    story?: string;
    branch?: string;
    owner?: string;
}
export interface SourceRef {
    message: string;
    revision: string;
}
export interface Story extends Row {
    created: number;
}
export interface Branch extends Row {
    story: string;
    head: string;
    view: string;
    epoch: number;
    fork: null | {
        branch: string;
        snapshot: string;
        length: number;
        anchor: SourceRef | null;
    };
}
export interface Message extends Row {
    story: string;
}
export interface Revision extends Row {
    story: string;
    owner: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    fingerprint: string;
    provenance: {
        binding: string;
        hostKey: string;
        index: number;
        swipe: number;
    };
}
export interface Block extends Row {
    entries: SourceRef[];
}
export interface Snapshot extends Row {
    story: string;
    branch: string;
    previous: string | null;
    blocks: string[];
    length: number;
    created: number;
}
export interface Binding extends Row {
    story: string;
    branch: string;
    scope: string;
    generation: number;
    intent: 'new_story' | 'fork' | 'carryover' | 'confirmed_mapping';
}
export interface Mapping extends Row {
    owner: string;
    message: string;
    hostKey: string;
}
export interface Memory extends Row {
    story: string;
    owner: string;
    hostId: string;
}
export interface MemoryRevision extends Row {
    story: string;
    branch: string;
    owner: string;
    content: string;
    fingerprint: string;
    basis: string;
    inputRefs: SourceRef[];
    coverage: SourceRef[];
    dependencies: string[];
    declaration: string | null;
    level: number;
    anchor: string | null;
    storyTime: string;
    recall: boolean;
    visibility: 'public' | 'private';
    seed: boolean;
    hostId: string;
}
export interface MemoryView extends Row {
    branch: string;
    selections: Record<string, string>;
}
export interface Review extends Row {
    story: string;
    branch: string;
    owner: string;
    snapshot: string;
    decision: 'compatible';
    origin: 'manual' | 'generated_sidecar';
    created: number;
}
export interface CapturedView {
    branch: Branch;
    snapshot: Snapshot;
    refs: SourceRef[];
    selection: MemoryView;
    sources: Map<string, Revision>;
    memories: MemoryRevision[];
    cutoff: number;
}
export interface EventChain extends Row {
    story: string;
    branch: string;
    created: number;
}
export interface EventRevision extends Row {
    story: string;
    branch: string;
    owner: string;
    title: string;
    status: string;
    keywords: string[];
    snapshot: string;
    cutoff: number;
    epoch: number;
    created: number;
    refs: string[];
}
export interface Membership extends Row {
    story: string;
    branch: string;
    owner: string;
    memory: string;
    kind: 'progress' | 'reference';
    origin: 'manual' | 'ai';
    locked: boolean;
    active: boolean;
    epoch: number;
    snapshot: string;
    cutoff: number;
}
export interface Progress extends Row {
    story: string;
    branch: string;
    owner: string;
    text: string;
    memories: string[];
    snapshot: string;
    cutoff: number;
    operation: string;
    epoch: number;
}
export interface EventReceipt extends Row {
    story: string;
    branch: string;
    snapshot: string;
    cutoff: number;
    view: string;
    fingerprint: string;
    memories: string[];
    result: 'success' | 'needs_review';
    output: unknown;
    created: number;
}
export type ColumnType = 'text' | 'number' | 'boolean';
export interface Column {
    id: string;
    name: string;
    type: ColumnType;
    description: string;
    mode: 'replace' | 'append' | 'manual';
}
export interface TableDef extends Row {
    story: string;
    branch: string;
    name: string;
    description: string;
    columns: Column[];
    ai: boolean;
    version: number;
    created: number;
    updated: number;
    deleted: boolean;
}
export interface TableRow extends Row {
    story: string;
    branch: string;
    owner: string;
    values: Record<string, string | number | boolean>;
    version: number;
    deleted: boolean;
    sources: string[];
}
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export const row = (prefix: string): Row => ({ id: id(prefix), schema: SCHEMA });
export const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function check(condition: unknown, message: string): asserts condition {
    if (!condition)
        throw new Error(message);
}
export async function fingerprint(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
