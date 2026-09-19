// Deterministic durability simulator, never described as native TT evidence.
export class FakeIO {
  constructor() { this.live = new Map(); this.durable = new Map(); this.trace = []; this.fail = null; }
  async get(id) { return structuredClone(this.live.get(id) ?? null); }
  async put(id, value) { this.live.set(id, structuredClone(value)); }
  async flush() { this.durable = structuredClone(this.live); }
  async close() { await this.flush(); }
  async point(label, edge) {
    this.trace.push({ label, edge });
    if (this.fail?.label === label && this.fail.edge === edge && --this.fail.n === 0) {
      if (this.fail.durable) await this.flush(); // written durably, return/ack is lost
      const error = new Error(this.fail.code ?? 'injected IO failure');
      error.code = this.fail.code ?? 'EIO';
      throw error;
    }
  }
  crash() { this.live = structuredClone(this.durable); }
}
