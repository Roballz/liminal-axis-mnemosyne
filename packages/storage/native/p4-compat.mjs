import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PagedCoordinator } from '../paged-coordinator.mjs';
import { restorePagedIntoEmpty } from '../paged-recovery.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';

class IO {
  live = new Map();
  async get(k) { return structuredClone(this.live.get(k) ?? null); }
  async put(k, v) { this.live.set(k, structuredClone(v)); }
  async flush() {}
  async close() {}
  async reopen() {}
  async assertEmpty() { assert.equal(this.live.size, 0); }
}
const oldRoot = resolve('.t03-local/p4-old/packages/storage');
const old = await import(pathToFileURL(resolve(oldRoot, 'paged-coordinator.mjs')));
const recovery = await import(pathToFileURL(resolve(oldRoot, 'paged-recovery.mjs')));
const rows = [];
for (const [direction, Coordinator, restore] of [
  ['old-to-new', old.PagedCoordinator, restorePagedIntoEmpty],
  ['new-to-old', PagedCoordinator, recovery.restorePagedIntoEmpty],
]) {
  const owner = new Coordinator(new IO()), h = await owner.create(), f = fixture(2);
  const command = Object.values(f.state.operations)[0].command;
  await h.prepare({ kind: 'history', operation_id: command.operation_id, payload: command });
  await h.execute(command.operation_id);
  const expected = await h.logical(), checkpoint = (await h.diagnostics()).checkpoint;
  const target = await restore(new IO(), await h.export()), actual = target.handle();
  assert.deepEqual(await actual.logical(), expected);
  assert.deepEqual((await actual.diagnostics()).checkpoint, checkpoint);
  assert.deepEqual(await actual.lookup(command.operation_id), await h.lookup(command.operation_id));
  rows.push({ direction, status: 'passed', checkpoint, old_baseline: 'fc3264b' });
  await target.close(); await owner.close();
}
mkdirSync('evals/t03/p4-repair', { recursive: true });
writeFileSync('evals/t03/p4-repair/compat.json', JSON.stringify(rows, null, 2) + '\n');
console.log(JSON.stringify(rows));
