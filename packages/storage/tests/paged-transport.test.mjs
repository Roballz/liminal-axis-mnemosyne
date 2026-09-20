import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../../contracts/primitives.mjs';
import { sha256 } from '../../contracts/runtime.mjs';
import { Pages } from '../pages.mjs';
import { BufferedDirectory } from '../paged-directory.mjs';
import {
  PAGE_GRAPH_FORMAT,
  exportPageDirectory,
  importPageDirectory,
} from '../paged-transport.mjs';
import { FakeIO } from './fake-io.mjs';

const encoder = new TextEncoder();
const collect = async iterable => { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks; };
const bytes = chunks => {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
};
const lines = chunks => {
  const text = new TextDecoder().decode(bytes(chunks));
  return text.trimEnd().split('\n').map(line => JSON.parse(line));
};
const encodeRows = rows => rows.map(row => encoder.encode(`${canonicalize(row)}\n`));
const graphHash = body => `sha256:page-graph:v1:${sha256(canonicalize(body))}`;
const rechain = rows => {
  let previous = null;
  return rows.map(row => {
    const { checksum, ...body } = row;
    body.previous = previous;
    const next = { ...body, checksum: graphHash(body) };
    previous = next.checksum;
    return next;
  });
};
const split = (input, width = 7) => (async function* () {
  for (let offset = 0; offset < input.byteLength; offset += width) yield input.subarray(offset, offset + width);
})();
const makeDirectory = async (pages, bodies) => {
  let directory = null;
  const refs = [];
  for (const body of bodies) {
    const ref = await pages.put(body); refs.push(ref);
    directory = await pages.mapSet(directory, ref.hash, ref);
  }
  return { directory, refs };
};

test('page directory export is linear, immutable, and imports through split UTF-8 chunks', async () => {
  const sourceIO = new FakeIO(), source = new Pages(sourceIO);
  const { directory, refs } = await makeDirectory(source, [
    { kind: 'scalar', value: '正文 😀' },
    { kind: 'shared', value: 'same subtree', nested: { a: 1 } },
    { kind: 'record', value: '第二页' },
  ]);
  const roots = { control: { hash: refs[0].hash, slot: refs[0].slot } };
  const metadata = { source_library_id: 'library-source', control_ref: refs[0], roots };
  const exported = await collect(exportPageDirectory(source, directory, metadata, { roots }));
  const rows = lines(exported);
  assert.equal(rows[0].format, PAGE_GRAPH_FORMAT);
  assert.equal(rows[0].type, 'header');
  assert.deepEqual(rows[0].metadata, metadata);
  assert.deepEqual(rows[0].roots, roots);
  assert.equal(rows.filter(row => row.type === 'page').length, 3);
  assert.equal(rows.at(-1).type, 'footer');
  assert.equal(rows.at(-1).count, 3);

  const targetIO = new FakeIO(), target = new Pages(targetIO);
  const restored = await importPageDirectory(target, split(bytes(exported), 5));
  assert.equal(restored.count, 3);
  assert.equal(restored.duplicates, 0);
  assert.deepEqual(restored.metadata, metadata);
  assert.deepEqual(restored.roots, roots);
  assert.equal(restored.checksum, rows.at(-1).checksum);
  for (const ref of refs) assert.deepEqual(await target.get(ref), await source.get(ref));
  for await (const [key, ref] of target.mapEntries(restored.directory)) assert.equal(key, ref.hash);
  assert.notEqual(restored.directory, directory);
});

test('fixed directory snapshot excludes later pages and preserves old roots', async () => {
  const io = new FakeIO(), pages = new Pages(io);
  const first = await pages.put({ kind: 'old', value: 1 });
  const directory = await pages.mapSet(null, first.hash, first);
  const later = await pages.put({ kind: 'later', value: 2 });
  const chunks = await collect(exportPageDirectory(pages, directory, { source_library_id: 'fixed' }));
  const rows = lines(chunks);
  assert.deepEqual(rows.filter(row => row.type === 'page').map(row => row.ref), [first]);
  assert.equal(rows.at(-1).count, 1);
  assert.deepEqual(await pages.get(later), { kind: 'later', value: 2 });
});

