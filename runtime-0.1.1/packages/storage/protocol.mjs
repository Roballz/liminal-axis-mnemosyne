// P0-P2 bounded protocol prototype. Not the P3 production storage layout.
import { canonicalize, equal, fingerprint, freeze, requireThat } from '../contracts/primitives.mjs';
import { emptyState } from '../contracts/history.mjs';
import { exportLogical, importLogical, validateState } from '../contracts/transfer.mjs';
import { rebuildPlan } from '../contracts/memory.mjs';

export const FORMAT = 'mnemosyne-storage-p2-v1';
export const LIMITS = Object.freeze({ records: 256, entries: 32, selections: 16, bytes: 262144, commits: 64 });
const mutable = new Set(['branches', 'views', 'bindings']);
const tables = Object.keys(emptyState()).filter(k => k !== 'schema_version');
const hash = value => fingerprint('write-payload', value);
const check = (ok, code, message) => requireThat(ok, code, message);

export function bounded(state) {
  validateState(state);
  check(tables.reduce((n, t) => n + Object.keys(state[t]).length, 0) <= LIMITS.records &&
    Object.values(state.snapshots).every(s => s.message_count <= LIMITS.entries) &&
    Object.values(state.views).every(v => Object.keys(v.selections).length <= LIMITS.selections) &&
    new TextEncoder().encode(canonicalize(state)).length <= LIMITS.bytes,
  'P2_LIMIT', 'Small-fixture prototype limit; P3 has not been implemented');
  return state;
}
export function expected(state) {
  return {
    heads: Object.fromEntries(Object.entries(state.branches).map(([k, v]) => [k, v.head_snapshot_id])),
    views: Object.fromEntries(Object.entries(state.views).map(([k, v]) => [k, v.version])),
    bindings: Object.fromEntries(Object.entries(state.bindings).map(([k, v]) => [k, v.binding_generation])),
  };
}
export function recoveryMarkers(state) {
  return Object.fromEntries(Object.keys(state.branches).map(k => [k, {
    head: state.branches[k].head_snapshot_id, view: state.views[k].version,
    index: 'behind', plan: rebuildPlan(state, k),
  }]));
}
// Caller compiles with the accepted domain functions. All generated IDs are part
// of this stable request; retry must retain this exact request, not recompile it.
export function prepareTransaction(before, after, operation_id, result) {
  bounded(before); bounded(after);
  const changes = [];
  for (const table of tables) {
    for (const key of Object.keys(before[table])) {
      check(Object.hasOwn(after[table], key), 'INVALID_TRANSITION', 'P2 never removes archived objects');
    }
    for (const [key, value] of Object.entries(after[table])) {
      if (!Object.hasOwn(before[table], key) || !equal(before[table][key], value)) changes.push({ table, key, value });
    }
  }
  return freeze({ format: FORMAT, operation_id, expected: expected(before), changes, result });
}
function apply(state, request) {
  check(new TextEncoder().encode(canonicalize(request)).length <= LIMITS.bytes,
    'P2_LIMIT', 'Compiled request exceeds P2 size limit');
  check(request.format === FORMAT && typeof request.operation_id === 'string' &&
    /^op_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.operation_id),
  'INVALID_SCHEMA', 'Invalid compiled storage request');
  check(equal(request.expected, expected(state)), 'STALE_WRITE', 'Expected Head/view/binding mismatch');
  const next = structuredClone(state), seen = new Set();
  for (const { table, key, value } of request.changes) {
    check(tables.includes(table) && typeof key === 'string' && key !== '__proto__', 'INVALID_SCHEMA', 'Unknown table/key');
    check(!seen.has(table + '/' + key), 'INVALID_SCHEMA', 'Duplicate change');
    seen.add(table + '/' + key);
    const old = state[table][key];
    check(!old || mutable.has(table) || equal(old, value), 'ID_COLLISION', 'Immutable object conflict');
    if (old && table === 'bindings') check(old.story_id === value.story_id &&
      value.binding_generation === old.binding_generation + 1, 'STALE_WRITE', 'Invalid binding transition');
    if (old && table === 'branches') check(old.story_id === value.story_id && equal(old.fork, value.fork),
      'INVALID_TRANSITION', 'Branch ownership/fork is immutable');
    if (old && table === 'views') check(old.version !== value.version, 'STALE_WRITE', 'View must advance');
    next[table][key] = structuredClone(value);
  }
  return bounded(next);
}

