// P3 recovery prerequisite, deliberately retaining every P2 resource cap.
// This is an isolated diagnostic entry, not a production/maintenance-safe provider.
import { canonicalize, equal, fingerprint, freeze, id, newId, requireThat } from '../contracts/primitives.mjs';
import { archiveMemory, bindHost, commitHistory, correctMemory, selectMemory } from '../contracts/index.mjs';
import { emptyState } from '../contracts/history.mjs';
import { StoreOwner, LIMITS, prepareTransaction } from './protocol.mjs';

export const INTENT_FORMAT = 'mnemosyne-storage-intents-v1';
export const IDENTITY_SLOT = 8193;
const FIRST_INTENT = IDENTITY_SLOT + 1;
const hash = value => fingerprint('write-payload', value);
const check = requireThat;
const clone = value => freeze(structuredClone(value));
const bytes = value => new TextEncoder().encode(canonicalize(value)).length;
function fields(value, names) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    equal(Object.keys(value).sort(), [...names].sort()), 'INVALID_SCHEMA', 'Unexpected request fields');
}

// No arbitrary compiler callbacks, model calls, or business side effects.
// Every generated identity is captured before any domain publication can start.
function compile(state, input, replayIds = null) {
  fields(input, ['operation_id', 'kind', 'payload']); id('operation', input.operation_id);
  check(bytes(input) <= LIMITS.bytes, 'P2_LIMIT', 'Intent input limit');
  const generated = [];
  const makeId = kind => {
    const saved = replayIds?.[generated.length];
    check(replayIds === null || saved?.kind === kind, 'NEEDS_RESOLUTION', 'Generated identity sequence mismatch');
    const value = replayIds === null ? newId(kind) : id(kind, saved.value);
    generated.push({ kind, value }); return value;
  };
  let next, result;
  if (input.kind === 'history') {
    check(input.operation_id === input.payload.operation_id, 'INVALID_SCHEMA', 'History operation mismatch');
    const committed = commitHistory(state, input.payload, makeId);
    next = committed.state; result = { snapshot_id: committed.snapshot_id };
  } else if (input.kind === 'binding') {
    next = bindHost(state, input.payload);
    result = { binding_id: input.payload.binding_id, binding_generation: input.payload.binding_generation };
  } else if (input.kind === 'memory') {
    const p = input.payload;
    fields(p, ['archives', 'action', 'branch_id', 'revision_id', 'old_revision_id', 'expected_view', 'mode']);
    check(Array.isArray(p.archives) && ['archive', 'select', 'correct'].includes(p.action),
      'INVALID_SCHEMA', 'Unknown memory action');
    next = state;
    for (const memory of p.archives) next = archiveMemory(next, memory);
    if (p.action === 'archive') {
      check([p.branch_id, p.revision_id, p.old_revision_id, p.expected_view, p.mode].every(x => x === null),
        'INVALID_SCHEMA', 'Archive has no selection parameters');
      result = { archived: p.archives.map(m => m.memory_revision_id) };
    } else {
      if (p.action === 'select') {
        check(p.old_revision_id === null, 'INVALID_SCHEMA', 'Select has no old revision argument');
        next = selectMemory(next, p.branch_id, p.revision_id, p.expected_view, makeId, p.mode);
      } else {
        check(p.mode === null, 'INVALID_SCHEMA', 'Correction has no selection mode');
        next = correctMemory(next, p.branch_id, p.old_revision_id, p.revision_id, p.expected_view, makeId);
      }
      result = { branch_id: p.branch_id, version: next.views[p.branch_id].version };
    }
  } else check(false, 'INVALID_SCHEMA', 'Unknown durable request kind');
  check(replayIds === null || equal(generated, replayIds), 'NEEDS_RESOLUTION', 'Unused generated identities');
  return { request: prepareTransaction(state, next, input.operation_id, result), generated, state: next };
}

function validateIntent(record) {
  fields(record, ['format', 'kind', 'sequence', 'previous', 'input', 'compiled', 'generated', 'checksum']);
  const { checksum, ...body } = record;
  check(body.format === INTENT_FORMAT && body.kind === 'intent' && hash(body) === checksum &&
    Number.isSafeInteger(body.sequence) && body.sequence >= 0 && body.sequence < LIMITS.commits &&
    (body.previous === null || typeof body.previous === 'string') && Array.isArray(body.generated) &&
    bytes(record) <= LIMITS.bytes * 2, 'NEEDS_RESOLUTION', 'Invalid durable intent');
  fields(body.input, ['operation_id', 'kind', 'payload']); id('operation', body.input.operation_id);
  check(body.compiled.operation_id === body.input.operation_id &&
    ['history', 'memory', 'binding'].includes(body.input.kind), 'NEEDS_RESOLUTION', 'Intent/request mismatch');
  body.generated.forEach(item => { fields(item, ['kind', 'value']); id(item.kind, item.value); });
  return record;
}

