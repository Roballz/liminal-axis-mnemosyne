// Streaming transport for a fixed snapshot of a persistent page directory.
// The directory is supplied by the coordinator; this module never discovers
// pages by recursively following shared references and never materializes the
// page set in memory.
import { canonicalize, equal, requireThat as check } from '../contracts/primitives.mjs';
import { sha256 } from '../contracts/runtime.mjs';
import { readJSONLines } from './strict-json.mjs';

export const PAGE_GRAPH_FORMAT = 'mnemosyne-page-directory-v1';
export const PAGE_GRAPH_LIMITS = Object.freeze({
  lineBytes: 1048576,
  totalBytes: 1073741824,
  lines: 1000002,
  maxPages: 1000000,
  depth: 64,
  values: 200000,
});

const encoder = new TextEncoder();
const HASH_PREFIX = 'sha256:page-graph:v1:';
const hashRecord = body => `${HASH_PREFIX}${sha256(canonicalize(body))}`;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, keys) => isObject(value) && equal(Object.keys(value).sort(), [...keys].sort());
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function reference(value) {
  check(exactKeys(value, ['hash', 'slot']) && isHash(value.hash) && Number.isSafeInteger(value.slot) &&
    value.slot >= 65536 && value.slot < 2 ** 48 + 65536,
  'INVALID_SCHEMA', 'Invalid page reference');
}

function jsonValue(value, detail) {
  try { canonicalize(value); } catch (error) {
    if (error?.code) throw error;
    check(false, 'INVALID_SCHEMA', detail);
  }
}

function limitsFor(options = {}) {
  check(isObject(options), 'INVALID_SCHEMA', 'Transport options required');
  const supplied = options.limits ?? {};
  check(isObject(supplied), 'INVALID_SCHEMA', 'Transport limits required');
  const limits = { ...PAGE_GRAPH_LIMITS, ...supplied };
  if (options.maxPages !== undefined) limits.maxPages = options.maxPages;
  for (const key of ['lineBytes', 'totalBytes', 'lines', 'maxPages', 'depth', 'values']) {
    check(Number.isSafeInteger(limits[key]) && limits[key] > 0, 'RESOURCE_LIMIT', `Invalid ${key} limit`);
  }
  limits.lines = Math.min(limits.lines, limits.maxPages + 2);
  check(limits.lines >= 2, 'RESOURCE_LIMIT', 'Transport line limit too small');
  return limits;
}

function encodeRecord(record, limits, total) {
  const bytes = encoder.encode(`${canonicalize(record)}\n`);
  check(bytes.byteLength - 1 <= limits.lineBytes, 'RESOURCE_LIMIT', 'Page graph line limit');
  check(total + bytes.byteLength <= limits.totalBytes, 'RESOURCE_LIMIT', 'Page graph byte limit');
  return { bytes, total: total + bytes.byteLength };
}

function checkedRecord(record, previous, expectedKeys, type) {
  check(exactKeys(record, expectedKeys), 'INVALID_SCHEMA', `Invalid ${type} record shape`);
  const { checksum, ...body } = record;
  check(typeof checksum === 'string' && checksum === hashRecord(body),
    'NEEDS_RESOLUTION', `Invalid ${type} record checksum`);
  check(body.previous === previous, 'NEEDS_RESOLUTION', `Invalid ${type} record order`);
  check(body.format === PAGE_GRAPH_FORMAT && body.type === type,
    'INVALID_SCHEMA', `Invalid ${type} record format`);
  return { body, checksum };
}

function asChunks(chunks) {
  if (chunks instanceof Uint8Array) return (async function* () { yield chunks; })();
  check(chunks && (typeof chunks[Symbol.asyncIterator] === 'function' ||
    typeof chunks[Symbol.iterator] === 'function'), 'INVALID_SCHEMA', 'UTF-8 chunks required');
  return chunks;
}

function ensurePages(pages) {
  check(pages && typeof pages.get === 'function' && typeof pages.put === 'function' &&
    typeof pages.mapGet === 'function' && typeof pages.mapSet === 'function' &&
    typeof pages.mapEntries === 'function', 'INVALID_SCHEMA', 'Page store required');
}

// Each yielded chunk is one complete NDJSON line. A consumer may split or
// combine these chunks before import; readJSONLines performs the UTF-8 framing.
export async function* exportPageDirectory(pages, directory, metadata = {}, options = {}) {
  ensurePages(pages);
  const limits = limitsFor(options);
  check(directory === null || directory === undefined || (reference(directory), true),
    'INVALID_SCHEMA', 'Invalid page directory root');
  directory ??= null;
  jsonValue(metadata, 'Invalid page graph metadata');
  const roots = options.roots ?? (isObject(metadata) && Object.hasOwn(metadata, 'roots') ? metadata.roots : null);
  jsonValue(roots, 'Invalid page graph roots');

  let previous = null;
  let total = 0;
  let count = 0;
  const emit = body => {
    const record = { ...body, checksum: hashRecord(body) };
    const encoded = encodeRecord(record, limits, total);
    total = encoded.total;
    previous = record.checksum;
    return encoded.bytes;
  };

  yield emit({ format: PAGE_GRAPH_FORMAT, type: 'header', previous: null, roots, metadata });
  if (directory !== null) {
    for await (const [key, ref] of pages.mapEntries(directory)) {
      check(key === ref.hash, 'NEEDS_RESOLUTION', 'Page directory key/reference mismatch');
      reference(ref);
      check(++count <= limits.maxPages, 'RESOURCE_LIMIT', 'Page graph count limit');
      const body = await pages.get(ref);
      yield emit({ format: PAGE_GRAPH_FORMAT, type: 'page', previous, ref, body });
    }
  }
  yield emit({ format: PAGE_GRAPH_FORMAT, type: 'footer', previous, count });
}

