import { equal, fingerprint, freeze, id, newId, put, requireThat } from './primitives.mjs';
import { validate } from './schema.mjs';

export const TABLES = {
  stories: ['story', 'story_id'], branches: ['branch', 'branch_id'], messages: ['message', 'message_id'],
  revisions: ['revision', 'revision_id'], blocks: ['block', 'block_id'], snapshots: ['snapshot', 'snapshot_id'],
  memories: ['memory', 'memory_revision_id'], operations: ['operation', 'operation_id'],
  bindings: ['binding', 'binding_id'],
};
export function emptyState() {
  return freeze({ schema_version: 1, ...Object.fromEntries(Object.keys(TABLES).map(k => [k, {}])), views: {} });
}
export function get(table, key) {
  requireThat(Object.hasOwn(table, key), 'NEEDS_RESOLUTION', `Missing reference: ${key}`);
  return table[key];
}
export function expand(state, root, path = new Set()) {
  requireThat(!path.has(root), 'NEEDS_RESOLUTION', 'Manifest cycle');
  const block = get(state.blocks, root);
  validate('block', block);
  path.add(root);
  const entries = block.kind === 'leaf' ? block.entries : block.children.flatMap(child => {
    const part = expand(state, child.block_id, path);
    requireThat(part.length === child.message_count, 'NEEDS_RESOLUTION', 'Directory count mismatch');
    return part;
  });
  path.delete(root);
  return structuredClone(entries);
}
export function history(state, snapshotId) {
  return expand(state, get(state.snapshots, snapshotId).manifest_root_id);
}
export function checkEntries(state, storyId, entries) {
  const seen = new Set();
  for (const ref of entries) {
    const message = get(state.messages, ref.message_id);
    const revision = get(state.revisions, ref.revision_id);
    requireThat(!seen.has(ref.message_id) && message.story_id === storyId &&
      revision.message_id === ref.message_id, 'NEEDS_RESOLUTION', 'Duplicate or wrong-owner source');
    seen.add(ref.message_id);
  }
}
export function checkFork(state, storyId, branchId, fork) {
  const parent = get(state.branches, fork.parent_branch_id);
  const snapshot = get(state.snapshots, fork.source_snapshot_id);
  requireThat(parent.story_id === storyId && snapshot.story_id === storyId &&
    snapshot.branch_id === parent.branch_id && parent.branch_id !== branchId,
  'NEEDS_RESOLUTION', 'Wrong fork owner');
  const entries = history(state, snapshot.snapshot_id);
  requireThat(fork.prefix_length <= entries.length &&
    equal(fork.anchor, fork.prefix_length ? entries[fork.prefix_length - 1] : null),
  'NEEDS_RESOLUTION', 'Fork cutoff/anchor mismatch');
  return entries.slice(0, fork.prefix_length);
}
export function checkTransition(state, kind, before, after) {
  const sameIds = equal(before.map(x => x.message_id), after.map(x => x.message_id));
  const changed = before.filter((ref, i) => !equal(ref, after[i] ?? null));
  let legal = true;
  if (kind === 'append') legal = after.length > before.length && equal(before, after.slice(0, before.length));
  if (kind === 'edit' || kind === 'swipe' || kind === 'regenerate') {
    legal = sameIds && changed.length === 1;
    if (legal && kind !== 'edit') {
      const old = get(state.revisions, changed[0].revision_id);
      const current = after.find(x => x.message_id === changed[0].message_id);
      legal = old.role === 'assistant' && get(state.revisions, current.revision_id).role === 'assistant';
    }
  }
  if (kind === 'delete') {
    const kept = new Set(after.map(x => x.message_id));
    legal = after.length < before.length && equal(before.filter(x => kept.has(x.message_id)), after);
  }
  if (kind === 'reorder') {
    const sorted = entries => [...entries].sort((a, b) => a.message_id.localeCompare(b.message_id));
    legal = !equal(before, after) && equal(sorted(before), sorted(after));
  }
  requireThat(legal, 'INVALID_TRANSITION', `History does not match ${kind}`);
}

