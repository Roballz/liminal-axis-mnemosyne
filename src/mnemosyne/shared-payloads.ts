import { check, type Row, type Store } from './model';

export const SHARED_META = 'shared-storage-v1';
export const SHARED_STORE = 'memory_payloads' as const;
export const SHARED_FIELDS = {
    memory_revisions: ['content', 'inputRefs', 'coverage', 'dependencies'],
    reviews: ['sourceRefs', 'coverage', 'dependencies'],
} as const;
export interface Payload extends Row { kind: 'text' | 'list' | 'node'; value: any; count: number }
type Ref = { shared: string };
const isRef = (v: any): v is Ref => !!v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.shared === 'string';
const fields = (store: Store): readonly string[] => (SHARED_FIELDS as any)[store] ?? [];
export const sharedStore = (store: Store) => fields(store).length > 0;
export const sharedRow = (row: Row): boolean => 'sharedSchema' in row;

/** Routing digest, not identity: every intern checks the complete canonical value.
 * Synchronous so no crypto/timer can close an IndexedDB transaction. */
export function payloadKey(text: string): string {
    let a = 2166136261, b = 2246822519;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b ^ text.charCodeAt(i), 3266489917);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export function validatePayload(row: Payload) {
    check(row && row.schema === 1 && typeof row.id === 'string' && /^mp_[a-f0-9]{16}(?:_\d+)?$/.test(row.id) &&
        Object.keys(row).every(k => ['id', 'schema', 'kind', 'value', 'count'].includes(k)) &&
        Number.isSafeInteger(row.count) && row.count >= 0, '共享内容记录非法');
    check(row.kind === 'text' ? typeof row.value === 'string' && row.count === row.value.length :
        row.kind === 'list' ? Array.isArray(row.value) && row.value.length <= 64 && row.count === row.value.length &&
            row.value.every((v: any) => typeof v === 'string' || v && typeof v.message === 'string' && typeof v.revision === 'string' && Object.keys(v).length === 2) :
        row.kind === 'node' && Array.isArray(row.value) && row.value.length > 0 && row.value.length <= 64 &&
            row.value.every((v: any) => typeof v === 'string'), '共享内容结构非法');
}
function expandRow(row: Row, store: Store, read: (key: string) => any): Row {
    if (!sharedRow(row)) return row;
    const value = row as any;
    check(sharedStore(store) && value.sharedSchema === 1, '共享内容版本非法');
    const result = { ...value }; delete result.sharedSchema;
    let refs = 0;
    for (const field of fields(store)) if (isRef(result[field])) {
        refs++; result[field] = read(result[field].shared);
        check(field === 'content' ? typeof result[field] === 'string' : Array.isArray(result[field]), '共享字段类型非法');
    }
    check(refs > 0, '共享内容引用缺失');
    return result;
}

/** Package validation shares decoded blocks. Never mutate the physical archive. */
export function payloadReader(rows: readonly Row[]) {
    const byId = new Map<string, Payload>(), cache = new Map<string, any>(), visiting = new Set<string>();
    for (const row of rows as Payload[]) { validatePayload(row); check(!byId.has(row.id), '共享内容ID重复'); byId.set(row.id, row); }
    const read = (key: string, depth = 0): any => {
        check(depth <= 12 && !visiting.has(key), '共享内容循环或层级过深');
        if (cache.has(key)) return cache.get(key);
        const row = byId.get(key); check(row, '共享内容引用缺失'); visiting.add(key);
        if (row.kind === 'node') {
            const total = row.value.reduce((sum: number, id: string) => {
                const child = byId.get(id); check(child && child.kind !== 'text', '共享列表子块缺失或类型非法');
                return sum + child.count;
            }, 0);
            check(total === row.count && total <= 1_000_000, '共享列表计数错误或超过单列表容量');
        }
        const value = row.kind !== 'node' ? row.value : row.value.flatMap((id: string) => {
            const child = read(id, depth + 1); check(Array.isArray(child), '共享列表子块类型非法'); return child;
        });
        check(row.kind === 'text' || value.length === row.count, '共享列表计数错误');
        visiting.delete(key); cache.set(key, value); return value;
    };
    // Validate unused blocks too; deletion may leave immutable unreferenced blocks.
    for (const id of byId.keys()) read(id);
    return (row: Row, store: Store) => expandRow(row, store, read);
}