// Import writes only immutable pages and rebuilds a directory root in the
// caller's staging store. Domain/root publication and semantic audits remain
// outside this transport layer.
export async function importPageDirectory(pages, chunks, options = {}) {
  ensurePages(pages);
  const directoryPages = options.directoryPages ?? pages;
  ensurePages(directoryPages);
  const limits = limitsFor(options);
  let directory = options.directory ?? null;
  const batch = new Map();
  const finishBatch = async () => {
    if (!batch.size) return;
    directory = await directoryPages.mapSetMany(directory, [...batch]);
    await directoryPages.finish?.(directory); batch.clear();
  };
  check(directory === null || (reference(directory), true), 'INVALID_SCHEMA', 'Invalid staging directory root');

  let header = null;
  let previous = null;
  let footer = null;
  let count = 0;
  let records = 0;
  let duplicates = 0;
  for await (const record of readJSONLines(asChunks(chunks), limits)) {
    check(isObject(record), 'INVALID_SCHEMA', 'Page graph record must be an object');
    check(!footer, 'NEEDS_RESOLUTION', 'Page graph has records after footer');
    if (header === null) {
      const checked = checkedRecord(record, null,
        ['checksum', 'format', 'metadata', 'previous', 'roots', 'type'], 'header');
      header = checked.body;
      previous = checked.checksum;
      continue;
    }
    if (record.type === 'page') {
      const checked = checkedRecord(record, previous,
        ['body', 'checksum', 'format', 'previous', 'ref', 'type'], 'page');
      const { ref, body } = checked.body;
      reference(ref);
      check(++records <= limits.maxPages, 'RESOURCE_LIMIT', 'Page graph count limit');
      const existing = batch.get(ref.hash) ?? await directoryPages.mapGet(directory, ref.hash);
      if (existing !== null) {
        check(equal(existing, ref), 'ID_COLLISION', 'Duplicate page reference differs');
        check(equal(await pages.get(existing), body), 'ID_COLLISION', 'Duplicate page body differs');
        duplicates++;
      } else {
        const actual = await pages.put(body);
        check(equal(actual, ref), 'NEEDS_RESOLUTION', 'Imported page reference differs');
        if (typeof directoryPages.mapSetMany === 'function') {
          batch.set(ref.hash, actual); if (batch.size === 1024) await finishBatch();
        } else {
          directory = await directoryPages.mapSet(directory, ref.hash, actual);
          await directoryPages.checkpoint?.(directory);
        }
        count++;
      }
      previous = checked.checksum;
      continue;
    }
    if (record.type === 'footer') {
      const checked = checkedRecord(record, previous,
        ['checksum', 'count', 'format', 'previous', 'type'], 'footer');
      check(Number.isSafeInteger(checked.body.count) && checked.body.count >= 0,
        'INVALID_SCHEMA', 'Invalid page graph count');
      check(checked.body.count === count, 'NEEDS_RESOLUTION', 'Page graph count mismatch');
      footer = { ...checked.body, checksum: checked.checksum };
      previous = checked.checksum;
      continue;
    }
    check(false, 'INVALID_SCHEMA', 'Unknown page graph record type');
  }
  check(header !== null, 'NEEDS_RESOLUTION', 'Page graph header missing');
  check(footer !== null, 'NEEDS_RESOLUTION', 'Page graph footer missing');
  check(header.format === PAGE_GRAPH_FORMAT && header.type === 'header' && header.previous === null,
    'INVALID_SCHEMA', 'Invalid page graph header');
  await finishBatch(); await directoryPages.finish?.(directory);
  return {
    directory,
    roots: header.roots,
    metadata: header.metadata,
    count,
    duplicates,
    checksum: footer.checksum,
  };
}

// Kept as a named compatibility entry point for callers that use the graph
// terminology. A directory is still mandatory: recursively following roots
// would duplicate shared DAG pages and lose the linear bounded export.
export function exportPageGraph(pages, roots, metadata = {}, options = {}) {
  check(options && options.directory !== undefined, 'INVALID_SCHEMA',
    'Page graph export requires a fixed page directory');
  return exportPageDirectory(pages, options.directory, metadata, { ...options, roots });
}
