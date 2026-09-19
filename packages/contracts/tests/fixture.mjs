import {
  archiveMemory, bindHost, commitHistory, derivedFingerprint, emptyState, fingerprint,
  history, makeCoverage, prepareFingerprint, selectMemory,
} from '../index.mjs';

export function deterministicIds() {
  let counter = 0;
  const prefixes = { story: 'st', branch: 'br', message: 'msg', revision: 'rev', snapshot: 'hs',
    block: 'hm', operation: 'op', memory: 'mem', memoryRevision: 'mr', memoryView: 'mv',
    binding: 'hb', run: 'run', contextBlock: 'cb' };
  return kind => `${prefixes[kind]}_00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;
}
export const timestamp = '2026-09-19T00:00:00.000Z';
export function fixture(count = 6) {
  const ids = deterministicIds();
  const story = ids('story'), branch = ids('branch');
  let state = emptyState();
  const source = (role, content, messageId = ids('message')) => {
    const message = { schema_version: 1, story_id: story, message_id: messageId };
    const revision = { schema_version: 1, revision_id: ids('revision'), message_id: messageId, role, content,
      content_fingerprint: fingerprint('content', { role, content }),
      provenance: { host_kind: 'fixture', binding_id: null, host_scope: 'fictional',
        stable_id: null, mutable_ref: null, observed_index: null, import_batch: null, operation: 'test' } };
    return { message, revision, ref: { message_id: messageId, revision_id: revision.revision_id } };
  };
  const sources = Array.from({ length: count }, (_, i) => source(i % 2 ? 'assistant' : 'user', `Fictional marker ${i}`));
  const command = (entries, overrides = {}) => ({
    operation_id: ids('operation'), story_id: story, branch_id: branch,
    expected_head: state.branches[branch]?.head_snapshot_id ?? null, change_kind: 'import', entries,
    messages: [], revisions: [], fork: null, created_at: timestamp, ...overrides,
  });
  const commit = cmd => {
    const result = commitHistory(state, cmd, ids);
    state = result.state;
    return result.snapshot_id;
  };
  commit(command(sources.map(s => s.ref), { change_kind: 'init',
    messages: sources.map(s => s.message), revisions: sources.map(s => s.revision) }));
  function memory(refs, kind = 'TurnMemory', overrides = {}) {
    const entries = history(state, state.branches[branch].head_snapshot_id);
    const memory = { schema_version: 1, memory_id: ids('memory'), memory_revision_id: ids('memoryRevision'),
      story_id: story, basis_snapshot_id: state.branches[branch].head_snapshot_id, kind,
      origin: 'source_derived', input_refs: refs.map(ref => ({ type: 'source', ...ref })),
      coverage: overrides.coverage ?? makeCoverage(entries, 'interval', refs), recipe_id: 'fixture-v1', model_profile: 'synthetic-v1',
      input_fingerprint: '', content: 'Fictional memory', visibility: 'normal', recall_enabled: true,
      source_declaration: null, scope_branch_id: null, ...overrides };
    memory.input_fingerprint = derivedFingerprint(memory);
    return memory;
  }
  function addMemory(memory, branchId = branch) {
    state = archiveMemory(state, memory);
    state = selectMemory(state, branchId, memory.memory_revision_id, state.views[branchId].version, ids);
    return memory;
  }
  function fork(length, sourceSnapshot = state.branches[branch].head_snapshot_id) {
    const child = ids('branch'), entries = history(state, sourceSnapshot);
    commit(command(entries.slice(0, length), { branch_id: child, expected_head: null, change_kind: 'fork',
      fork: { parent_branch_id: branch, source_snapshot_id: sourceSnapshot,
        prefix_length: length, anchor: length ? entries[length - 1] : null } }));
    return child;
  }
  function prepare() {
    const binding_id = ids('binding');
    state = bindHost(state, { schema_version: 1, binding_id, story_id: story, branch_id: branch,
      host_kind: 'fixture', host_scope: 'fictional', stable_id: 'not-a-domain-id',
      mutable_ref: 'fictional.jsonl', binding_generation: 0, intent: 'confirmed_mapping', message_map: [] });
    const entries = history(state, state.branches[branch].head_snapshot_id);
    const request = { schema_version: 1, story_id: story, branch_id: branch,
      head_snapshot_id: state.branches[branch].head_snapshot_id, run_id: ids('run'), binding_id,
      binding_generation: 0, observation_generation: 0, memory_view_version: state.views[branch].version,
      policy_version: 'fixture-policy-v1', cutoff_length: entries.length, user_input: 'Fictional input',
      recent_source_refs: entries.slice(-2), memory_tokens_max: 1000, placement_profile: 'fixture-v1',
      required_memory_revision_ids: [],
      input_fingerprint: '' };
    request.input_fingerprint = prepareFingerprint(request);
    return request;
  }
  return { ids, story, branch, sources, source, command, commit, memory, addMemory, fork, prepare,
    get state() { return state; }, set state(value) { state = value; },
    get entries() { return history(state, state.branches[branch].head_snapshot_id); } };
}
export const memoryRef = memory => ({ type: 'memory', memory_id: memory.memory_id, memory_revision_id: memory.memory_revision_id });
export const response = request => ({ schema_version: 1, echo: structuredClone(request), status: 'empty',
  blocks: [], warnings: [], rerank_status: 'not_run', rerank_score: null });
