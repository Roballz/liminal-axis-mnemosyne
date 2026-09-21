// Small, rebuildable P4 recall sidecar. It proves index lifecycle and final
// domain filtering without claiming BM25, embedding quality, or reranking.
import { canonicalize, equal, requireThat as check } from '../contracts/primitives.mjs';
import { sha256 } from '../contracts/runtime.mjs';

export const RECALL_INDEX_FORMAT = 'mnemosyne-recall-index-v1';
export const RECALL_INDEX_LIMITS = Object.freeze({ entries: 256, bytes: 1024 * 1024, vector: 64, candidates: 256 });
const ROOT_SLOT = 0;
const clone = value => structuredClone(value);
const checksum = body => sha256(canonicalize(body));

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    equal(Object.keys(value).sort(), [...keys].sort());
}

function sourceShape(source) {
  check(exact(source, ['branch_id', 'checkpoint', 'head_snapshot_id', 'library_id', 'story_id', 'view_version']),
    'INDEX_CORRUPT', 'Invalid recall index source');
  check(exact(source.checkpoint, ['hash', 'slot']), 'INDEX_CORRUPT', 'Invalid recall index checkpoint');
  return source;
}

function vector(value) {
  check(Array.isArray(value) && value.length > 0 && value.length <= RECALL_INDEX_LIMITS.vector &&
    value.every(item => typeof item === 'number' && Number.isFinite(item)),
  'INVALID_SCHEMA', 'Finite artificial vector required');
  return [...value];
}

function markers(value) {
  check(Array.isArray(value) && value.length <= 64 && value.every(item =>
    typeof item === 'string' && item.length > 0 && item.length <= 128 && item.isWellFormed()),
  'INVALID_SCHEMA', 'Index markers must be bounded strings');
  return [...new Set(value.map(item => item.toLocaleLowerCase('und')))].sort();
}

export function defaultMarkers(memory) {
  return markers(memory.content.match(/\p{Script=Han}+|[\p{L}\p{N}_-]+/gu) ?? []);
}

export function artificialVector(memory) {
  let han = 0, ascii = 0;
  for (const character of memory.content) /\p{Script=Han}/u.test(character) ? han++ : ascii++;
  return [han, ascii, memory.content.length];
}

const memoryFingerprint = memory => sha256(canonicalize(memory));

function seal(body) {
  const root = { ...body, checksum: checksum(body) };
  check(new TextEncoder().encode(canonicalize(root)).length <= RECALL_INDEX_LIMITS.bytes,
    'RESOURCE_LIMIT', 'Recall index root exceeds 1MiB');
  return root;
}

function inspect(root) {
  check(exact(root, ['checksum', 'entries', 'error', 'format', 'progress', 'source', 'status']) &&
    root.format === RECALL_INDEX_FORMAT && ['building', 'ready', 'failed'].includes(root.status) &&
    Array.isArray(root.entries) && root.entries.length <= RECALL_INDEX_LIMITS.entries &&
    exact(root.progress, ['indexed', 'scanned']) && Number.isSafeInteger(root.progress.scanned) &&
    Number.isSafeInteger(root.progress.indexed) && root.progress.scanned >= root.progress.indexed &&
    (root.error === null || exact(root.error, ['code', 'message'])),
  'INDEX_CORRUPT', 'Invalid recall index root');
  const { checksum: saved, ...body } = root;
  check(saved === checksum(body), 'INDEX_CORRUPT', 'Recall index checksum mismatch');
  sourceShape(root.source);
  for (const entry of root.entries) {
    check(exact(entry, ['branch_id', 'fingerprint', 'markers', 'memory_revision_id', 'story_id', 'vector', 'view_version']),
      'INDEX_CORRUPT', 'Invalid recall index entry');
    markers(entry.markers); vector(entry.vector);
  }
  return clone(root);
}

function sameSource(a, b) {
  return a && b && a.library_id === b.library_id && a.story_id === b.story_id &&
    a.branch_id === b.branch_id && a.head_snapshot_id === b.head_snapshot_id &&
    a.view_version === b.view_version && equal(a.checkpoint, b.checkpoint);
}

async function currentSource(handle, branchId) {
  const diagnostic = await handle.diagnostics(branchId);
  check(diagnostic.branch, 'INVALID_SCHEMA', 'Branch diagnostics required');
  return {
    library_id: diagnostic.library_id,
    checkpoint: diagnostic.checkpoint,
    story_id: diagnostic.branch.story_id,
    branch_id: diagnostic.branch.branch_id,
    head_snapshot_id: diagnostic.branch.head_snapshot_id,
    view_version: diagnostic.branch.view_version,
  };
}

function cosine(left, right) {
  if (left.length !== right.length) return 0;
  let dot = 0, a = 0, b = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
}

function markerScore(query, candidate) {
  if (!query.length || !candidate.length) return 0;
  const wanted = new Set(query), found = candidate.filter(value => wanted.has(value)).length;
  return found / new Set([...query, ...candidate]).size;
}

