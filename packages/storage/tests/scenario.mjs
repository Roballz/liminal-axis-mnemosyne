import { fixture } from '../../contracts/tests/fixture.mjs';
import { archiveMemory, correctMemory, commitHistory, emptyState, bindHost } from '../../contracts/index.mjs';
import { prepareTransaction } from '../protocol.mjs';

export function scenario() {
  const f = fixture(4), requests = [], states = [];
  let before = emptyState();
  const add = result => {
    requests.push(prepareTransaction(before, f.state, f.ids('operation'), result));
    states.push(f.state);
    before = f.state;
  };
  add({ step: 'initial', head: f.state.branches[f.branch].head_snapshot_id });
  const old = f.addMemory(f.memory(f.entries.slice(0, 2)));
  f.prepare();
  const child = f.fork(4);
  // Second story uses the same global fixture allocator, so domain IDs cannot collide.
  const story2 = f.ids('story'), branch2 = f.ids('branch');
  f.state = commitHistory(f.state, { ...f.command([], { change_kind: 'init' }),
    story_id: story2, branch_id: branch2, expected_head: null }, f.ids).state;
  add({ step: 'two-stories-and-fork', child });
  const fixed = { ...old, memory_revision_id: f.ids('memoryRevision'), content: 'Synthetic corrected memory 中文' };
  f.state = archiveMemory(f.state, fixed);
  f.state = correctMemory(f.state, f.branch, old.memory_revision_id, fixed.memory_revision_id,
    f.state.views[f.branch].version, f.ids);
  add({ step: 'correction', revision: fixed.memory_revision_id });
  const changed = f.source('assistant', 'Synthetic edit 中文 😀\n', f.entries[1].message_id);
  const entries = f.entries; entries[1] = changed.ref;
  f.commit(f.command(entries, { change_kind: 'edit', revisions: [changed.revision] }));
  add({ step: 'edit', head: f.state.branches[f.branch].head_snapshot_id });
  const binding = Object.values(f.state.bindings)[0];
  f.state = bindHost(f.state, { ...binding, binding_generation: binding.binding_generation + 1,
    mutable_ref: 'synthetic-rebound.jsonl' });
  add({ step: 'binding', generation: 1 });
  return { f, requests, states, old, fixed, child, story2, branch2 };
}
