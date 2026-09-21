// Aggregate counters only: measurement never retains payloads or per-call traces.
export function resourceMeter() {
  const totals = Object.create(null);
  const metric = (name, count = 1, bytes = 0) => {
    const row = totals[name] ??= { count: 0, bytes: 0, ms: 0 };
    row.count += count; row.bytes += bytes;
  };
  const measure = async (name, work) => {
    const start = performance.now(); metric(name);
    try { return await work(); }
    finally { totals[name].ms += performance.now() - start; }
  };
  const wrap = (object, names, prefix) => new Proxy({}, { get(_target, key) {
    const target = object;
    if (key === 'metric') return metric;
    if (key === 'measure') return measure;
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return names.includes(key) ? (...args) => measure(prefix + key, () => value.apply(target, args))
      : value.bind(target);
  } });
  return { metric, measure, snapshot: () => structuredClone(totals),
    io: io => wrap(io, ['get', 'put', 'flush'], 'io.'),
    handle: h => wrap(h, ['prepare', 'execute'], 'operation.') };
}