export async function filterRecallCandidates(handle, scope, candidates) {
  check(Array.isArray(candidates) && candidates.length <= RECALL_INDEX_LIMITS.candidates,
    'RESOURCE_LIMIT', 'Recall candidate limit');
  const source = await currentSource(handle, scope.branch_id);
  if (scope.story_id !== source.story_id || !sameSource(source, scope.source)) return [];
  const view = await handle.read('views', scope.branch_id), accepted = [], seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.memory_revision_id) || candidate.story_id !== source.story_id ||
      candidate.branch_id !== source.branch_id || candidate.view_version !== source.view_version) continue;
    let memory;
    try { memory = await handle.read('memories', candidate.memory_revision_id); } catch { continue; }
    if (memory.story_id !== source.story_id || view.selections[memory.memory_id] !== memory.memory_revision_id ||
      candidate.fingerprint !== memoryFingerprint(memory)) continue;
    if (await handle.memoryStatus(memory.memory_revision_id, source.branch_id) !== 'valid') continue;
    seen.add(memory.memory_revision_id);
    accepted.push({ memory_revision_id: memory.memory_revision_id, kind: memory.kind, content: memory.content,
      index_score: candidate.index_score, rerank_score: null });
  }
  return accepted;
}

export class RecallIndex {
  #io; #root = null;
  constructor(io) {
    check(io && ['get', 'put', 'flush'].every(method => typeof io[method] === 'function'),
      'INVALID_SCHEMA', 'Recall index IO required');
    this.#io = io;
  }
  async recover() {
    await this.#io.reopen?.();
    const root = await this.#io.get(ROOT_SLOT);
    this.#root = root === null ? null : inspect(root);
    return this.describe();
  }
  describe() {
    if (this.#root === null) return { format: RECALL_INDEX_FORMAT, status: 'missing', source: null,
      progress: { scanned: 0, indexed: 0 }, error: null };
    const { entries, checksum: ignored, ...summary } = this.#root;
    return clone({ ...summary, entry_count: entries.length });
  }
  async #write(body) {
    const root = seal(body);
    await this.#io.put(ROOT_SLOT, root); await this.#io.flush(); this.#root = root;
  }
  async rebuild(handle, branchId, options = {}) {
    const tokenize = options.markers ?? defaultMarkers;
    const vectorize = options.vector ?? artificialVector;
    const source = await currentSource(handle, branchId);
    const building = { format: RECALL_INDEX_FORMAT, status: 'building', source,
      entries: [], progress: { scanned: 0, indexed: 0 }, error: null };
    await this.#write(building);
    let scanned = 0;
    try {
      const view = await handle.read('views', branchId);
      const selected = [...new Set(Object.values(view.selections))];
      check(selected.length <= RECALL_INDEX_LIMITS.entries, 'RESOURCE_LIMIT', 'Recall index entry limit');
      const entries = [];
      for (const revisionId of selected) {
        scanned++;
        const memory = await handle.read('memories', revisionId);
        if (memory.story_id !== source.story_id || await handle.memoryStatus(revisionId, branchId) !== 'valid') continue;
        entries.push({ memory_revision_id: revisionId, story_id: source.story_id, branch_id: branchId,
          view_version: source.view_version, fingerprint: memoryFingerprint(memory),
          markers: markers(await tokenize(clone(memory))), vector: vector(await vectorize(clone(memory))) });
      }
      await this.#write({ ...building, status: 'ready', entries,
        progress: { scanned, indexed: entries.length } });
      return this.describe();
    } catch (error) {
      await this.#write({ ...building, status: 'failed', progress: { scanned, indexed: 0 },
        error: { code: error.code ?? 'INDEX_BUILD_FAILED', message: String(error.message) } });
      throw error;
    }
  }
  async status(handle, branchId) {
    if (this.#root === null) await this.recover();
    const summary = this.describe();
    if (summary.status !== 'ready') return summary;
    const source = await currentSource(handle, branchId);
    return sameSource(source, summary.source) ? summary : { ...summary, status: 'behind' };
  }
  async search(handle, branchId, query, { limit = 16 } = {}) {
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 64, 'RESOURCE_LIMIT', 'Recall result limit');
    const state = await this.status(handle, branchId);
    if (state.status !== 'ready') return { status: state.status, results: [] };
    const queryMarkers = markers(query.markers ?? []), queryVector = vector(query.vector);
    const candidates = this.#root.entries.map(entry => ({ ...entry,
      index_score: (markerScore(queryMarkers, entry.markers) + cosine(queryVector, entry.vector)) / 2 }))
      .sort((a, b) => b.index_score - a.index_score || a.memory_revision_id.localeCompare(b.memory_revision_id));
    const results = await filterRecallCandidates(handle,
      { story_id: state.source.story_id, branch_id: branchId, source: state.source }, candidates);
    return { status: 'ready', results: results.slice(0, limit) };
  }
}
