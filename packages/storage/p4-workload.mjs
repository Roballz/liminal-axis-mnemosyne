// Fixed synthetic P4 workload shared by Node measurement and isolated TT.
import { fixture } from '../contracts/tests/fixture.mjs';
import { derivedFingerprint, makeCoverage } from '../contracts/memory.mjs';

const clock = () => globalThis.performance?.now?.() ?? Date.now();

async function publish(handle, input, metrics) {
  const started = clock(), receipt = await handle.prepare(input), prepared = clock();
  const result = await handle.execute(input.operation_id), finished = clock();
  metrics.push({ operation_id: input.operation_id, kind: input.kind,
    prepare_ms: prepared - started, execute_ms: finished - prepared, total_ms: finished - started });
  return { receipt, result };
}

function delta(f, { branchId, head, entries, start, remove, insert, kind, messages = [], revisions = [] }) {
  const command = f.command([], { branch_id: branchId, expected_head: head, change_kind: kind, messages, revisions });
  const { entries: ignored, ...payload } = command;
  payload.splice = { start, delete_count: remove, entries: structuredClone(insert) };
  return { operation_id: command.operation_id, kind: 'history-delta', payload };
}

export async function exercisePagedScale(handle, { scale = 1, onProgress = async () => {} } = {}) {
  if (![1, 5, 10].includes(scale)) throw Error('P4 scale must be 1, 5, or 10');
  const f = fixture(0), metrics = [], operations = [], snapshots = [], content = new Map();
  const rounds = 32 * scale, bodyLength = 15500;
  let entries = [], head = null, archivedCharacters = 0;
  for (let round = 0; round < rounds; round++) {
    const sources = [0, 1].map(side => {
      const marker = 'Synthetic P4 ' + scale + 'x ' + round + '/' + side + ' 中文 marker ';
      const source = f.source(side ? 'assistant' : 'user', marker.padEnd(bodyLength, String(round % 10)));
      content.set(source.revision.revision_id, source.revision.content); archivedCharacters += source.revision.content.length;
      return source;
    });
    const input = delta(f, { branchId: f.branch, head, entries, start: entries.length, remove: 0,
      insert: sources.map(source => source.ref), kind: round ? 'append' : 'init',
      messages: sources.map(source => source.message), revisions: sources.map(source => source.revision) });
    const published = await publish(handle, input, metrics); head = published.result.snapshot_id;
    entries.push(...sources.map(source => source.ref)); operations.push(input.operation_id); snapshots.push(head);
    await onProgress({ phase: 'growth', completed: round + 1, total: rounds, operations: operations.length });
  }

  const editPositions = [5, Math.floor(entries.length / 3), Math.floor(entries.length * 2 / 3), entries.length - 6];
  for (const position of editPositions) {
    const old = entries[position], source = f.source(position % 2 ? 'assistant' : 'user',
      ('Synthetic P4 edited ' + position + ' 深层编辑 marker ').padEnd(bodyLength, 'e'), old.message_id);
    content.set(source.revision.revision_id, source.revision.content); archivedCharacters += source.revision.content.length;
    const input = delta(f, { branchId: f.branch, head, entries, start: position, remove: 1,
      insert: [source.ref], kind: 'edit', revisions: [source.revision] });
    const published = await publish(handle, input, metrics); head = published.result.snapshot_id;
    entries[position] = source.ref; operations.push(input.operation_id); snapshots.push(head);
    await onProgress({ phase: 'edit', completed: position, total: entries.length, operations: operations.length });
  }

  const deleted = Math.floor(entries.length / 2);
  const deletion = delta(f, { branchId: f.branch, head, entries, start: deleted, remove: 1,
    insert: [], kind: 'delete' });
  head = (await publish(handle, deletion, metrics)).result.snapshot_id;
  entries.splice(deleted, 1); operations.push(deletion.operation_id); snapshots.push(head);

  const child = f.ids('branch'), prefixLength = Math.floor(entries.length / 2);
  const forkCommand = f.command(entries.slice(0, prefixLength), { branch_id: child, expected_head: null,
    change_kind: 'fork', fork: { parent_branch_id: f.branch, source_snapshot_id: head,
      prefix_length: prefixLength, anchor: entries[prefixLength - 1] } });
  const forkInput = { operation_id: forkCommand.operation_id, kind: 'history', payload: forkCommand };
  let childHead = (await publish(handle, forkInput, metrics)).result.snapshot_id;
  operations.push(forkInput.operation_id); snapshots.push(childHead);
  const childSource = f.source('user', 'Synthetic child-only branch marker'.padEnd(bodyLength, 'c'));
  content.set(childSource.revision.revision_id, childSource.revision.content);
  archivedCharacters += childSource.revision.content.length;
  const childInput = delta(f, { branchId: child, head: childHead, entries: entries.slice(0, prefixLength),
    start: prefixLength, remove: 0, insert: [childSource.ref], kind: 'append',
    messages: [childSource.message], revisions: [childSource.revision] });
  childHead = (await publish(handle, childInput, metrics)).result.snapshot_id;
  operations.push(childInput.operation_id); snapshots.push(childHead);

  const selected = entries.slice(0, 2), memory = {
    schema_version: 1, memory_id: f.ids('memory'), memory_revision_id: f.ids('memoryRevision'),
    story_id: f.story, basis_snapshot_id: head, kind: 'Record', origin: 'source_derived',
    input_refs: selected.map(ref => ({ type: 'source', ...ref })),
    coverage: makeCoverage(entries, 'interval', selected), recipe_id: 'p4-synthetic-v1',
    model_profile: 'artificial-vector-v1', input_fingerprint: '',
    content: '青石门 月台 角色约定 P4 synthetic marker', visibility: 'normal', recall_enabled: true,
    source_declaration: null, scope_branch_id: null,
  };
  memory.input_fingerprint = derivedFingerprint(memory);
  const view = await handle.read('views', f.branch), memoryInput = {
    operation_id: f.ids('operation'), kind: 'memory', payload: { archives: [memory], action: 'select',
      branch_id: f.branch, revision_id: memory.memory_revision_id, old_revision_id: null,
      expected_view: view.version, mode: 'replace' },
  };
  await publish(handle, memoryInput, metrics); operations.push(memoryInput.operation_id);

  const ranges = [];
  for (const start of [0, Math.max(0, Math.floor(entries.length / 2) - 4), Math.max(0, entries.length - 8)]) {
    ranges.push({ snapshot_id: head, start, values: await handle.range(head, start, Math.min(8, entries.length - start)) });
  }
  ranges.push({ snapshot_id: childHead, start: Math.max(0, prefixLength - 4),
    values: await handle.range(childHead, Math.max(0, prefixLength - 4), 5) });
  const currentCharacters = entries.reduce((sum, entry) => sum + content.get(entry.revision_id).length, 0);
  return { scale, story_id: f.story, branch_id: f.branch, child_branch_id: child, head_snapshot_id: head,
    child_head_snapshot_id: childHead, operations, metrics, ranges, memory,
    messages: entries.length, current_characters: currentCharacters, archived_revision_characters: archivedCharacters,
    growth_rounds: rounds, edits: editPositions.length, deletes: 1, forks: 1 };
}
