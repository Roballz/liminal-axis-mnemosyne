import { equal, fingerprint, freeze, put, requireThat } from './primitives.mjs';
import { validate } from './schema.mjs';
import { get, history } from './history.mjs';
import { memoryStatus } from './memory.mjs';

export function prepareFingerprint(request) {
  const { input_fingerprint, ...payload } = request;
  return fingerprint('prepare-input', payload);
}
export function checkPrepare(state, request) {
  validate('prepare', request);
  const branch = get(state.branches, request.branch_id);
  const binding = get(state.bindings, request.binding_id);
  requireThat(branch.story_id === request.story_id && binding.story_id === request.story_id &&
    binding.branch_id === request.branch_id && binding.binding_generation === request.binding_generation &&
    branch.head_snapshot_id === request.head_snapshot_id &&
    get(state.views, branch.branch_id).version === request.memory_view_version,
  'STALE_PREPARE', 'Prepare scope/head/binding/memory view changed');
  const entries = history(state, branch.head_snapshot_id);
  requireThat(request.cutoff_length <= entries.length &&
    new Set(request.required_memory_revision_ids).size === request.required_memory_revision_ids.length &&
    request.recent_source_refs.every(ref => entries.slice(0, request.cutoff_length).some(x => equal(x, ref))) &&
    request.input_fingerprint === prepareFingerprint(request), 'STALE_PREPARE', 'Prepare input/cutoff mismatch');
}
export function checkResponse(response) {
  validate('response', response);
  requireThat(response.echo.input_fingerprint === prepareFingerprint(response.echo),
    'INVALID_SCHEMA', 'Response fingerprint mismatch');
  requireThat(response.rerank_status === 'completed' || response.rerank_score === null,
    'INVALID_SCHEMA', 'Non-rerank score cannot stand in for rerank');
  requireThat(response.status === 'ready' ? response.blocks.length > 0 : response.blocks.length === 0,
    'INVALID_SCHEMA', 'Response status/blocks mismatch');
  const seen = new Set();
  for (const block of response.blocks) {
    requireThat(!seen.has(block.block_id), 'INVALID_SCHEMA', 'Duplicate context block');
    seen.add(block.block_id);
    requireThat(block.placement.position === 'at_depth' ? block.placement.depth !== null : block.placement.depth === null,
      'INVALID_SCHEMA', 'Placement depth mismatch');
    requireThat(block.residency !== 'detail' || !block.compressible, 'INVALID_SCHEMA', 'Pinned detail cannot compress');
    requireThat(block.visibility === 'normal' && block.send_allowed, 'FORBIDDEN', 'Private/excluded block');
    requireThat(block.origin === 'source_derived' ? block.input_refs.length > 0 :
      block.source_declaration !== null, 'INVALID_SCHEMA', 'Missing block origin');
    requireThat(block.origin !== 'derived_only' || block.input_refs.length > 0 &&
      block.input_refs.every(ref => ref.type === 'memory'), 'INVALID_SCHEMA', 'Derived-only block needs scoped memory reference');
  }
}
export function canApply(state, response, current, pendingHistoryChange = false) {
  checkResponse(response);
  checkPrepare(state, current);
  requireThat(!pendingHistoryChange && equal(response.echo, current),
    'STALE_PREPARE', 'Run/input/observation changed or uncommitted host change');
  requireThat(['ready', 'empty'].includes(response.status), 'NOT_READY', response.status);
  const availability = prepareAvailability(state, current.branch_id,
    current.required_memory_revision_ids, current.cutoff_length);
  requireThat(['ready', 'empty'].includes(availability), 'NOT_READY', availability);
  const entries = history(state, current.head_snapshot_id).slice(0, current.cutoff_length);
  for (const block of response.blocks) {
    for (const ref of block.input_refs) {
      if (ref.type === 'source') requireThat(entries.some(x =>
        x.message_id === ref.message_id && x.revision_id === ref.revision_id), 'NOT_READY', 'Source outside scope');
      else {
        requireThat(get(state.views, current.branch_id).selections[ref.memory_id] === ref.memory_revision_id &&
          memoryStatus(state, ref.memory_revision_id, current.branch_id, current.cutoff_length) === 'valid',
        'NOT_READY', 'Memory unavailable');
      }
    }
  }
  return true;
}
export function prepareAvailability(state, branchId, revisionIds, cutoffLength, indexBehind = false) {
  const statuses = revisionIds.map(key => {
    const memory = state.memories[key];
    if (memory && get(state.views, branchId).selections[memory.memory_id] !== key) return 'needs-rebuild';
    return memoryStatus(state, key, branchId, cutoffLength);
  });
  if (statuses.includes('needs-resolution')) return 'needs_resolution';
  if (statuses.some(s => s !== 'valid')) return 'not_ready';
  if (indexBehind) return 'index_behind';
  return statuses.includes('valid') ? 'ready' : 'empty';
}
export function bindHost(original, binding) {
  validate('binding', binding);
  const branch = get(original.branches, binding.branch_id);
  requireThat(branch.story_id === binding.story_id, 'NEEDS_RESOLUTION', 'Binding owner mismatch');
  requireThat(new Set(binding.message_map.map(x => x.host_key)).size === binding.message_map.length &&
    new Set(binding.message_map.map(x => x.message_id)).size === binding.message_map.length,
  'NEEDS_RESOLUTION', 'Ambiguous host mapping');
  binding.message_map.forEach(x => requireThat(get(original.messages, x.message_id).story_id === binding.story_id,
    'NEEDS_RESOLUTION', 'Mapping crosses story'));
  const state = structuredClone(original);
  const previous = state.bindings[binding.binding_id];
  if (previous) {
    requireThat(binding.story_id === previous.story_id, 'NEEDS_RESOLUTION',
      'Cross-story rebinding requires a new binding ID', { story_id: previous.story_id });
    requireThat(binding.binding_generation === previous.binding_generation + 1,
      'VERSION_CONFLICT', 'Binding generation must advance');
    state.bindings[binding.binding_id] = structuredClone(binding);
  } else put(state.bindings, binding.binding_id, binding);
  return freeze(state);
}
export function resolveIdentity(binding, hostKey) {
  const matches = binding?.message_map.filter(x => x.host_key === hostKey) ?? [];
  return matches.length === 1 ? { status: 'matched', message_id: matches[0].message_id }
    : { status: 'needs-resolution', reason: 'Explicit mapping required' };
}
export function interpretRegenerate({ confirmed_message_id, before, after, stable, success_confirmed }) {
  if (!stable) return { status: 'pending' };
  if (!confirmed_message_id || !before || before.message_id !== confirmed_message_id) return { status: 'needs-resolution' };
  if (equal(before, after)) return { status: 'unchanged' };
  if (!success_confirmed || !after || after.message_id !== confirmed_message_id ||
    typeof after.content !== 'string' || !after.content.trim()) return { status: 'needs-resolution' };
  return { status: 'revision', message_id: confirmed_message_id, content: after.content, operation: 'regenerate' };
}