// All runtime state and IO are private. The sole public data entry is handle().
export class IntentCoordinator {
  #io; #owner; #tail = Promise.resolve(); #status = 'recovery-required'; #epoch = 0;
  #identity = null; #records = []; #closed = false; #ticket = null;
  constructor(io) { this.#io = io; this.#owner = new StoreOwner(io); }
  get status() { return this.#status; }
  settled() { return this.#tail; }
  #queue(fn) { const p = this.#tail.then(fn); this.#tail = p.catch(() => {}); return p; }
  async #point(label, fn) {
    await this.#io.point?.(label, 'before'); const result = await fn();
    await this.#io.point?.(label, 'after'); return result;
  }
  #alive() { check(!this.#closed, 'OWNER_CLOSED', 'Coordinator permanently closed'); }
  async #identityCheck() {
    const record = await this.#io.get(IDENTITY_SLOT);
    check(record && record.format === INTENT_FORMAT && record.kind === 'identity' &&
      equal(Object.keys(record).sort(), ['format', 'kind', 'library_id']) &&
      typeof record.library_id === 'string', 'NEEDS_RESOLUTION', 'Missing/foreign library identity');
    id('operation', record.library_id); // Storage-local UUID, never a domain operation entry.
    check(this.#identity === null || equal(record, this.#identity), 'LIBRARY_CHANGED', 'Library identity changed');
    this.#identity = clone(record);
  }
  async #recover() {
    this.#alive(); this.#status = 'recovery-required'; this.#epoch++;
    await this.#io.reopen?.();
    await this.#identityCheck();
    if (this.#ticket) {
      check(equal(await this.#io.get(0), this.#ticket.root), 'LIBRARY_CHANGED', 'Published root changed during maintenance');
      const count = this.#ticket.intent_count;
      const tip = count ? await this.#io.get(FIRST_INTENT + count - 1) : null;
      check((tip?.checksum ?? null) === this.#ticket.intent_tip &&
        await this.#io.get(FIRST_INTENT + count) === null,
        'LIBRARY_CHANGED', 'Prepared work changed during maintenance');
    }
    await this.#owner.recover();
    const records = [], ids = new Set(); let previous = null;
    for (let i = 0; i <= LIMITS.commits; i++) {
      const record = await this.#io.get(FIRST_INTENT + i);
      if (record === null) break;
      validateIntent(record);
      check(record.sequence === i && record.previous === previous && !ids.has(record.input.operation_id),
        'NEEDS_RESOLUTION', 'Intent chain/identity conflict');
      ids.add(record.input.operation_id); records.push(clone(record)); previous = record.checksum;
    }
    // Published work must have exactly the same durable request. Pending work is
    // retained, never silently recompiled against a different Head/view/binding.
    for (const request of this.#owner.journal) {
      const record = records.find(r => r.input.operation_id === request.operation_id);
      check(record && equal(record.compiled, request), 'NEEDS_RESOLUTION', 'Published request missing its intent');
    }
    const pending = records.filter(r => !this.#owner.ledger.has(r.input.operation_id));
    check(pending.length <= 1 && (!pending.length || pending[0] === records.at(-1)),
      'NEEDS_RESOLUTION', 'Unresolved operation is not the final intent');
    let audited = emptyState();
    for (const record of records) {
      const rebuilt = compile(audited, record.input, record.generated);
      check(equal(rebuilt.request, record.compiled), 'NEEDS_RESOLUTION', 'Input/generated IDs disagree with compiled work');
      if (this.#owner.ledger.has(record.input.operation_id)) audited = rebuilt.state;
    }
    check(equal(audited, this.#owner.state), 'NEEDS_RESOLUTION', 'Intent/domain audit mismatch');
    this.#records = records; this.#status = 'ready';
    return this.handle();
  }
  // Explicit creation only; never retrofit an existing P2 namespace.
  create() {
    return this.#queue(async () => {
      this.#alive(); check(this.#identity === null, 'INVALID_TRANSITION', 'Already initialized');
      await this.#io.reopen?.();
      if (this.#io.assertEmpty) await this.#io.assertEmpty();
      else for (let i = 0; i <= FIRST_INTENT + LIMITS.commits; i++) {
        check(await this.#io.get(i) === null, 'IMPORT_TARGET_NOT_EMPTY', 'New isolated namespace required');
      }
      this.#identity = clone({ format: INTENT_FORMAT, kind: 'identity', library_id: newId('operation') });
      try {
        await this.#point('intent-identity', () => this.#io.put(IDENTITY_SLOT, this.#identity));
        await this.#io.flush();
        return await this.#recover();
      } catch (error) { this.#status = 'recovery-required'; throw error; }
    });
  }
  recover() {
    return this.#queue(() => {
      check(!this.#ticket, 'MAINTENANCE_REQUIRED', 'Use resume with the maintenance ticket');
      return this.#recover();
    });
  }
  handle() {
    const epoch = this.#epoch;
    const run = fn => {
      // Check both at admission and after waiting; suspension fences queued work.
      if (epoch !== this.#epoch) return Promise.reject(Object.assign(Error('Stale coordinator handle'), { code: 'STALE_HANDLE' }));
      return this.#queue(async () => {
        this.#alive(); check(epoch === this.#epoch, 'STALE_HANDLE', 'Coordinator generation changed');
        check(this.#status === 'ready', 'RECOVERY_REQUIRED', 'Resolve the pending native outcome first');
        try { await this.#identityCheck(); }
        catch (error) { this.#status = 'recovery-required'; throw error; }
        try { return await fn(); }
        catch (error) {
          if (['LIBRARY_CHANGED', 'NEEDS_RESOLUTION'].includes(error.code)) this.#status = 'recovery-required';
          throw error;
        }
      });
    };
    return Object.freeze({
      prepare: input => { const copy = structuredClone(input); return run(() => this.#prepare(copy)); },
      execute: operation => run(() => this.#execute(operation)),
      lookup: operation => run(() => this.#lookup(operation)),
      pending: () => run(() => clone(this.#records.filter(r => !this.#owner.ledger.has(r.input.operation_id))
        .map(r => this.#lookup(r.input.operation_id)))),
      read: () => run(() => this.#owner.handle().read()),
    });
  }
  #lookup(operation) {
    id('operation', operation);
    const record = this.#records.find(r => r.input.operation_id === operation);
    if (!record) return null;
    const result = this.#owner.ledger.get(operation);
    return clone({ status: result ? 'published' : 'prepared', input: record.input,
      input_fingerprint: hash(record.input), request: record.compiled,
      request_fingerprint: hash(record.compiled), generated: record.generated, result: result?.result ?? null });
  }
  async #prepare(input) {
    id('operation', input.operation_id);
    const old = this.#records.find(r => r.input.operation_id === input.operation_id);
    if (old) {
      check(equal(old.input, input), 'OPERATION_CONFLICT', 'Operation input changed');
      return this.#lookup(input.operation_id);
    }
    check(this.#records.every(r => this.#owner.ledger.has(r.input.operation_id)),
      'PENDING_OPERATION', 'Resolve durable prepared work before a competing request');
    check(this.#records.length < LIMITS.commits, 'P2_LIMIT', 'Intent prototype cap');
    const compiled = compile(this.#owner.state, input);
    const body = { format: INTENT_FORMAT, kind: 'intent', sequence: this.#records.length,
      previous: this.#records.at(-1)?.checksum ?? null, input, compiled: compiled.request, generated: compiled.generated };
    const record = { ...body, checksum: hash(body) }; validateIntent(record);
    try {
      const slot = FIRST_INTENT + record.sequence;
      check(await this.#io.get(slot) === null, 'NEEDS_RESOLUTION', 'Intent slot already occupied');
      await this.#point('intent-write', () => this.#io.put(slot, record));
      await this.#point('intent-flush', () => this.#io.flush());
      await this.#point('intent-ack', async () => {});
      this.#records.push(clone(record)); return this.#lookup(input.operation_id);
    } catch (cause) {
      this.#status = 'recovery-required';
      throw Object.assign(new Error('Preparation outcome unknown; recover and enumerate durable requests', { cause }),
        { code: 'RECOVERY_REQUIRED' });
    }
  }
  async #execute(operation) {
    const pending = this.#lookup(operation);
    check(pending, 'UNKNOWN_OPERATION', 'Prepare the request durably before execution');
    if (pending.status === 'published') return pending.result;
    try { return await this.#owner.handle().commit(pending.request); }
    catch (error) { this.#status = 'recovery-required'; throw error; }
  }
  async #checkpoint() {
    return clone({ identity: this.#identity, root: await this.#io.get(0),
      intent_count: this.#records.length, intent_tip: this.#records.at(-1)?.checksum ?? null });
  }
  // Cooperative maintenance only: the caller must await this before starting it.
  // This is NOT a subscription to TT sync/archive events or a native lease.
  suspend() {
    this.#epoch++;
    return this.#queue(async () => {
      this.#alive();
      check(!this.#ticket, 'MAINTENANCE_REQUIRED', 'Already suspended');
      this.#status = 'recovery-required';
      await this.#recover(); this.#status = 'maintenance';
      this.#ticket = await this.#checkpoint();
      await this.#io.close();
      return clone(this.#ticket);
    });
  }
  resume(ticket) {
    const copy = structuredClone(ticket);
    return this.#queue(async () => {
      this.#alive();
      check(this.#ticket && equal(copy, this.#ticket), 'MAINTENANCE_REQUIRED', 'Wrong maintenance ticket');
      await this.#recover();
      if (!equal(await this.#checkpoint(), copy)) {
        this.#status = 'recovery-required';
        check(false, 'LIBRARY_CHANGED', 'Maintenance replaced or rolled back the library');
      }
      this.#ticket = null; return this.handle();
    });
  }
  close() {
    this.#epoch++;
    return this.#queue(async () => {
      if (this.#closed) return;
      this.#status = 'recovery-required';
      await this.#io.close(); this.#closed = true; this.#status = 'closed';
    });
  }
}
