import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PagedCoordinator } from '../paged-coordinator.mjs';
import { resourceMeter } from '../resource-meter.mjs';
import { fixture } from '../../contracts/tests/fixture.mjs';

class IO {
  live = new Map();
  async get(k) { return structuredClone(this.live.get(k) ?? null); }
  async put(k, v) { this.live.set(k, structuredClone(v)); }
  async flush() {}
  async reopen() {}
  async close() {}
  async assertEmpty() { if (this.live.size) throw Error('not empty'); }
}
const meter = resourceMeter(), io = new IO(), owner = new PagedCoordinator(meter.io(io));
const handle = meter.handle(await owner.create()), f = fixture(8);
const command = Object.values(f.state.operations)[0].command;
await handle.prepare({ kind: 'history', operation_id: command.operation_id, payload: command });
await handle.execute(command.operation_id);
const output = process.argv[2];
const result = { fixture: 'contracts fixture(8), one history prepare/execute',
  synthetic: true, node: process.version, physical_nodes: io.live.size, counters: meter.snapshot() };
if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); }
console.log(JSON.stringify(result));
