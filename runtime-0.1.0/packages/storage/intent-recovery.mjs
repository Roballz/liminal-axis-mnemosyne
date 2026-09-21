import { canonicalize, equal, fingerprint, requireThat } from '../contracts/primitives.mjs';
import { readJSONLines, TEXT_LIMITS } from './strict-json.mjs';
const check = requireThat;
export const RECOVERY_FORMAT = 'mnemosyne-intent-recovery-v1';
export const RESTORE_SLOT = 8259; // Outside the P2 scan and all v1 intent slots.
const hash = value => fingerprint('write-payload', value);

// Each logical record is independently bounded. The final chain authenticates order,
// multiplicity and completeness, including prepared (not yet published) requests.
export async function* encodeIntentRecovery(snapshot, limits = TEXT_LIMITS) {
  let previous = null, sequence = 0, totalBytes = 0;
  const line = (type, value) => {
    const body = { format: RECOVERY_FORMAT, sequence: sequence++, previous, type, value };
    const record = { ...body, checksum: hash(body) }; previous = record.checksum;
    const bytes = new TextEncoder().encode(canonicalize(record) + '\n');
    totalBytes += bytes.length;
    check(bytes.length - 1 <= limits.lineBytes && totalBytes <= limits.totalBytes && sequence <= limits.lines,
      'RESOURCE_LIMIT', 'Backup record/total/count limit'); return bytes;
  };
  yield line('header', { identity: snapshot.identity, logical_format: 2, storage_format: snapshot.bundle.format });
  for (const table of Object.keys(snapshot.bundle.logical.state).filter(k => k !== 'schema_version').sort()) {
    for (const key of Object.keys(snapshot.bundle.logical.state[table]).sort()) {
      yield line('object', { table, key, value: snapshot.bundle.logical.state[table][key] });
    }
  }
  for (const request of snapshot.bundle.journal) yield line('journal', request);
  for (const entry of snapshot.bundle.ledger) yield line('ledger', entry);
  for (const [branch, marker] of Object.entries(snapshot.bundle.markers)) yield line('marker', { branch, marker });
  for (const intent of snapshot.intents) yield line('intent', intent);
  yield line('end', { logical_checksum: snapshot.bundle.logical.checksum, bundle_checksum: snapshot.bundle.checksum });
}

export async function decodeIntentRecovery(chunks, { emptyState, storageFormat, intentFormat, inspect }, limits = TEXT_LIMITS) {
  const state = structuredClone(emptyState()), journal = [], ledger = [], markers = {}, intents = [];
  const seen = new Set(); let previous = null, sequence = 0, identity, end, rank = 0;
  const ranks = { header: 0, object: 1, journal: 2, ledger: 3, marker: 4, intent: 5, end: 6 };
  for await (const record of readJSONLines(chunks, limits)) {
    check(record && typeof record === 'object' && !Array.isArray(record) &&
      equal(Object.keys(record).sort(), ['checksum', 'format', 'previous', 'sequence', 'type', 'value']),
    'INVALID_SCHEMA', 'Recovery record envelope');
    const { checksum, ...body } = record;
    check(!end && body.format === RECOVERY_FORMAT && body.sequence === sequence++ && body.previous === previous &&
      checksum === hash(body), 'NEEDS_RESOLUTION', 'Recovery checksum/order/completeness');
    previous = checksum;
    check(Object.hasOwn(ranks, body.type) && ranks[body.type] >= rank, 'INVALID_SCHEMA', 'Recovery record order');
    rank = ranks[body.type]; const v = body.value;
    if (body.type === 'header') {
      check(sequence === 1 && v && equal(Object.keys(v).sort(), ['identity', 'logical_format', 'storage_format']) &&
        v.logical_format === 2 && v.storage_format === storageFormat && intentFormat.includes(v.identity?.format),
      'INVALID_SCHEMA', 'Unknown recovery format'); identity = v.identity;
    } else {
      check(identity, 'INVALID_SCHEMA', 'Missing recovery header');
      if (body.type === 'object') {
        check(v && equal(Object.keys(v).sort(), ['key', 'table', 'value']) &&
          v.table !== 'schema_version' && Object.hasOwn(state, v.table) && typeof v.key === 'string' && v.key !== '__proto__',
        'INVALID_SCHEMA', 'Unknown logical table/key');
        const key = `object/${v.table}/${v.key}`;
        check(!seen.has(key), 'ID_COLLISION', 'Duplicate logical identity'); seen.add(key);
        Object.defineProperty(state[v.table], v.key, { value: v.value, enumerable: true });
      } else if (body.type === 'journal') journal.push(v);
      else if (body.type === 'ledger') ledger.push(v);
      else if (body.type === 'intent') intents.push(v);
      else if (body.type === 'marker') {
        check(v && equal(Object.keys(v).sort(), ['branch', 'marker']) && typeof v.branch === 'string' &&
          v.branch !== '__proto__' && !Object.hasOwn(markers, v.branch), 'ID_COLLISION', 'Duplicate recovery marker');
        Object.defineProperty(markers, v.branch, { value: v.marker, enumerable: true });
      } else {
        check(v && equal(Object.keys(v).sort(), ['bundle_checksum', 'logical_checksum']), 'INVALID_SCHEMA', 'Recovery footer'); end = v;
      }
    }
  }
  check(end, 'NEEDS_RESOLUTION', 'Incomplete backup; no final checksum');
  const bundle = { format: storageFormat, logical: { format_version: 2, state, checksum: end.logical_checksum },
    ledger, markers, journal, checksum: end.bundle_checksum };
  return inspect({ identity, bundle, intents });
}
