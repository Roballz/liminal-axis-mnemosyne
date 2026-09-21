import { Pages } from './pages.mjs';
import { PagedDomain } from './paged-domain.mjs';
import { equal, requireThat as check } from '../contracts/primitives.mjs';

// Runs inside the existing coordinator queue. No write or recovery capability.
export async function boundedRead(io, root, control, epoch, request) {
  let bytes = 0, reads = 0;
  const maxBytes = Math.min(request.maxBytes ?? 2097152, 2097152);
  const maxReads = Math.min(request.maxReads ?? 256, 256);
  const stamp = { library: root.library_id, checkpoint: root.control, epoch };
  try {
    check(!request.stamp || equal(request.stamp, stamp), 'STALE_READ', '档案版本已变化，请重新查找');
    const pages = new Pages({ get: async slot => {
      check(reads < maxReads && bytes + 8192 <= maxBytes && Date.now() < (request.deadline ?? Infinity),
        'READ_LIMIT', '读取预算已到；未检查的范围仍保留');
      reads++;
      const value = await io.get(slot);
      bytes += new TextEncoder().encode(JSON.stringify(value)).length;
      return value;
    }});
    const d = new PagedDomain(pages, control.domain);
    let value;
    if (request.kind === 'state') {
      value = { stamp, branch: request.branch ? await d.get('branches', request.branch) : null,
        pending: control.pending, operations: control.count };
    } else if (request.kind === 'list') {
      check(['branches','manifests'].includes(request.table), 'INVALID_SCHEMA', 'Read catalog table');
      const limit = request.limit ?? 16, prefix = request.prefix ?? '';
      check(Number.isSafeInteger(limit) && limit > 0 && limit <= 32, 'INVALID_SCHEMA', 'Read catalog limit');
      const keys = []; let done = true;
      for await (const [key] of pages.mapEntries(await d.table(request.table), request.after ?? (prefix || null))) {
        if (prefix && !key.startsWith(prefix)) break;
        if (keys.length === limit) { done = false; break; }
        keys.push(key);
      }
      value = { keys, after: keys.at(-1) ?? request.after ?? null, done };
    } else if (request.kind === 'record') {
      check(['stories','branches','snapshots','revisions','messages','manifests'].includes(request.table),
        'INVALID_SCHEMA', 'Read record table');
      const ref = await d.ref(request.table, request.key);
      check(ref || request.optional, 'NEEDS_RESOLUTION', '档案正式引用缺失');
      value = ref ? await d.json.read(ref, { maxBytes: Math.min(request.objectBytes ?? 262144, 262144), maxValues: 20000 }) : null;
    } else if (request.kind === 'entry') {
      check(Number.isSafeInteger(request.index) && request.index >= 0, 'INVALID_SCHEMA', 'Archive position');
      value = await d.entry(request.snapshot, request.index) ?? null;
    } else check(false, 'INVALID_SCHEMA', 'Unknown readonly request');
    return { value, stamp, bytes, reads, limited: false };
  } catch (error) {
    if (['READ_LIMIT','RESOURCE_LIMIT'].includes(error.code)) return { limited: true, bytes, reads, stamp };
    if (['STALE_READ','INVALID_SCHEMA'].includes(error.code)) error.pureRejection = true;
    throw error;
  }
}
