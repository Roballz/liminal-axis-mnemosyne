import { canonicalize, id, requireThat } from './primitives.mjs';

const fail = message => requireThat(false, 'INVALID_SCHEMA', message);
const text = v => typeof v === 'string' || fail('Expected string');
const label = v => text(v) && (v.length > 0 || fail('Expected nonempty string'));
const bool = v => typeof v === 'boolean' || fail('Expected boolean');
const nat = v => Number.isSafeInteger(v) && v >= 0 || fail('Expected nonnegative safe integer');
const number = v => typeof v === 'number' && Number.isFinite(v) || fail('Expected finite number');
const oneOf = (...values) => v => values.includes(v) || fail(`Expected ${values.join('|')}`);
const nullable = check => v => v === null || check(v);
const list = check => v => Array.isArray(v) && v.every(x => { check(x); return true; }) || fail('Expected array');
const identity = kind => v => id(kind, v);
const object = fields => v => {
  requireThat(v !== null && typeof v === 'object' && !Array.isArray(v), 'INVALID_SCHEMA', 'Expected object');
  requireThat(Object.keys(v).length === Object.keys(fields).length &&
    Object.keys(fields).every(k => Object.hasOwn(v, k)), 'INVALID_SCHEMA', 'Missing or unknown fields');
  for (const [key, check] of Object.entries(fields)) check(v[key]);
};
const dictionary = (keyCheck, check) => v => {
  requireThat(v !== null && typeof v === 'object' && !Array.isArray(v), 'INVALID_SCHEMA', 'Expected dictionary');
  for (const [key, value] of Object.entries(v)) { keyCheck(key); check(value); }
};
const stamp = v => text(v) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v || fail('Expected UTC timestamp');
const digest = purpose => v => text(v) &&
  new RegExp(`^sha256:${purpose}:v1:[0-9a-f]{64}$`).test(v) || fail('Invalid fingerprint');
