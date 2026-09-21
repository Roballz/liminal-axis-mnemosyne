import { equal, fingerprint, requireThat as check } from '../contracts/primitives.mjs';

export const PREFIX = 'bridge-v1:';
export const digest = value => fingerprint('write-payload', value);
export const recordKey = (type, key) => `${PREFIX}${type}:${key}`;
export function validateRecord(key, value) {
  check(typeof key === 'string' && key.startsWith(PREFIX) && key.length <= 512,
    'INVALID_SCHEMA', 'Bridge record key');
  check(value && value.version === 1 && typeof value.type === 'string', 'INVALID_SCHEMA', 'Bridge record version');
  const fields = {
    session: ['version','type','id','source','fingerprint','categories','target','status','cursor','total','assetCursor','assetTotal','generation','reason','report','created_at'],
    binding: ['version','type','source','binding_id','target','session','fingerprint','count','offset','status','sync','generation','reason'],
    map: ['version','type','source','floor','ref','fingerprint','candidates'],
    asset: ['version','type','source','source_id','category','fingerprint','data','declaration','scope','anchor','previous'],
    assetMap: ['version','type','asset','fingerprint'],
  }[value.type];
  check(fields && equal(Object.keys(value).sort(), fields.sort()), 'INVALID_SCHEMA', 'Bridge record fields');
  check(key.startsWith(`${PREFIX}${value.type}:`), 'INVALID_SCHEMA', 'Bridge record type/key');
  if (value.type === 'session' || value.type === 'binding') {
    check(['importing','complete','paused','partial','pending'].includes(value.status), 'INVALID_SCHEMA', 'Bridge state');
    check(Number.isSafeInteger(value.generation) && value.generation >= 0, 'INVALID_SCHEMA', 'Bridge generation');
  }
  if (value.type === 'asset') {
    check(['summary','higher','items','scenes','lifeDetails'].includes(value.category), 'INVALID_SCHEMA', 'Bridge category');
    check(value.declaration === 'legacy-inputs-unproven' && value.fingerprint === digest(value.data),
      'INVALID_SCHEMA', 'Legacy source declaration/fingerprint');
  }
}
