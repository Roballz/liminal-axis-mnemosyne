import { canonicalize, equal, fingerprint, freeze, id, requireThat } from './primitives.mjs';
import { validate } from './schema.mjs';
import { TABLES, checkEntries, checkFork, checkTransition, expand, get, history } from './history.mjs';
import { checkMemory } from './memory.mjs';

function acyclic(table, key, parent, path = new Set()) {
  requireThat(!path.has(key), 'NEEDS_RESOLUTION', 'History/branch cycle');
  path.add(key);
  const next = parent(get(table, key));
  if (next) acyclic(table, next, parent, path);
  path.delete(key);
}
export function validateState(state) {
  canonicalize(state);
  requireThat(state !== null && typeof state === 'object' && !Array.isArray(state) && state.schema_version === 1 &&
    equal(Object.keys(state).sort(), ['schema_version', ...Object.keys(TABLES), 'views'].sort()),
  'INVALID_SCHEMA', 'Unsupported state envelope');
  for (const [tableName, [type, keyField]] of Object.entries(TABLES)) {
    const table = state[tableName];
    requireThat(table && typeof table === 'object' && !Array.isArray(table), 'INVALID_SCHEMA', 'Invalid table');
    for (const [key, value] of Object.entries(table)) {
      validate(type, value);
      requireThat(value[keyField] === key, 'NEEDS_RESOLUTION', 'Table key mismatch');
    }
  }
  for (const message of Object.values(state.messages)) get(state.stories, message.story_id);
  for (const revision of Object.values(state.revisions)) {
    get(state.messages, revision.message_id);
    requireThat(revision.content_fingerprint === fingerprint('content', { role: revision.role, content: revision.content }),
      'NEEDS_RESOLUTION', 'Content fingerprint mismatch');
    if (revision.provenance.binding_id) requireThat(get(state.bindings, revision.provenance.binding_id).story_id ===
      get(state.messages, revision.message_id).story_id, 'NEEDS_RESOLUTION', 'Revision binding crosses story');
  }
  for (const key of Object.keys(state.blocks)) {
    const entries = expand(state, key);
    const seen = new Set();
    for (const ref of entries) {
      get(state.messages, ref.message_id);
      requireThat(get(state.revisions, ref.revision_id).message_id === ref.message_id &&
        !seen.has(ref.message_id), 'NEEDS_RESOLUTION', 'Invalid block source');
      seen.add(ref.message_id);
    }
  }
  for (const branch of Object.values(state.branches)) {
    get(state.stories, branch.story_id);
    const head = get(state.snapshots, branch.head_snapshot_id);
    requireThat(head.branch_id === branch.branch_id && head.story_id === branch.story_id,
      'NEEDS_RESOLUTION', 'Head owner mismatch');
    acyclic(state.branches, branch.branch_id, b => b.fork?.parent_branch_id);
    if (branch.fork) checkFork(state, branch.story_id, branch.branch_id, branch.fork);
    const retained = new Set();
    let cursor = branch.head_snapshot_id;
    while (cursor && !retained.has(cursor)) {
      retained.add(cursor);
      cursor = get(state.snapshots, cursor).previous_snapshot_id;
    }
    requireThat(Object.values(state.snapshots).filter(s => s.branch_id === branch.branch_id)
      .every(s => retained.has(s.snapshot_id)), 'NEEDS_RESOLUTION', 'Disconnected committed snapshot');
  }
  for (const snapshot of Object.values(state.snapshots)) {
    const branch = get(state.branches, snapshot.branch_id);
    const entries = history(state, snapshot.snapshot_id);
    requireThat(branch.story_id === snapshot.story_id && entries.length === snapshot.message_count,
      'NEEDS_RESOLUTION', 'Snapshot owner/count mismatch');
    checkEntries(state, snapshot.story_id, entries);
    acyclic(state.snapshots, snapshot.snapshot_id, s => s.previous_snapshot_id);
    if (snapshot.previous_snapshot_id) {
      const previous = get(state.snapshots, snapshot.previous_snapshot_id);
      requireThat(previous.branch_id === snapshot.branch_id && !['init', 'fork'].includes(snapshot.change_kind),
        'NEEDS_RESOLUTION', 'Previous snapshot owner/kind mismatch');
      checkTransition(state, snapshot.change_kind, history(state, previous.snapshot_id), entries);
      if (snapshot.change_kind === 'restore') {
        let cursor = previous.snapshot_id, matched = false;
        while (cursor) {
          if (equal(history(state, cursor), entries)) matched = true;
          cursor = get(state.snapshots, cursor).previous_snapshot_id;
        }
        requireThat(matched, 'NEEDS_RESOLUTION', 'Restore target not in retained past');
      }
    } else {
      requireThat(branch.fork ? snapshot.change_kind === 'fork' &&
        equal(entries, checkFork(state, branch.story_id, branch.branch_id, branch.fork))
        : snapshot.change_kind === 'init', 'NEEDS_RESOLUTION', 'Invalid initial snapshot');
    }
    const operation = get(state.operations, snapshot.operation_id);
    requireThat(operation.snapshot_id === snapshot.snapshot_id, 'NEEDS_RESOLUTION', 'Snapshot operation mismatch');
  }
  for (const operation of Object.values(state.operations)) {
    const command = operation.command;
    const snapshot = get(state.snapshots, operation.snapshot_id);
    requireThat(command.operation_id === operation.operation_id &&
      operation.payload_fingerprint === fingerprint('write-payload', command) &&
      snapshot.story_id === command.story_id && snapshot.branch_id === command.branch_id &&
      equal(history(state, snapshot.snapshot_id), command.entries), 'NEEDS_RESOLUTION', 'Operation payload/result mismatch');
    if (snapshot.operation_id === operation.operation_id) {
      requireThat(snapshot.previous_snapshot_id === command.expected_head &&
        snapshot.change_kind === command.change_kind && snapshot.created_at === command.created_at &&
        equal(command.fork, snapshot.change_kind === 'fork' ? state.branches[snapshot.branch_id].fork : null),
      'NEEDS_RESOLUTION', 'Operation transition mismatch');
    } else requireThat(command.change_kind === 'import' && command.expected_head === snapshot.snapshot_id,
      'NEEDS_RESOLUTION', 'Only exact reimport may reuse a snapshot');
    command.messages.forEach(m => requireThat(equal(get(state.messages, m.message_id), m),
      'NEEDS_RESOLUTION', 'Operation message mismatch'));
    command.revisions.forEach(r => requireThat(equal(get(state.revisions, r.revision_id), r),
      'NEEDS_RESOLUTION', 'Operation revision mismatch'));
  }
  for (const memory of Object.values(state.memories)) {
    checkMemory(state, memory);
    requireThat(Object.values(state.memories).filter(m => m.memory_id === memory.memory_id)
      .every(m => m.story_id === memory.story_id && m.kind === memory.kind),
    'NEEDS_RESOLUTION', 'Memory family mismatch');
  }
  requireThat(state.views && !Array.isArray(state.views) &&
    equal(Object.keys(state.views).sort(), Object.keys(state.branches).sort()), 'NEEDS_RESOLUTION', 'Missing/extra branch view');
  for (const [branchId, view] of Object.entries(state.views)) {
    id('branch', branchId);
    validate('view', view);
    for (const [memoryId, revisionId] of Object.entries(view.selections)) {
      const memory = get(state.memories, revisionId);
      requireThat(memory.memory_id === memoryId && memory.story_id === state.branches[branchId].story_id,
        'NEEDS_RESOLUTION', 'Wrong selected memory owner');
    }
  }
  requireThat(new Set(Object.values(state.views).map(v => v.version)).size === Object.keys(state.views).length,
    'NEEDS_RESOLUTION', 'Duplicate active memory view ID');
  for (const binding of Object.values(state.bindings)) {
    requireThat(get(state.branches, binding.branch_id).story_id === binding.story_id &&
      new Set(binding.message_map.map(m => m.host_key)).size === binding.message_map.length &&
      new Set(binding.message_map.map(m => m.message_id)).size === binding.message_map.length,
    'NEEDS_RESOLUTION', 'Invalid binding mapping');
    binding.message_map.forEach(ref => requireThat(get(state.messages, ref.message_id).story_id === binding.story_id,
      'NEEDS_RESOLUTION', 'Binding source crosses story'));
  }
  return state;
}
export function exportLogical(state) {
  validateState(state);
  const payload = { format_version: 1, state: structuredClone(state) };
  return freeze({ ...payload, checksum: fingerprint('logical-export', payload) });
}
export function importLogical(bundle) {
  canonicalize(bundle);
  requireThat(bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle) &&
    equal(Object.keys(bundle).sort(), ['checksum', 'format_version', 'state']) &&
    bundle.format_version === 1, 'INVALID_SCHEMA', 'Unsupported logical package');
  requireThat(bundle.checksum === fingerprint('logical-export',
    { format_version: bundle.format_version, state: bundle.state }), 'NEEDS_RESOLUTION', 'Export checksum mismatch');
  return freeze(structuredClone(validateState(bundle.state)));
}
