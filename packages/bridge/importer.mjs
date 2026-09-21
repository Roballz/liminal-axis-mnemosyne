import { newId, equal, requireThat as check } from '../contracts/primitives.mjs';
import { recordKey, digest } from './records.mjs';
import { restrictSnapshot } from './source.mjs';

const now = () => new Date().toISOString();
const key = (type, source, floor = '') => recordKey(type, floor === '' ? source : `${source}/${floor}`);
const contentHash = m => digest({ role: m.role, content: m.content });
const targetOf = async (h, branch_id) => {
  const diagnostic = await h.diagnostics(branch_id);
  return { story_id: diagnostic.branch.story_id, branch_id, head: diagnostic.branch.head_snapshot_id, view: diagnostic.branch.view_version };
};
function command(operation_id, target, change_kind, start, delete_count, entries, messages = [], revisions = [], fork = null) {
  return { operation_id, story_id: target.story_id, branch_id: target.branch_id, expected_head: target.head,
    change_kind, splice: { start, delete_count, entries }, messages, revisions, fork, created_at: now() };
}
const guardOf = t => ({ branch_id: t.branch_id, head: t.head, view: t.view });

export class Importer {
  constructor(handle, sourceGuard = async () => {}) { this.h = handle; this.sourceGuard = sourceGuard; this.epoch = 0; this.busy = false; }
  cancel() { this.epoch++; }
  async record(type, source, floor = '') { return this.h.bridgeRead(key(type, source, floor)); }
  async putRecord(type, source, value, floor = '') {
    const k = key(type, source, floor), old = await this.h.bridgeRead(k);
    return { key: k, expected: old ? digest(old) : null, value };
  }
  async transact({ target = null, history = null, binding = null, records = [], operation_id = newId('operation') }) {
    const input = { kind: 'bridge', operation_id, payload: { version: 1, guard: target ? guardOf(target) : null, history, binding, records } };
    await this.h.prepare(input); return this.h.execute(operation_id);
  }
  // Called only after coordinator.recover(). A durable prepared request has already
  // been authorized; finish that exact request before creating any new work.
  async recoverPending() {
    const pending = await this.h.pending();
    for (const p of pending) {
      check(p.input.kind === 'bridge', 'PENDING_OPERATION', 'Another subsystem owns pending work');
      await this.h.execute(p.input.operation_id);
    }
  }
  async preview(input, choice = { mode: 'new' }, categories = []) {
    await this.sourceGuard(input);
    const bound = await this.record('binding', input.source);
    const sourceFingerprint=input.fingerprint;
    const inputLimit=!bound&&choice.mode==='fork'?choice.cutoff:null;
    if(inputLimit!==null)input=restrictSnapshot(input,inputLimit);
    let target = null, inherited = [], fork = null;
    if (bound) {
      target = await targetOf(this.h, bound.target.branch_id);
      check(equal(target, bound.target), 'VERSION_CONFLICT', 'Target advanced outside this binding; explicitly repair mapping');
    } else if (choice.mode !== 'new') {
      check(['continue','fork','mapping'].includes(choice.mode), 'INVALID_SCHEMA', 'Explicit inheritance intent required');
      target = await targetOf(this.h, choice.branch_id);
      const snap = await this.h.read('snapshots', choice.snapshot_id ?? target.head);
      check(snap.branch_id === choice.branch_id, 'INVALID_SCHEMA', 'Inheritance snapshot owner');
      if (choice.mode !== 'fork') check(snap.snapshot_id === target.head, 'VERSION_CONFLICT', 'Continue from current Head only');
      const count = choice.mode === 'fork' ? choice.cutoff : snap.message_count;
      check(Number.isSafeInteger(count) && count >= 0 && count <= snap.message_count, 'INVALID_SCHEMA', 'Explicit inclusive cutoff length required');
      for (let start = 0; start < count; start += 64) inherited.push(...await this.h.range(snap.snapshot_id, start, Math.min(64, count - start)));
      if (choice.mode === 'fork') fork = { parent_branch_id: choice.branch_id, source_snapshot_id: snap.snapshot_id,
        prefix_length: count, anchor: inherited.at(-1) ?? null };
    }
    const old = [];
    if (bound) for (let i = 0; i < bound.count; i++) {
      const m = await this.record('map', input.source, i);
      check(m, 'NEEDS_RESOLUTION', 'Missing source mapping'); old.push(m);
    }
    else for (let i = 0; i < inherited.length; i++) {
      const r = await this.h.read('revisions', inherited[i].revision_id);
      old.push({ ref: inherited[i], fingerprint: contentHash(r), candidates: [] });
    }
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(old.length, input.messages.length) && old[prefix].fingerprint === contentHash(input.messages[prefix])) prefix++;
    while (suffix < Math.min(old.length, input.messages.length) - prefix &&
      old[old.length - suffix - 1].fingerprint === contentHash(input.messages[input.messages.length - suffix - 1])) suffix++;
    // An empty continuation file means a new host window, not deletion of inherited history.
    const offset = bound?.offset ?? (!bound && choice.mode === 'continue' && input.messages.length === 0 ? inherited.length : 0);
    if(!bound && offset)old.length=0;
    const same = bound?.fingerprint === input.fingerprint;
    const report = { originals: input.messages.length, summaries: input.assets.filter(a => ['summary','higher'].includes(a.category)).length,
      optional: input.assets.filter(a => !['summary','higher'].includes(a.category)).length, reused: prefix + suffix,
      changed: input.messages.length - prefix - suffix, removed: old.length - prefix - suffix,
      source_unproven: input.assets.length, sourceReport: input.report,
      needs_confirmation: !same, paused: bound?.status === 'paused', same: Boolean(same) };
    return { input: structuredClone(input), choice: structuredClone(choice), categories: [...categories], bound, target, old,
      prefix, suffix, offset, fork, report, inputLimit, sourceFingerprint, epoch: this.epoch };
  }
  async confirm(plan) {
    check(!this.busy, 'INVALID_TRANSITION', 'Bridge busy');
    check(plan.epoch === this.epoch, 'VERSION_CONFLICT', 'Cancelled preview');
    await this.sourceGuard(plan.input);
    const latest = await this.record('binding', plan.input.source);
    check(equal(latest, plan.bound), 'VERSION_CONFLICT', 'Binding changed during preview');
    if (plan.target) check(equal(await targetOf(this.h, plan.target.branch_id), plan.target), 'VERSION_CONFLICT', 'Target changed during preview');
    if (plan.report.same && latest.status === 'complete') return latest;
    if (latest) {
      const session = await this.record('session', latest.session);
      if(session.cursor<session.total || session.assetCursor<session.assetTotal || session.reason.phase==='messages') {
        check(session.fingerprint === plan.input.fingerprint, 'VERSION_CONFLICT', 'Partial import requires original fixed input; preserve completed batches');
        if(session.status==='paused')await this.setState(latest.source,'partial','confirmed-original-input');
        return this.resume(session.id, plan.input);
      }
    }
    this.busy = true;
    try {
      const id = newId('operation');
      let target = plan.target;
      const create = !target || plan.choice.mode === 'fork' && !plan.bound;
      if (create) target = { story_id: target?.story_id ?? newId('story'), branch_id: newId('branch'), head: null, view: null };
      const session = { version: 1, type: 'session', id, source: plan.input.source, fingerprint: plan.input.fingerprint,
        categories: plan.categories, target, status: 'importing', cursor: 0, total: plan.input.messages.length,
        assetCursor: 0, assetTotal: plan.input.assets.length, generation: (latest?.generation ?? 0) + 1,
        reason: { prefix: plan.prefix, suffix: plan.suffix, oldCount: plan.old.length, offset: plan.offset,
          phase: 'messages', deleted: false, base: plan.target?.head ?? null, inputLimit:plan.inputLimit }, report: plan.report, created_at: now() };
      const bound = { version: 1, type: 'binding', source: session.source, binding_id: latest?.binding_id ?? newId('binding'), target, session: id,
        fingerprint: latest?.fingerprint ?? null, count: latest?.count ?? 0, offset: plan.offset, status: 'importing', sync: latest?.sync ?? false,
        generation: session.generation, reason: null };
      // Materialize the confirmed original map once for inheritance; subsequent
      // batches read only their local map, never copy the archive or command history.
      const operation_id = newId('operation');
      const history = create ? command(operation_id, target, plan.fork ? 'fork' : 'init', plan.fork?.prefix_length ?? 0, 0, [], [], [], plan.fork) : null;
      const formal = {schema_version:1,binding_id:bound.binding_id,story_id:target.story_id,branch_id:target.branch_id,
        host_kind:'TT',host_scope:session.source,stable_id:null,mutable_ref:null,binding_generation:session.generation,
        intent:latest?'confirmed_mapping':plan.fork?'fork':plan.choice.mode==='new'?'new_story':'carryover',message_map:[]};
      await this.transact({ operation_id, target, history, binding:formal, records: [
        await this.putRecord('session', id, session), await this.putRecord('binding', session.source, bound),
      ] });
      // Fixed base snapshot is sufficient to recover inheritance maps after interruption.
      return await this.run(id, plan.input, plan.epoch);
    } finally { this.busy = false; }
  }
  async resume(id, input) {
    check(!this.busy, 'INVALID_TRANSITION', 'Bridge busy'); this.busy = true;
    try {
      const s=await this.record('session',id);
      if(s?.reason.inputLimit!==null&&s?.reason.inputLimit!==undefined)input=restrictSnapshot(input,s.reason.inputLimit);
      return await this.run(id, input, this.epoch);
    } finally { this.busy = false; }
  }
  async run(id, input, epoch) {
    let session = await this.record('session', id);
    check(session?.fingerprint === input.fingerprint && session.source === input.source, 'VERSION_CONFLICT', 'Fixed import input changed');
    check(session.status !== 'paused', 'NOT_READY', 'Resolve paused input explicitly');
    while (session.status !== 'complete') {
      if (epoch !== this.epoch) { await this.setState(session.source, 'partial', 'cancelled-after-confirmed-batches'); return this.record('binding', session.source); }
      await this.sourceGuard(input);
      check(equal(await targetOf(this.h, session.target.branch_id), session.target), 'VERSION_CONFLICT', 'Import target changed');
      if (session.reason.phase === 'messages') await this.messageBatch(session, input);
      else await this.assetBatch(session, input);
      session = await this.record('session', id);
      try { await this.sourceGuard(input); }
      catch(error) {
        await this.setState(session.source,epoch===this.epoch?'paused':'partial','source-changed-after-durable-batch');
        throw error;
      }
    }
    return this.record('binding', session.source);
  }
  async originalMap(s, index) {
    if (s.reason.base && s.reason.oldCount) {
      const refs = await this.h.range(s.reason.base, index + s.reason.offset, 1);
      if (refs.length) return { ref: refs[0] };
    }
    return this.record('map', s.source, index);
  }
  async messageBatch(s, input) {
    const next = structuredClone(s), bound = await this.record('binding', s.source), records = [], entries = [], messages = [], revisions = [];
    const start = s.cursor, end = Math.min(start + 16, s.total);
    const changeEnd = s.total - s.reason.suffix;
    let spliceStart = null, remove = 0;
    for (let i = start; i < end; i++) {
      const m = input.messages[i]; let ref;
      if (i < s.reason.prefix || i >= changeEnd) {
        const oldIndex = i < s.reason.prefix ? i : s.reason.oldCount - (s.total - i);
        ref = (await this.originalMap(s, oldIndex))?.ref;
        check(ref, 'NEEDS_RESOLUTION', 'Missing exact reusable source');
      } else {
        if (spliceStart === null) spliceStart = i;
        const message_id = newId('message'), revision_id = newId('revision'); ref = { message_id, revision_id };
        messages.push({schema_version: 1, message_id, story_id: s.target.story_id});
        revisions.push({ schema_version: 1, revision_id, message_id, role: m.role, content: m.content,
          content_fingerprint: (await import('../contracts/primitives.mjs')).fingerprint('content', { role: m.role, content: m.content }),
          provenance: { host_kind: 'TT', binding_id: null, host_scope: s.source, stable_id: null, mutable_ref: null,
            observed_index: i, import_batch: s.id, operation: 'readonly-import' } });
        entries.push(ref);
      }
      records.push(await this.putRecord('map', s.source, {version: 1, type: 'map', source: s.source, floor: i, ref,
        fingerprint: contentHash(m), candidates: { values: m.candidates, selected: m.selected }}, i));
    }
    const operation_id = newId('operation'); let history = null;
    if (!s.reason.deleted && (spliceStart !== null || end >= s.reason.prefix)) {
      remove = s.reason.oldCount - s.reason.prefix - s.reason.suffix;
      next.reason.deleted = true;
      if (remove) spliceStart ??= s.reason.prefix;
    }
    if (spliceStart !== null) history = command(operation_id, s.target, 'import', spliceStart + s.reason.offset, remove, entries, messages, revisions);
    next.cursor = end;
    if (end === s.total) next.reason.phase = 'assets';
    bound.count = end; bound.status = 'importing'; next.status = 'importing';
    records.push(await this.putRecord('session', s.id, next), await this.putRecord('binding', s.source, bound));
    await this.transact({ operation_id, target: s.target, history, records });
  }
  async assetBatch(s, input) {
    const next = structuredClone(s), bound = await this.record('binding', s.source), records = [];
    const end = Math.min(s.assetCursor + 16, s.assetTotal);
    for (let i = s.assetCursor; i < end; i++) {
      const a = input.assets[i], assetId = digest({ source: s.source, id: a.source_id }), hash = digest(a.data);
      const map = await this.record('assetMap', assetId);
      if (map?.fingerprint === hash) continue;
      const versionId = digest({ assetId, hash, branch: s.target.branch_id });
      const asset = { version: 1, type: 'asset', source: s.source, source_id: a.source_id, category: a.category,
        fingerprint: hash, data: a.data, declaration: 'legacy-inputs-unproven',
        scope: { story_id: s.target.story_id, branch_id: s.target.branch_id, snapshot_id: s.target.head },
        anchor: a.anchor, previous: map?.asset ?? null };
      const existing = await this.record('asset', versionId);
      if (!existing) records.push(await this.putRecord('asset', versionId, asset));
      records.push(await this.putRecord('assetMap', assetId, {version: 1, type: 'assetMap', asset: versionId, fingerprint: hash}));
    }
    next.assetCursor = end;
    if (end === s.assetTotal) {
      next.status = 'complete'; bound.status = 'complete'; bound.fingerprint = s.fingerprint; bound.reason = null;
    }
    records.push(await this.putRecord('session', s.id, next), await this.putRecord('binding', s.source, bound));
    await this.transact({ target: s.target, records });
  }
  async setState(source, status, reason) {
    const bound = await this.record('binding', source); if (!bound) return null;
    const s = await this.record('session', bound.session);
    bound.status = status; bound.reason = reason; s.status = status;
    // Keep resumable plan separately; a warning cannot destroy its cursor.
    await this.transact({ target: bound.target, records: [await this.putRecord('binding', source, bound), await this.putRecord('session', s.id, s)] });
    return this.record('binding', source);
  }
  async enableSync(source, enabled) {
    const bound = await this.record('binding', source);
    check(bound && (!enabled || bound.status === 'complete'), 'NOT_READY', 'Finish/resolve import first');
    bound.sync = Boolean(enabled);
    await this.transact({ target: bound.target, records: [await this.putRecord('binding', source, bound)] });
  }
  async applyLocal(change, kind) {
    check(!this.busy,'NOT_READY','Import active');
    const bound = await this.record('binding',change.source);
    check(bound?.sync && (bound.status === 'complete' || bound.status === 'pending' && kind === 'regenerate'),
      'NOT_READY','Resolve paused binding first');
    check(equal(await targetOf(this.h,bound.target.branch_id),bound.target),'VERSION_CONFLICT','Local target changed');
    await this.sourceGuard(change);
    for(const neighbor of change.neighbors) {
      if(neighbor.floor >= bound.count) continue;
      const mapped=await this.record('map',change.source,neighbor.floor);
      check(mapped?.fingerprint===contentHash(neighbor),'VERSION_CONFLICT','Neighbor evidence differs');
    }
    const append=kind==='append';
    check(append ? change.start===bound.count && change.total===bound.count+change.messages.length && change.messages.length>0 :
      ['edit','swipe','regenerate'].includes(kind) && change.total===bound.count && change.messages.length===1 && change.start<bound.count,
    'VERSION_CONFLICT','Local event range does not match binding');
    const records=[],entries=[],messages=[],revisions=[];
    const {fingerprint}=await import('../contracts/primitives.mjs');
    for(const m of change.messages) {
      const mapped=append?null:await this.record('map',change.source,m.floor);
      if(mapped?.fingerprint===contentHash(m)) {
        mapped.candidates={values:m.candidates,selected:m.selected};
        records.push(await this.putRecord('map',change.source,mapped,m.floor));
        continue;
      }
      const prior=mapped?await this.h.read('revisions',mapped.ref.revision_id):null;
      check(!prior || prior.role===m.role,'VERSION_CONFLICT','Role/identity requires manual confirmation');
      const message_id=mapped?.ref.message_id??newId('message'),revision_id=newId('revision');
      if(!mapped) messages.push({schema_version:1,message_id,story_id:bound.target.story_id});
      const ref={message_id,revision_id}; entries.push(ref);
      revisions.push({schema_version:1,revision_id,message_id,role:m.role,content:m.content,
        content_fingerprint:fingerprint('content',{role:m.role,content:m.content}),
        provenance:{host_kind:'TT',binding_id:null,host_scope:change.source,stable_id:null,mutable_ref:null,
          observed_index:m.floor,import_batch:bound.session,operation:kind}});
      records.push(await this.putRecord('map',change.source,{version:1,type:'map',source:change.source,floor:m.floor,ref,
        fingerprint:contentHash(m),candidates:{values:m.candidates,selected:m.selected}},m.floor));
    }
    bound.count=change.total; bound.fingerprint=null; bound.status='complete'; bound.reason=null;
    records.push(await this.putRecord('binding',change.source,bound));
    const operation_id=newId('operation');
    await this.sourceGuard(change);
    await this.transact({operation_id,target:bound.target,
      history:entries.length?command(operation_id,bound.target,kind,change.start+bound.offset,append?0:1,entries,messages,revisions):null, records});
    try { await this.sourceGuard(change); }
    catch(error) { await this.setState(change.source,'paused','source-changed-during-local-publication');throw error; }
    return this.record('binding',change.source);
  }
  async reconcile(input, evidence = null) {
    const bound = await this.record('binding', input.source);
    check(bound, 'NOT_READY', 'Confirm binding first');
    if (evidence?.generating) return this.setState(input.source, 'pending', 'generation-in-progress');
    const plan = await this.preview(input);
    if (plan.report.same && bound.status === 'complete') return bound;
    const append = plan.prefix === bound.count && input.messages.length > bound.count;
    // Arbitrary manual/late reads are proposals. Only a stable event-correlated
    // append is automatic here; local edit uses the bounded entry point below.
    if (bound.sync && bound.status === 'complete' && evidence?.append === true && append) return this.confirm(plan);
    if (bound.status !== 'paused') await this.setState(input.source, 'paused', {kind: 'manual-review', ...plan.report});
    return { status: 'paused', plan };
  }
  async localEdit(input, floor, kind = 'edit') {
    const bound = await this.record('binding', input.source);
    check(bound?.sync && bound.status === 'complete', 'NOT_READY', 'Binding sync paused/disabled');
    check(['edit','swipe','regenerate'].includes(kind) && input.messages.length === bound.count, 'INVALID_SCHEMA', 'Local edit evidence');
    const plan = await this.preview(input);
    check(plan.report.changed === 1 && plan.report.removed === 1 && plan.prefix === floor,
      'VERSION_CONFLICT', 'Event does not prove a single mapped edit');
    await this.sourceGuard(input);
    const old = await this.record('map', input.source, floor), m = input.messages[floor], operation_id = newId('operation');
    const prior = await this.h.read('revisions', old.ref.revision_id);
    check(prior.role === m.role, 'VERSION_CONFLICT', 'Role changed; confirm replacement');
    const revision_id = newId('revision'), ref = {message_id: old.ref.message_id, revision_id};
    const { fingerprint } = await import('../contracts/primitives.mjs');
    const revision = {...prior, revision_id, content: m.content, content_fingerprint: fingerprint('content', {role: m.role, content: m.content}),
      provenance: {...prior.provenance, operation: kind} };
    old.ref = ref; old.fingerprint = contentHash(m); old.candidates = {values: m.candidates, selected: m.selected};
    // Legacy changes still require an explicit scoped import; don't bless them on a text edit.
    bound.fingerprint = null;
    await this.transact({ operation_id, target: bound.target,
      history: command(operation_id, bound.target, kind, floor + bound.offset, 1, [ref], [], [revision]),
      records: [await this.putRecord('map', input.source, old, floor), await this.putRecord('binding', input.source, bound)] });
    return this.record('binding', input.source);
  }
}