export const sourceRef = object({ message_id: identity('message'), revision_id: identity('revision') });
export const inputRef = v => {
  if (v?.type === 'source') object({ type: oneOf('source'), ...sourceFields })(v);
  else object({ type: oneOf('memory'), memory_id: identity('memory'), memory_revision_id: identity('memoryRevision'),
    ...(Object.hasOwn(v ?? {}, 'dependency_mode') ? { dependency_mode: oneOf('current', 'checkpoint') } : {}) })(v);
};
const sourceFields = { message_id: identity('message'), revision_id: identity('revision') };
const boundary = object({ start: identity('message'), end: identity('message') });
export const coverageSchema = object({
  mode: oneOf('interval', 'members'), members: list(sourceRef),
  boundary: nullable(boundary), observed_span: list(sourceRef),
});
export const forkSchema = object({
  parent_branch_id: identity('branch'), source_snapshot_id: identity('snapshot'),
  prefix_length: nat, anchor: nullable(sourceRef),
});
const provenance = object({
  host_kind: label, binding_id: nullable(identity('binding')), host_scope: label,
  stable_id: nullable(text), mutable_ref: nullable(text), observed_index: nullable(nat),
  import_batch: nullable(text), operation: label,
});
export const CHANGE_KINDS = ['init', 'import', 'append', 'edit', 'swipe', 'regenerate', 'delete', 'reorder', 'restore', 'fork'];
export const schemas = {
  story: object({ schema_version: oneOf(1), story_id: identity('story') }),
  branch: object({
    schema_version: oneOf(1), branch_id: identity('branch'), story_id: identity('story'),
    head_snapshot_id: identity('snapshot'), fork: nullable(forkSchema),
  }),
  message: object({ schema_version: oneOf(1), message_id: identity('message'), story_id: identity('story') }),
  revision: object({
    schema_version: oneOf(1), revision_id: identity('revision'), message_id: identity('message'),
    role: oneOf('user', 'assistant', 'system', 'other'), content: text,
    content_fingerprint: digest('content'), provenance,
  }),
  block: v => v?.kind === 'leaf'
    ? object({ schema_version: oneOf(1), block_id: identity('block'), kind: oneOf('leaf'), entries: list(sourceRef) })(v)
    : object({ schema_version: oneOf(1), block_id: identity('block'), kind: oneOf('directory'),
      children: list(object({ block_id: identity('block'), message_count: nat })) })(v),
  snapshot: object({
    schema_version: oneOf(1), snapshot_id: identity('snapshot'), story_id: identity('story'),
    branch_id: identity('branch'), previous_snapshot_id: nullable(identity('snapshot')),
    manifest_root_id: identity('block'), message_count: nat, change_kind: oneOf(...CHANGE_KINDS),
    operation_id: identity('operation'), created_at: stamp,
  }),
  memory: object({
    schema_version: oneOf(1), memory_id: identity('memory'), memory_revision_id: identity('memoryRevision'),
    story_id: identity('story'), basis_snapshot_id: identity('snapshot'),
    kind: oneOf('TurnMemory', 'Summary', 'Event', 'Record'), origin: oneOf('source_derived', 'derived_only'),
    input_refs: list(inputRef), coverage: coverageSchema, recipe_id: label, model_profile: nullable(label),
    input_fingerprint: digest('derived-input'), content: text,
    visibility: oneOf('normal', 'private'), recall_enabled: bool,
    source_declaration: nullable(label), scope_branch_id: nullable(identity('branch')),
  }),
  view: object({
    version: identity('memoryView'), selections: dictionary(identity('memory'), identity('memoryRevision')),
    corrections: dictionary(identity('memoryRevision'), identity('memoryRevision')),
  }),
  binding: object({
    schema_version: oneOf(1), binding_id: identity('binding'), story_id: identity('story'),
    branch_id: identity('branch'), host_kind: label, host_scope: label, stable_id: nullable(text),
    mutable_ref: nullable(text), binding_generation: nat,
    intent: oneOf('new_story', 'carryover', 'fork', 'confirmed_mapping'),
    message_map: list(object({ host_key: label, message_id: identity('message') })),
  }),
  command: object({
    operation_id: identity('operation'), story_id: identity('story'), branch_id: identity('branch'),
    expected_head: nullable(identity('snapshot')), change_kind: oneOf(...CHANGE_KINDS),
    entries: list(sourceRef), messages: list(v => schemas.message(v)), revisions: list(v => schemas.revision(v)),
    fork: nullable(forkSchema), created_at: stamp,
  }),
  operation: object({
    operation_id: identity('operation'), payload_fingerprint: digest('write-payload'),
    command: v => schemas.command(v), snapshot_id: identity('snapshot'),
  }),
  prepare: object({
    schema_version: oneOf(1), story_id: identity('story'), branch_id: identity('branch'),
    head_snapshot_id: identity('snapshot'), run_id: identity('run'), binding_id: identity('binding'),
    binding_generation: nat, observation_generation: nat, memory_view_version: identity('memoryView'),
    policy_version: label, cutoff_length: nat, user_input: text, recent_source_refs: list(sourceRef),
    required_memory_revision_ids: list(identity('memoryRevision')),
    memory_tokens_max: nat, placement_profile: label, input_fingerprint: digest('prepare-input'),
  }),
  contextBlock: object({
    block_id: identity('contextBlock'), kind: oneOf('TurnMemory', 'Summary', 'Event', 'Record', 'setting'),
    content: text, content_revision: label, origin: oneOf('source_derived', 'derived_only', 'user_defined'),
    input_refs: list(inputRef), source_declaration: nullable(label), activation_reasons: list(label),
    placement: object({ role: oneOf('system', 'user', 'assistant'),
      position: oneOf('before_history', 'at_depth'), depth: nullable(nat) }),
    priority: number, compressible: bool, residency: oneOf('detail', 'overview', 'none'),
    token_count_estimate: object({ value: nat, exact: bool, method: label }),
    visibility: oneOf('normal', 'private'), send_allowed: bool,
  }),
  response: object({
    schema_version: oneOf(1), echo: v => schemas.prepare(v),
    status: oneOf('ready', 'empty', 'not_ready', 'needs_resolution', 'index_behind'),
    blocks: list(v => schemas.contextBlock(v)), warnings: list(label),
    rerank_status: oneOf('completed', 'not_run', 'failed'), rerank_score: nullable(number),
  }),
};
export function validate(type, value) {
  canonicalize(value);
  requireThat(Object.hasOwn(schemas, type), 'INVALID_SCHEMA', `Unknown schema ${type}`);
  schemas[type](value);
  return value;
}
