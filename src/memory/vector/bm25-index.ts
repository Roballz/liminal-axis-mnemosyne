import MiniSearch from 'minisearch';

export interface LexicalDocument { id: string; text: string }
export interface LexicalRequest {
  database: string; scope: string; documents: LexicalDocument[]; queries: string[]; exclude: string[]; topK: number;
}
export interface LexicalResult { hits: { id: string; score: number }[]; persistent: boolean }
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
const VERSION = `minisearch-7.2-bm25plus-v1-${segmenter ? 'segmenter' : 'bigram'}`;
const stop = new Set(['的', '了', '着', '吗', '呢', '啊', '是', '在', '和', '与', '及', '一个']);
/** Unicode 分词保留名称和数字；旧 WebView 无 Segmenter 时用汉字双字组回退。 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const terms = segmenter
    ? [...segmenter.segment(normalized)].filter(p => p.isWordLike).map(p => p.segment)
    : normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu)?.flatMap(word =>
      /^[\p{Script=Han}]{2,}$/u.test(word) ? Array.from(word).slice(1).map((_, i) => word.slice(i, i + 2)) : [word]) || [];
  return terms.filter(t => !stop.has(t));
}
const options = { fields: ['text'], tokenize, searchOptions: { prefix: false, fuzzy: false, combineWith: 'OR' as const } };
export type LexicalSnapshot = { key: string; version: string; documents: LexicalDocument[]; index: string };
export interface LexicalPersistence {
  load(key: string): Promise<LexicalSnapshot | undefined>;
  save(snapshot: LexicalSnapshot): Promise<unknown>;
}
let dbPromise: Promise<IDBDatabase> | undefined;
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('mnemosyne_bm25_local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('indexes', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = undefined; reject(request.error); };
  });
  return dbPromise;
}
async function persisted(key: string, snapshot?: LexicalSnapshot): Promise<LexicalSnapshot | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('indexes', snapshot ? 'readwrite' : 'readonly');
    const store = tx.objectStore('indexes');
    const request = snapshot ? store.put(snapshot) : store.get(key);
    tx.oncomplete = () => resolve(snapshot || request.result);
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}

/** Worker 内只保留当前 scope；IndexedDB 是可重建的派生缓存，不承担原文保管。 */
export class LexicalIndex {
  private key = '';
  private index = new MiniSearch<LexicalDocument>(options);
  private documents = new Map<string, LexicalDocument>();
  private generation = 0;
  private revision = 0;
  private persistedRevision = -1;
  private ready = false;
  private saveRequested = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  constructor(private readonly storage: LexicalPersistence = {
    load: key => persisted(key), save: snapshot => persisted(snapshot.key, snapshot),
  }) {}

  private scheduleSave(): void {
    if (!this.ready || this.revision === this.persistedRevision) return;
    this.saveRequested = true;
    if (this.saving || this.saveTimer !== undefined) return;
    // A later Worker task: returning hits/postMessage happens before serialization.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flushPending().catch(() => {}); // Dirty revision remains retryable.
    }, 0);
  }

  /** Drain the latest pending revision. Failed writes retain dirty state; a new
   * search retries them. One in-flight write never clears a newer generation. */
  flushPending(): Promise<void> {
    if (this.saveTimer !== undefined) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (this.saving) return this.saving.then(() => this.flushPending());
    const task = Promise.resolve().then(async () => {
      if (!this.ready || this.revision === this.persistedRevision) return;
      const generation = this.generation, revision = this.revision;
      this.saveRequested = false;
      // No await between the two projections: both describe this exact revision.
      const snapshot = { key: this.key, version: VERSION, documents: [...this.documents.values()], index: JSON.stringify(this.index) };
      await this.storage.save(snapshot);
      if (generation === this.generation) this.persistedRevision = revision;
    }).finally(() => {
      if (this.saving === task) this.saving = undefined;
      if (this.saveRequested) this.scheduleSave();
    });
    this.saving = task;
    return task;
  }

  async search(request: LexicalRequest): Promise<LexicalResult> {
    const key = JSON.stringify([request.database, request.scope]);
    if (key !== this.key) {
      if (this.saveTimer !== undefined) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
      this.key = key; this.generation++; this.revision = 0; this.persistedRevision = -1;
      this.ready = false; this.saveRequested = false;
      this.index = new MiniSearch(options); this.documents.clear();
      try {
        const saved = await this.storage.load(key);
        if (saved?.version === VERSION) {
          this.index = MiniSearch.loadJSON(saved.index, options);
          this.documents = new Map(saved.documents.map(d => [d.id, d])); this.persistedRevision = 0;
        }
      } catch {
        // 损坏的派生索引可从本次有效摘要重建，不能留下半加载状态。
        this.index = new MiniSearch(options); this.documents.clear(); this.persistedRevision = -1;
      }
    }
    const current = new Map(request.documents.map(d => [d.id, { ...d }]));
    for (const [id, old] of this.documents) {
      if (current.get(id)?.text !== old.text) {
        this.revision++; this.index.remove(old); this.documents.delete(id);
      }
    }
    for (const [id, doc] of current) if (!this.documents.has(id)) {
      this.revision++; this.index.add(doc); this.documents.set(id, doc);
    }
    const excluded = new Set(request.exclude);
    const scores = new Map<string, number>();
    // 原始 User 输入与改写 Q 分开检索，max 合并避免重复 Query 刷分。
    for (const query of new Set(request.queries.filter(q => q.trim()))) {
      for (const hit of this.index.search(query)) if (!excluded.has(String(hit.id)) && hit.score > 0) {
        scores.set(String(hit.id), Math.max(scores.get(String(hit.id)) || 0, hit.score));
      }
    }
    this.ready = true;
    this.scheduleSave();
    return { persistent: this.persistedRevision === this.revision, hits: [...scores].map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, request.topK) };
  }
}
