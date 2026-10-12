// Deliberately independent of the normal library, migrations and host runtime.
export const ARCHIVE_STORES = [
  'stories', 'branches', 'source_messages', 'source_revisions', 'history_snapshots',
  'manifest_blocks', 'host_bindings', 'message_mappings', 'memories', 'memory_revisions',
  'memory_views', 'reviews', 'event_chains', 'event_revisions', 'event_memberships',
  'event_progress', 'event_processing_receipts', 'custom_table_defs', 'custom_table_rows',
  'table_receipts', 'table_history', 'library_meta',
] as const;
export const ACTIVE_KEY = 'mnemosyne_daily_active_v1';
export const isArchive = (name: string) => /^mnemosyne_daily_(default|lib[_-].+)$/.test(name);
export const errorInfo = (e: unknown) => ({ name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) });
function failure(name: string, message: string) { return Object.assign(new Error(message), { name }); }
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure('TimeoutError', '操作超时；没有把超时当成底层操作已取消')), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
export async function enumerate(factory: IDBFactory, ms = 10000) {
  if (typeof factory.databases !== 'function') throw failure('NotSupportedError', '此浏览器不能枚举数据库；不会猜测库名或尝试创建数据库');
  return (await bounded(factory.databases(), ms)).filter((d): d is IDBDatabaseInfo & { name: string } => typeof d.name === 'string');
}
export async function openExisting(factory: IDBFactory, name: string, ms = 10000): Promise<IDBDatabase> {
  if (!isArchive(name)) throw failure('NotAllowedError', '只能选择已枚举的 Mnemosyne 日用库');
  const known = await enumerate(factory, ms);
  if (!known.some(d => d.name === name)) throw failure('NotFoundError', '数据库已不存在；未尝试打开');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => finish(failure('TimeoutError', '打开超时；迟到的连接会关闭')), ms);
    let request: IDBOpenDBRequest;
    try { request = factory.open(name); } catch (e) { finish(e); return; }
    request.onupgradeneeded = () => {
      // Enumeration and open can race deletion. Abort version 0 creation, never initialize.
      request.transaction?.abort();
      finish(failure('NotFoundError', '打开期间数据库消失或需要升级；已中止，未创建库结构'));
    };
    request.onerror = () => finish(request.error ?? failure('UnknownError', '打开失败'));
    request.onblocked = () => finish(failure('BlockedError', '数据库被其他连接阻塞；请关闭旧会话'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (settled) { db.close(); return; }
      settled = true; clearTimeout(timer); resolve(db);
    };
  });
}
export interface StoreInfo { name: string; count?: number; error?: ReturnType<typeof errorInfo> }
export interface RawStore { name: string; keyPath: string | string[] | null; autoIncrement: boolean; records: { key: IDBValidKey; value: unknown }[] }
// All requests are scheduled synchronously in ONE readonly transaction, no async gaps.
async function snapshot(db: IDBDatabase, raw: boolean, ms: number): Promise<{ counts: StoreInfo[]; stores: RawStore[] }> {
  const names = Array.from(db.objectStoreNames);
  if (!names.length) return { counts: [], stores: [] };
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(names, 'readonly'); } catch (e) { reject(e); return; }
    const counts: StoreInfo[] = [], stores: RawStore[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { tx.abort(); } catch { /* may already be complete */ }
      reject(failure('TimeoutError', '只读事务超时；未生成部分备份'));
    }, ms);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve({ counts, stores });
    };
    tx.oncomplete = () => finish();
    tx.onabort = () => finish(tx.error ?? failure('AbortError', '只读事务已中止'));
    tx.onerror = () => {}; // request error / transaction abort supplies the actual error
    try {
      for (const name of names) {
        const store = tx.objectStore(name);
        const info: StoreInfo = { name }; counts.push(info);
        const count = store.count();
        count.onsuccess = () => { info.count = count.result; };
        count.onerror = event => {
          info.error = errorInfo(count.error);
          if (!raw) { event.preventDefault(); event.stopPropagation(); }
        };
        if (raw && (ARCHIVE_STORES as readonly string[]).includes(name)) {
          const data: RawStore = { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, records: [] };
          stores.push(data);
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            if (!cursor.result) return;
            data.records.push({ key: cursor.result.primaryKey, value: cursor.result.value });
            cursor.result.continue();
          };
        }
      }
    } catch (e) { try { tx.abort(); } catch {} finish(e); }
  });
}
export async function inspect(factory: IDBFactory, name: string, ms = 10000) {
  const db = await openExisting(factory, name, ms);
  try { return { name, version: db.version, ...(await snapshot(db, false, ms)) }; }
  finally { db.close(); }
}
export async function readRaw(factory: IDBFactory, name: string, ms = 60000) {
  const db = await openExisting(factory, name, ms);
  try {
    const data = await snapshot(db, true, ms);
    return { name, version: db.version, ...data, omittedStores: data.counts.filter(s => !(ARCHIVE_STORES as readonly string[]).includes(s.name)).map(s => s.name) };
  } finally { db.close(); }
}

// Tagged graph preserves malformed domain records, cycles and structured-clone values.
// This is a rescue format, NOT a normal core import package. Unsupported values fail closed.
export async function encodeGraph(value: unknown): Promise<unknown> {
  const nodes: unknown[] = [], seen = new Map<object, number>();
  async function encode(v: unknown): Promise<unknown> {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? v : { $number: String(Object.is(v, -0) ? '-0' : v) };
    if (typeof v === 'undefined') return { $undefined: true };
    if (typeof v === 'bigint') return { $bigint: String(v) };
    if (typeof v !== 'object') throw failure('DataCloneError', '不支持的值类型；导出已停止');
    const old = seen.get(v); if (old !== undefined) return { $ref: old };
    const index = nodes.length; seen.set(v, index); nodes.push(null);
    let node: unknown;
    if (v instanceof Date) node = { type: 'Date', value: await encode(v.getTime()) };
    else if (v instanceof RegExp) node = { type: 'RegExp', source: v.source, flags: v.flags, lastIndex: v.lastIndex };
    else if (v instanceof ArrayBuffer) node = { type: 'ArrayBuffer', bytes: Array.from(new Uint8Array(v)) };
    else if (ArrayBuffer.isView(v)) node = { type: v.constructor.name, buffer: await encode(v.buffer), byteOffset: v.byteOffset, byteLength: v.byteLength };
    else if (v instanceof Blob) node = { type: typeof File !== 'undefined' && v instanceof File ? 'File' : 'Blob', mime: v.type, ...(typeof File !== 'undefined' && v instanceof File ? { name: v.name, lastModified: v.lastModified } : {}), bytes: Array.from(new Uint8Array(await bounded(v.arrayBuffer(), 30000))) };
    else if (v instanceof Map) { const entries = []; for (const [k, val] of v) entries.push([await encode(k), await encode(val)]); node = { type: 'Map', entries }; }
    else if (v instanceof Set) { const entries = []; for (const val of v) entries.push(await encode(val)); node = { type: 'Set', entries }; }
    else if (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) {
      const entries = []; for (const key of Object.keys(v)) entries.push([key, await encode((v as Record<string, unknown>)[key])]);
      node = { type: Array.isArray(v) ? 'Array' : 'Object', ...(Array.isArray(v) ? { length: v.length } : { nullPrototype: Object.getPrototypeOf(v) === null }), entries };
    } else throw failure('DataCloneError', `不支持的对象 ${v.constructor?.name ?? 'unknown'}；未生成不完整备份`);
    nodes[index] = node; return { $ref: index };
  }
  return { encoding: 'mnemosyne-tagged-graph-v1', root: await encode(value), nodes };
}
