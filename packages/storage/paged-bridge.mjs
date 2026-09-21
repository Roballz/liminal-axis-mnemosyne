// An additive durable request: local history and its bridge receipt publish together.
// No new root format, no separate mutable sidecar, no second commit protocol.
import { equal, requireThat as check } from '../contracts/primitives.mjs';
import { compileHistory } from './paged-history.mjs';
import { compileBinding } from './paged-memory.mjs';
import { PREFIX, digest, validateRecord } from '../bridge/records.mjs';

export async function compileBridge(d, input, makeId) {
  const p = input.payload;
  check(p && equal(Object.keys(p).sort(), ['binding','guard','history','records','version']) && p.version === 1,
    'INVALID_SCHEMA', 'Bridge transaction version/fields');
  check(Array.isArray(p.records) && p.records.length <= 64 && new Set(p.records.map(r => r.key)).size === p.records.length,
    'RESOURCE_LIMIT', 'Bridge batch records');
  if (p.guard) {
    check(equal(Object.keys(p.guard).sort(), ['branch_id','head','view']), 'INVALID_SCHEMA', 'Bridge target guard');
    const branch = await d.get('branches', p.guard.branch_id, false);
    check((branch?.head_snapshot_id ?? null) === p.guard.head, 'HEAD_CONFLICT', 'Bridge target Head changed');
    const view = branch ? await d.field('views', p.guard.branch_id, ['version']) : null;
    check(view === p.guard.view, 'VERSION_CONFLICT', 'Bridge target view changed');
  }
  for (const r of p.records) {
    check(equal(Object.keys(r).sort(), ['expected','key','value']), 'INVALID_SCHEMA', 'Bridge compare-and-set');
    validateRecord(r.key, r.value);
    const old = await d.get('manifests', r.key, false);
    check((old ? digest(old) : null) === r.expected, 'VERSION_CONFLICT', 'Bridge receipt changed');
    if (r.value.type === 'asset') check(old === null || equal(old, r.value), 'INVALID_TRANSITION', 'Immutable legacy asset');
  }
  let result = null;
  if (p.history) {
    check(p.guard && p.history.branch_id === p.guard.branch_id && p.history.expected_head === p.guard.head,
      'INVALID_SCHEMA', 'History must use guarded target');
    result = await compileHistory(d, { ...input, kind: 'history-delta', payload: p.history }, makeId);
  }
  if (p.binding) await compileBinding(d, { payload: p.binding });
  for (const r of p.records) {
    const value = structuredClone(r.value);
    if (value.type === 'session' || value.type === 'binding') {
      const branch = await d.get('branches', value.target.branch_id, false);
      check(branch && branch.story_id === value.target.story_id, 'INVALID_SCHEMA', 'Bridge target owner');
      value.target.head = branch.head_snapshot_id;
      value.target.view = await d.field('views', branch.branch_id, ['version']);
    }
    if (value.type === 'map') {
      const revision = await d.get('revisions', value.ref.revision_id);
      check(revision.message_id === value.ref.message_id, 'INVALID_SCHEMA', 'Bridge source reference');
    }
    await d.put('manifests', r.key, value);
  }
  await d.put('manifests', PREFIX + 'format', { version: 1 });
  return { snapshot_id: result?.snapshot_id ?? null, keys: p.records.map(r => r.key) };
}