// One owner per namespace; every handle shares this queue. Host/native promises
// are never raced with an AbortSignal: stopping a waiter cannot release ownership.
export class StoreOwner {
  #retired = false;
  constructor(io) {
    this.io = io; this.tail = Promise.resolve(); this.generation = 0;
    this.status = 'recovery-required'; this.state = emptyState();
    this.tip = null; this.ledger = new Map(); this.objects = new Map(); this.nextId = 1;
    this.journal = []; this.staging = false;
  }
  queue(fn) {
    const job = this.tail.then(fn);
    this.tail = job.catch(() => {});
    return job;
  }
  handle() {
    const epoch = this.generation;
    const run = fn => this.queue(() => {
      check(epoch === this.generation, 'STALE_HANDLE', 'Owner was closed/recovered');
      check(this.status === 'ready', 'RECOVERY_REQUIRED', 'Native outcome must be resolved first');
      return fn();
    });
    return Object.freeze({
      commit: request => { const copy = structuredClone(request); return run(() => this.commit(copy)); },
      read: () => run(() => freeze(structuredClone(this.state))),
      export: () => run(() => this.bundle()),
    });
  }
  async boundary(label, fn) {
    await this.io.point?.(label, 'before');
    const result = await fn();
    await this.io.point?.(label, 'after');
    return result;
  }
  async object(value) {
    const checksum = hash(value);
    if (this.objects.has(checksum)) return this.objects.get(checksum);
    const id = this.nextId++;
    await this.boundary('object', () => this.io.put(id, { format: FORMAT, kind: 'object', checksum, value }));
    this.objects.set(checksum, id);
    return id;
  }
  async commit(request) {
    check(!this.#retired, 'OWNER_CLOSED', 'Closed owner cannot write again');
    const checksum = hash(request), prior = this.ledger.get(request.operation_id);
    // Idempotency precedes expected-state validation, including after restart.
    if (prior) {
      check(prior.checksum === checksum, 'OPERATION_CONFLICT', 'Same operation, different request');
      return freeze(structuredClone(prior.result));
    }
    check(this.ledger.size < LIMITS.commits, 'P2_LIMIT', 'P2 journal limit');
    check(this.nextId + request.changes.length + 3 <= 8192, 'P2_LIMIT', 'P2 physical allocation limit');
    const next = apply(this.state, request);
    const markers = recoveryMarkers(next);
    try {
      const refs = [];
      for (const change of request.changes) refs.push(await this.object(change));
      const requestId = await this.object({ ...request, changes: refs });
      const markersId = await this.object(markers);
      const commit = { format: FORMAT, kind: 'commit', previous: this.tip,
        operation_id: request.operation_id, checksum, request: requestId,
        changes: refs, markers: markersId, result: request.result };
      const commitId = this.nextId++;
      await this.boundary('commit-record', () => this.io.put(commitId, commit));
      await this.boundary('prepare-flush', () => this.io.flush());
      // Logical slot 0 is the publication point (TT physical ID 1).
      await this.boundary('publish', () => this.io.put(0, { format: FORMAT, kind: 'root', tip: commitId, staging: this.staging }));
      await this.boundary('publish-flush', () => this.io.flush());
      await this.boundary('ack', async () => {});
      this.tip = commitId; this.state = freeze(next);
      this.ledger.set(request.operation_id, { checksum, result: request.result });
      this.journal.push(request);
      return freeze(structuredClone(request.result));
    } catch (cause) {
      this.status = 'recovery-required';
      const error = new Error('Write outcome unknown; retain operation/request and recover', { cause });
      error.code = 'RECOVERY_REQUIRED';
      throw error;
    }
  }
  recover() {
    return this.queue(async () => {
      check(!this.#retired, 'OWNER_CLOSED', 'Closed owner must be replaced through the registry');
      this.status = 'recovery-required'; this.generation++;
      // A failed native close may have closed the namespace before losing its reply.
      // Reopen only under the retained owner/registry lease, never a second queue.
      await this.io.reopen?.();
      // Drain happened through the owner queue. flush failures never become "not committed".
      await this.io.flush();
      const root = await this.io.get(0);
      check(root === null || root && typeof root === 'object' && !Array.isArray(root) &&
        equal(Object.keys(root).sort(), ['format', 'kind', 'staging', 'tip']) &&
        root.format === FORMAT && root.kind === 'root' && typeof root.staging === 'boolean' &&
        (root.tip === null || Number.isSafeInteger(root.tip) && root.tip > 0),
        'NEEDS_RESOLUTION', 'Foreign root');
      const objects = new Map(), nodes = new Map();
      let cursor = 1;
      // P2 only: contiguous allocation. Read each physical node exactly; no topK enumeration.
      for (; cursor <= 8192; cursor++) {
        const node = await this.io.get(cursor);
        if (node === null) break;
        check(node && typeof node === 'object' && !Array.isArray(node) && node.format === FORMAT &&
          ['object', 'commit'].includes(node.kind), 'NEEDS_RESOLUTION', 'Foreign node in dedicated namespace');
        nodes.set(cursor, node);
        if (node.kind === 'object') {
          check(hash(node.value) === node.checksum, 'NEEDS_RESOLUTION', 'Object checksum mismatch');
          objects.set(node.checksum, cursor);
        }
      }
      check(cursor <= 8192, 'P2_LIMIT', 'P2 physical scan limit');
      const chain = [], visited = new Set();
      let tip = root === null ? null : root.tip;
      while (tip !== null) {
        check(Number.isSafeInteger(tip) && tip > 0 && !visited.has(tip) && chain.length < LIMITS.commits,
          'NEEDS_RESOLUTION', 'Invalid/cyclic commit chain');
        visited.add(tip);
        const node = nodes.get(tip);
        check(node?.kind === 'commit', 'NEEDS_RESOLUTION', 'Missing committed record');
        chain.push(node); tip = node.previous;
      }
      const value = id => {
        const node = nodes.get(id);
        check(node?.kind === 'object', 'NEEDS_RESOLUTION', 'Missing committed object');
        return node.value;
      };
      let state = emptyState(); const ledger = new Map(), journal = [];
      for (const commit of chain.reverse()) {
        const stored = value(commit.request), request = { ...stored, changes: stored.changes.map(value) };
        check(hash(request) === commit.checksum && request.operation_id === commit.operation_id &&
          equal(commit.changes.map(value), request.changes) && equal(commit.result, request.result) &&
          !ledger.has(commit.operation_id), 'NEEDS_RESOLUTION', 'Commit/request/ledger disagreement');
        state = apply(state, request);
        check(equal(value(commit.markers), recoveryMarkers(state)), 'NEEDS_RESOLUTION', 'Missing/wrong rebuild markers');
        ledger.set(commit.operation_id, { checksum: commit.checksum, result: commit.result });
        journal.push(request);
      }
      this.state = freeze(state); this.tip = root === null ? null : root.tip; this.ledger = ledger;
      this.objects = objects; this.nextId = cursor; this.journal = journal;
      this.staging = root?.staging ?? false; this.status = this.staging ? 'staging' : 'ready';
      return this.handle();
    });
  }
  close() {
    return this.queue(async () => {
      if (this.#retired) return; // Never close a replacement owner's native namespace.
      this.status = 'closing'; this.generation++;
      try { await this.io.close(); }
      catch (error) { this.status = 'recovery-required'; throw error; }
      this.#retired = true; this.status = 'closed';
    });
  }
  bundle() {
    const payload = { format: FORMAT, logical: exportLogical(this.state),
      ledger: structuredClone([...this.ledger]), markers: recoveryMarkers(this.state), journal: structuredClone(this.journal) };
    return freeze({ ...payload, checksum: hash(payload) });
  }
}

// This is a small diagnostic package, not a future full-product backup format.
export function inspectBundle(bundle) {
  const { checksum, ...payload } = bundle;
  check(hash(payload) === checksum && payload.format === FORMAT, 'NEEDS_RESOLUTION', 'Invalid P2 bundle');
  bounded(importLogical(payload.logical));
  check(equal(payload.markers, recoveryMarkers(payload.logical.state)), 'NEEDS_RESOLUTION', 'Invalid recovery markers');
  check(Array.isArray(payload.ledger) && payload.ledger.length <= LIMITS.commits &&
    new Set(payload.ledger.map(([id]) => id)).size === payload.ledger.length,
  'NEEDS_RESOLUTION', 'Invalid recovery ledger');
  check(Array.isArray(payload.journal) && payload.journal.length === payload.ledger.length,
    'NEEDS_RESOLUTION', 'Missing replay journal');
  let state = emptyState(); const ledger = new Map();
  for (const request of payload.journal) {
    check(!ledger.has(request.operation_id), 'NEEDS_RESOLUTION', 'Duplicate journal operation');
    state = apply(state, request);
    ledger.set(request.operation_id, { checksum: hash(request), result: request.result });
  }
  check(equal(state, payload.logical.state) && equal([...ledger], payload.ledger),
    'NEEDS_RESOLUTION', 'Journal, logical state and idempotency ledger disagree');
  return freeze(structuredClone(payload));
}

export function importIntoEmpty(owner, bundle) {
  // Validate everything before touching even the staging target.
  const payload = inspectBundle(bundle);
  return owner.queue(async () => {
    check(owner.status === 'ready' && owner.tip === null && owner.nextId === 1,
      'IMPORT_TARGET_NOT_EMPTY', 'Use a newly opened dedicated namespace');
    try {
      owner.staging = true;
      await owner.io.put(0, { format: FORMAT, kind: 'root', tip: null, staging: true });
      await owner.io.flush();
      for (const request of payload.journal) await owner.commit(request);
      check(equal(owner.state, payload.logical.state), 'NEEDS_RESOLUTION', 'Import state mismatch');
      await owner.boundary('import-activate', async () => {
        await owner.io.put(0, { format: FORMAT, kind: 'root', tip: owner.tip, staging: false });
        await owner.io.flush();
      });
      owner.staging = false;
      return owner.handle();
    } catch (error) { owner.status = 'recovery-required'; throw error; }
  });
}