test('import can buffer directory nodes separately from immutable data pages', async () => {
  const source = new Pages(new FakeIO());
  const { directory } = await makeDirectory(source, [{ kind: 'one', value: 1 }, { kind: 'two', value: 2 }]);
  const exported = await collect(exportPageDirectory(source, directory, { source_library_id: 'buffered' }));
  const io = new FakeIO(), target = new Pages(io), directoryPages = new BufferedDirectory(io, 1);
  const restored = await importPageDirectory(target, split(bytes(exported), 9), { directoryPages });
  const rows = [];
  for await (const row of target.mapEntries(restored.directory)) rows.push(row);
  assert.equal(rows.length, 2);
  assert.equal(directoryPages.cacheSize <= 128, true);
});

test('identical duplicate page records are idempotent while conflicting IDs are rejected', async () => {
  const source = new Pages(new FakeIO());
  const { directory } = await makeDirectory(source, [{ kind: 'one', value: 1 }, { kind: 'two', value: 2 }]);
  const original = lines(await collect(exportPageDirectory(source, directory, { source_library_id: 'dup' })));
  const pageIndex = original.findIndex(row => row.type === 'page');
  const duplicateRows = original.slice(); duplicateRows.splice(pageIndex + 1, 0, structuredClone(original[pageIndex]));
  const duplicate = rechain(duplicateRows);
  const target = new Pages(new FakeIO());
  const result = await importPageDirectory(target, split(bytes(encodeRows(duplicate)), 11));
  assert.equal(result.count, 2);
  assert.equal(result.duplicates, 1);

  const conflictRows = original.slice();
  conflictRows.splice(pageIndex + 1, 0, { ...structuredClone(original[pageIndex]), body: { kind: 'one', value: 999 } });
  await assert.rejects(
    importPageDirectory(new Pages(new FakeIO()), split(bytes(encodeRows(rechain(conflictRows))), 13)),
    error => error.code === 'ID_COLLISION',
  );
});

test('checksum, truncation, footer count, and resource bounds fail closed', async () => {
  const source = new Pages(new FakeIO());
  const { directory } = await makeDirectory(source, [{ kind: 'one', value: 1 }]);
  const original = await collect(exportPageDirectory(source, directory, { source_library_id: 'tamper' }));
  const rows = lines(original);

  const changed = rows.map(row => structuredClone(row));
  changed.find(row => row.type === 'page').body.value = 2;
  await assert.rejects(
    importPageDirectory(new Pages(new FakeIO()), split(bytes(encodeRows(changed)))),
    error => error.code === 'INVALID_SCHEMA' || error.code === 'NEEDS_RESOLUTION',
  );

  await assert.rejects(
    importPageDirectory(new Pages(new FakeIO()), split(bytes(original).subarray(0, -1))),
    error => error.code === 'INVALID_SCHEMA' || error.code === 'NEEDS_RESOLUTION',
  );

  const badCount = rows.map(row => structuredClone(row));
  badCount.at(-1).count = 99;
  await assert.rejects(
    importPageDirectory(new Pages(new FakeIO()), split(bytes(encodeRows(badCount)))),
    error => error.code === 'NEEDS_RESOLUTION',
  );

  await assert.rejects(
    collect(exportPageDirectory(source, directory, {}, { limits: { maxPages: 0 } })),
    error => error.code === 'RESOURCE_LIMIT',
  );
});

test('graph terminology requires a fixed directory instead of recursive root traversal', async () => {
  const pages = new Pages(new FakeIO());
  await assert.rejects(
    (async () => { for await (const _ of (await import('../paged-transport.mjs')).exportPageGraph(pages, { control: null }, {})) { /* no-op */ } })(),
    error => error.code === 'INVALID_SCHEMA',
  );
});