export class SharedPayloads {
    private cache = new Map<string, Payload>();
    private cacheBytes = 0;
    private pending = new Map<string, Promise<Payload | undefined>>();
    constructor(private load: (key: string) => Promise<Payload | undefined>, private add: (row: Payload) => Promise<unknown>,
        private hash = payloadKey) {}
    private remember(row: Payload) {
        if (this.cache.has(row.id)) return;
        const size = JSON.stringify(row).length;
        if (size > 512_000) return;
        while (this.cache.size && (this.cache.size >= 256 || this.cacheBytes + size > 512_000)) {
            const key = this.cache.keys().next().value!;
            this.cacheBytes -= JSON.stringify(this.cache.get(key)).length; this.cache.delete(key);
        }
        this.cache.set(row.id, structuredClone(row)); this.cacheBytes += size;
    }
    private block(id: string): Promise<Payload | undefined> {
        const cached = this.cache.get(id);
        if (cached) return Promise.resolve(cached);
        let pending = this.pending.get(id);
        if (!pending) {
            pending = this.load(id).then(row => {
                if (row) { validatePayload(row); this.remember(row); }
                return row;
            }).finally(() => this.pending.delete(id));
            this.pending.set(id, pending);
        }
        return pending;
    }
    private async intern(kind: Payload['kind'], value: any, count: number): Promise<string> {
        const canonical = JSON.stringify([kind, value, count]), base = `mp_${this.hash(canonical)}`;
        for (let collision = 0; ; collision++) {
            const id = collision ? `${base}_${collision}` : base;
            const existing = await this.block(id);
            if (existing) {
                validatePayload(existing); this.remember(existing);
                if (JSON.stringify([existing.kind, existing.value, existing.count]) === canonical) return id;
            } else {
                const row: Payload = { id, schema: 1, kind, value, count };
                await this.add(row); this.remember(row); return id;
            }
        }
    }
    private async sequence(values: any[]): Promise<string> {
        check(values.length <= 1_000_000, '共享列表超过单列表容量');
        if (values.length <= 64) return this.intern('list', values, values.length);
        let blocks: { id: string; count: number }[] = [];
        for (let i = 0; i < values.length; i += 64) {
            const part = values.slice(i, i + 64); blocks.push({ id: await this.intern('list', part, part.length), count: part.length });
        }
        while (blocks.length > 1) {
            const next: typeof blocks = [];
            for (let i = 0; i < blocks.length; i += 64) {
                const group = blocks.slice(i, i + 64), count = group.reduce((n, b) => n + b.count, 0);
                next.push({ id: await this.intern('node', group.map(b => b.id), count), count });
            }
            blocks = next;
        }
        return blocks[0].id;
    }
    async pack(store: Store, row: Row): Promise<Row> {
        if (!sharedStore(store) || sharedRow(row)) return row;
        const result = { ...row } as any;
        let packed = false;
        for (const field of fields(store)) {
            const value = result[field];
            // Tiny values stay inline, avoiding more IO/overhead than the original field.
            if (typeof value === 'string' && value.length >= 128) {
                result[field] = { shared: await this.intern('text', value, value.length) }; packed = true;
            } else if (Array.isArray(value) && JSON.stringify(value).length >= 256) {
                result[field] = { shared: await this.sequence(value) }; packed = true;
            }
        }
        if (packed) result.sharedSchema = 1;
        return result;
    }
    async unpack(store: Store, row: Row): Promise<Row> {
        if (!sharedRow(row)) return row;
        const decoded = new Map<string, any>(), visiting = new Set<string>();
        const read = async (id: string, depth = 0): Promise<any> => {
            check(depth <= 12 && !visiting.has(id), '共享内容循环或层级过深');
            if (decoded.has(id)) return decoded.get(id);
            const block = await this.block(id); check(block, '共享内容引用缺失');
            visiting.add(id);
            let value = block.value;
            if (block.kind === 'node') {
                check(block.count <= 1_000_000, '共享列表超过单列表容量');
                value = [];
                for (const child of block.value) {
                    const part = await read(child, depth + 1); check(Array.isArray(part) && value.length + part.length <= block.count, '共享列表子块类型或计数非法'); for (const item of part) value.push(item);
                }
            }
            check(block.kind === 'text' || value.length === block.count, '共享列表计数错误');
            visiting.delete(id); decoded.set(id, value); return value;
        };
        const values = new Map<string, any>();
        for (const field of fields(store)) if (isRef((row as any)[field])) {
            const key = (row as any)[field].shared; values.set(key, await read(key));
        }
        return expandRow(row, store, key => structuredClone(values.get(key)));
    }
}
