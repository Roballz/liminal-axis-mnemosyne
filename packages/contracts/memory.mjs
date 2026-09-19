import { canonicalize, equal, fingerprint, freeze, id, newId, put, requireThat } from './primitives.mjs';
import { coverageSchema, validate } from './schema.mjs';
import { checkEntries, get, history } from './history.mjs';

export function makeCoverage(entries, mode = 'interval', members = entries) {
  const positions = members.map(ref => entries.findIndex(x => equal(x, ref)));
  requireThat(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
    'NEEDS_RESOLUTION', 'Coverage members must be ordered unique sources');
  const start = positions[0], end = positions.at(-1);
  const observed_span = members.length ? entries.slice(start, end + 1) : [];
  requireThat(mode !== 'interval' || equal(observed_span, members),
    'NEEDS_RESOLUTION', 'Interval has omitted members');
  const result = { mode, members, boundary: members.length
    ? { start: members[0].message_id, end: members.at(-1).message_id } : null, observed_span };
  coverageSchema(result);
  return structuredClone(result);
}
export function derivedPayload(memory) {
  return {
    story_id: memory.story_id, kind: memory.kind, origin: memory.origin,
    input_refs: memory.input_refs, coverage: memory.coverage, recipe_id: memory.recipe_id,
    model_profile: memory.model_profile, source_declaration: memory.source_declaration,
    scope_branch_id: memory.scope_branch_id,
    // Derived-only has no source versions, so its explicit snapshot scope is part of the input.
    scope_snapshot_id: memory.origin === 'derived_only' ? memory.basis_snapshot_id : null,
  };
}
export const derivedFingerprint = memory => fingerprint('derived-input', derivedPayload(memory));

function inputsFitBasis(state, memory, basis, entries) {
  if (memory.origin === 'derived_only') {
    return memory.scope_branch_id === basis.branch_id && memory.basis_snapshot_id === basis.snapshot_id;
  }
  const coverage = memory.coverage;
  const start = entries.findIndex(x => x.message_id === coverage.boundary.start);
  const end = entries.findIndex(x => x.message_id === coverage.boundary.end);
  if (!equal(entries.slice(start, end + 1), coverage.observed_span)) return false;
  return memory.input_refs.every(ref => ref.type === 'source'
    ? entries.some(x => x.message_id === ref.message_id && x.revision_id === ref.revision_id)
    : inputsFitBasis(state, get(state.memories, ref.memory_revision_id), basis, entries));
}