// Tiny oracle, not a production block tree: reuse exact leaf chunks and directory roots.
function manifest(state, entries, makeId) {
  const intern = body => {
    const existing = Object.values(state.blocks).find(b => {
      const { block_id, ...rest } = b;
      return equal(rest, body);
    });
    if (existing) return existing.block_id;
    const block_id = id('block', makeId('block'));
    put(state.blocks, block_id, { block_id, ...body });
    return block_id;
  };
  const leaves = [];
  for (let i = 0; i < entries.length; i += 2) {
    const part = entries.slice(i, i + 2);
    leaves.push({ block_id: intern({ schema_version: 1, kind: 'leaf', entries: part }), message_count: part.length });
  }
  if (!leaves.length) return intern({ schema_version: 1, kind: 'leaf', entries: [] });
  if (leaves.length === 1) return leaves[0].block_id;
  return intern({ schema_version: 1, kind: 'directory', children: leaves });
}
export function commitHistory(original, command, makeId = newId) {
  validate('command', command);
  const payload_fingerprint = fingerprint('write-payload', command);
  const previousOperation = original.operations[command.operation_id];
  // A committed retry must win over the now-stale expected head.
  if (previousOperation) {
    requireThat(previousOperation.payload_fingerprint === payload_fingerprint, 'OPERATION_CONFLICT', 'Operation payload changed');
    return { state: original, snapshot_id: previousOperation.snapshot_id };
  }
  const state = structuredClone(original);
  const { story_id, branch_id, change_kind, expected_head, fork } = command;
  let branch = state.branches[branch_id];
  if (!branch) {
    requireThat(expected_head === null && ['init', 'fork'].includes(change_kind),
      'HEAD_CONFLICT', 'New branch requires init/fork and null expected head');
    if (!state.stories[story_id]) {
      requireThat(change_kind === 'init', 'NEEDS_RESOLUTION', 'Fork story missing');
      put(state.stories, story_id, { schema_version: 1, story_id });
    }
    requireThat(change_kind === 'fork' ? fork !== null : fork === null,
      'INVALID_TRANSITION', 'Fork metadata required only for fork');
    if (fork) requireThat(equal(command.entries, checkFork(state, story_id, branch_id, fork)),
      'INVALID_TRANSITION', 'Initial child must equal fixed prefix');
    branch = { schema_version: 1, story_id, branch_id, head_snapshot_id: null, fork };
    put(state.branches, branch_id, branch);
    const version = id('memoryView', makeId('memoryView'));
    requireThat(Object.values(state.views).every(v => v.version !== version), 'ID_COLLISION', 'Memory view ID collision');
    state.views[branch_id] = { version,
      corrections: fork ? structuredClone(get(state.views, fork.parent_branch_id).corrections) : {},
      selections: fork ? structuredClone(get(state.views, fork.parent_branch_id).selections) : {} };
  } else {
    requireThat(branch.story_id === story_id && expected_head === branch.head_snapshot_id,
      'HEAD_CONFLICT', 'Expected head/owner changed', { story_id, branch_id });
    requireThat(!['init', 'fork'].includes(change_kind) && fork === null,
      'INVALID_TRANSITION', 'Existing branch cannot be initialized again');
  }
  command.messages.forEach(m => {
    requireThat(m.story_id === story_id, 'NEEDS_RESOLUTION', 'Wrong message story');
    put(state.messages, m.message_id, m);
  });
  command.revisions.forEach(r => {
    requireThat(get(state.messages, r.message_id).story_id === story_id &&
      r.content_fingerprint === fingerprint('content', { role: r.role, content: r.content }),
    'NEEDS_RESOLUTION', 'Wrong revision owner/content fingerprint');
    if (r.provenance.binding_id) requireThat(get(state.bindings, r.provenance.binding_id).story_id === story_id,
      'NEEDS_RESOLUTION', 'Revision binding crosses story');
    put(state.revisions, r.revision_id, r);
  });
  checkEntries(state, story_id, command.entries);
  const before = expected_head ? history(state, expected_head) : [];
  if (expected_head) checkTransition(state, change_kind, before, command.entries);
  if (change_kind === 'restore') {
    requireThat(Object.values(state.snapshots).some(s => s.branch_id === branch_id &&
      equal(history(state, s.snapshot_id), command.entries)), 'INVALID_TRANSITION', 'Restore requires retained branch history');
  }
  let snapshot_id = expected_head;
  if (!(change_kind === 'import' && expected_head && equal(before, command.entries))) {
    snapshot_id = id('snapshot', makeId('snapshot'));
    const manifest_root_id = manifest(state, command.entries, makeId);
    put(state.snapshots, snapshot_id, {
      schema_version: 1, snapshot_id, story_id, branch_id, previous_snapshot_id: expected_head,
      manifest_root_id, message_count: command.entries.length, change_kind,
      operation_id: command.operation_id, created_at: command.created_at,
    });
    state.branches[branch_id].head_snapshot_id = snapshot_id;
  }
  put(state.operations, command.operation_id, { operation_id: command.operation_id,
    payload_fingerprint, command, snapshot_id });
  return { state: freeze(state), snapshot_id };
}