export function checkMemory(state, memory, path = new Set()) {
  validate('memory', memory);
  const key = memory.memory_revision_id;
  requireThat(!path.has(key), 'NEEDS_RESOLUTION', 'Memory dependency cycle');
  path.add(key);
  const basis = get(state.snapshots, memory.basis_snapshot_id);
  requireThat(basis.story_id === memory.story_id && memory.input_fingerprint === derivedFingerprint(memory),
    'NEEDS_RESOLUTION', 'Memory basis/fingerprint mismatch');
  const entries = history(state, basis.snapshot_id);
  checkEntries(state, memory.story_id, memory.coverage.members);
  requireThat(equal(memory.coverage, makeCoverage(entries, memory.coverage.mode, memory.coverage.members)),
    'NEEDS_RESOLUTION', 'Coverage does not match historical basis');
  if (memory.origin === 'derived_only') {
    requireThat(memory.input_refs.length === 0 && memory.coverage.members.length === 0 &&
      memory.source_declaration !== null && memory.scope_branch_id === basis.branch_id,
    'NEEDS_RESOLUTION', 'Derived-only requires explicit scope and unavailable-source declaration');
  } else {
    requireThat(memory.input_refs.length > 0 && memory.coverage.members.length > 0 &&
      memory.source_declaration === null && memory.scope_branch_id === null,
    'NEEDS_RESOLUTION', 'Source-derived memory requires actual inputs and coverage');
    const evidence = new Set();
    for (const ref of memory.input_refs) {
      if (ref.type === 'source') {
        const source = { message_id: ref.message_id, revision_id: ref.revision_id };
        checkEntries(state, memory.story_id, [source]);
        requireThat(entries.some(x => equal(x, source)), 'NEEDS_RESOLUTION', 'Input outside historical basis');
        evidence.add(canonicalize(source));
      } else {
        const child = get(state.memories, ref.memory_revision_id);
        requireThat(child.memory_id === ref.memory_id && child.story_id === memory.story_id,
          'NEEDS_RESOLUTION', 'Wrong memory reference owner');
        checkMemory(state, child, path);
        requireThat(inputsFitBasis(state, child, basis, entries),
          'NEEDS_RESOLUTION', 'Dependency was not applicable to generation basis');
        child.coverage.members.forEach(source => evidence.add(canonicalize(source)));
      }
    }
    requireThat(memory.coverage.members.every(source => evidence.has(canonicalize(source))),
      'NEEDS_RESOLUTION', 'Coverage claims unread sources');
    if (memory.kind === 'TurnMemory') {
      const refs = memory.coverage.members;
      const index = entries.findIndex(x => equal(x, refs[0]));
      requireThat(memory.coverage.mode === 'interval' && refs.length === 2 &&
        equal(entries.slice(index, index + 2), refs) &&
        get(state.revisions, refs[0].revision_id).role === 'user' &&
        get(state.revisions, refs[1].revision_id).role === 'assistant',
      'UNSUPPORTED', 'TurnMemory requires an explicit adjacent User + Assistant pair');
    }
  }
  path.delete(key);
}
export function archiveMemory(original, memory) {
  const state = structuredClone(original);
  put(state.memories, memory.memory_revision_id, memory);
  checkMemory(state, memory);
  const family = Object.values(state.memories).filter(m => m.memory_id === memory.memory_id);
  requireThat(family.every(m => m.story_id === memory.story_id && m.kind === memory.kind),
    'NEEDS_RESOLUTION', 'Memory family owner/kind changed');
  return freeze(state);
}
export function selectMemory(original, branchId, revisionId, expectedView, makeId = newId) {
  const branch = get(original.branches, branchId);
  const memory = get(original.memories, revisionId);
  const view = get(original.views, branchId);
  requireThat(branch.story_id === memory.story_id && view.version === expectedView,
    'VERSION_CONFLICT', 'Memory view owner/version changed');
  if (view.selections[memory.memory_id] === revisionId) return original;
  const state = structuredClone(original);
  const version = id('memoryView', makeId('memoryView'));
  requireThat(Object.values(original.views).every(v => v.version !== version), 'ID_COLLISION', 'Memory view ID collision');
  state.views[branchId] = { version,
    selections: { ...view.selections, [memory.memory_id]: revisionId } };
  return freeze(state);
}
export function memoryStatus(state, revisionId, branchId, cutoffLength, path = new Set()) {
  const branch = get(state.branches, branchId);
  const full = history(state, branch.head_snapshot_id);
  const cutoff = cutoffLength ?? full.length;
  requireThat(Number.isSafeInteger(cutoff) && cutoff >= 0 && cutoff <= full.length,
    'INVALID_SCHEMA', 'Invalid recall cutoff');
  const entries = full.slice(0, cutoff);
  const memory = state.memories[revisionId];
  if (!memory || path.has(revisionId)) return 'needs-resolution';
  if (memory.story_id !== branch.story_id) return 'out-of-scope';
  try { checkMemory(state, memory); } catch { return 'needs-resolution'; }
  if (!memory.recall_enabled || memory.visibility === 'private') return 'excluded';
  if (memory.origin === 'derived_only') {
    return memory.scope_branch_id === branchId && memory.basis_snapshot_id === branch.head_snapshot_id &&
      cutoff === full.length ? 'valid' : 'out-of-scope';
  }
  path.add(revisionId);
  try {
    for (const ref of memory.input_refs) {
      if (ref.type === 'source') {
        if (!entries.some(x => x.message_id === ref.message_id && x.revision_id === ref.revision_id)) return 'needs-rebuild';
      } else {
        if (get(state.views, branchId).selections[ref.memory_id] !== ref.memory_revision_id) return 'needs-rebuild';
        const childStatus = memoryStatus(state, ref.memory_revision_id, branchId, cutoff, path);
        if (childStatus !== 'valid') return childStatus === 'needs-resolution' ? childStatus : 'needs-rebuild';
      }
    }
    const coverage = memory.coverage;
    if (!coverage.members.every(ref => entries.some(x => equal(x, ref)))) return 'needs-rebuild';
    const start = entries.findIndex(x => x.message_id === coverage.boundary.start);
    const end = entries.findIndex(x => x.message_id === coverage.boundary.end);
    const span = entries.slice(start, end + 1);
    if (!equal(span, coverage.observed_span)) return coverage.mode === 'members' ? 'needs-review' : 'needs-rebuild';
    return 'valid';
  } finally { path.delete(revisionId); }
}
export function rebuildPlan(state, branchId, cutoffLength) {
  const view = get(state.views, branchId), statuses = {}, rebuild = [], review = [], blocked = [];
  const visited = new Set();
  function visit(revisionId) {
    if (visited.has(revisionId)) return;
    visited.add(revisionId);
    const memory = state.memories[revisionId];
    for (const ref of memory?.input_refs ?? []) {
      if (ref.type === 'memory' && view.selections[ref.memory_id]) visit(view.selections[ref.memory_id]);
    }
    const status = memoryStatus(state, revisionId, branchId, cutoffLength);
    statuses[revisionId] = status;
    if (status === 'needs-rebuild') rebuild.push(revisionId);
    if (status === 'needs-review') review.push(revisionId);
    if (status === 'needs-resolution') blocked.push(revisionId);
  }
  Object.values(view.selections).forEach(visit);
  return { statuses, rebuild, review, blocked };
}
export function groupTurns(state, entries) {
  const turns = [], unresolved = [];
  let pending = null;
  for (let i = 0; i < entries.length;) {
    const role = get(state.revisions, entries[i].revision_id).role;
    const next = entries[i + 1] && get(state.revisions, entries[i + 1].revision_id).role;
    if (role === 'user' && next === 'assistant') { turns.push(entries.slice(i, i + 2)); i += 2; }
    else if (role === 'user' && i === entries.length - 1) { pending = entries[i++]; }
    else { unresolved.push(entries[i++]); }
  }
  // Unknown grouping is preserved wholesale; the tentative pairs are not auto-approved.
  return { status: unresolved.length ? 'unsupported' : pending ? 'pending' : 'ready',
    turns: unresolved.length ? [] : turns, pending, unresolved, sources: structuredClone(entries) };
}
