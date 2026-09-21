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
    demoArchive: ['version','type','source','name','branch','head','session','assets','updated_at'],
    identity: ['version','type','source','scope','stable_id','locator','binding_source','previous_locator'],
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
  if(value.type==='demoArchive') {
    check(key===recordKey('demoArchive',value.source)&&typeof value.source==='string'&&value.source.length>0&&
      typeof value.name==='string'&&value.name.trim().length>0&&value.name.length<=80&&
      typeof value.branch==='string'&&typeof value.head==='string'&&typeof value.session==='string'&&
      typeof value.updated_at==='string'&&Array.isArray(value.assets)&&value.assets.length<=512&&
      value.assets.every(k=>typeof k==='string'&&/^bridge-v1:asset:sha256:write-payload:v1:[0-9a-f]{64}$/.test(k))&&
      new Set(value.assets).size===value.assets.length,'INVALID_SCHEMA','Demo archive manifest');
  }
  if(value.type==='identity') {
    check(typeof value.stable_id==='string'&&value.stable_id.length>0&&value.scope?.host==='TT'&&
      value.source===digest({identity_version:2,scope:value.scope,stable_id:value.stable_id})&&key===recordKey('identity',value.source),
      'INVALID_SCHEMA','Scoped source identity');
    check(value.locator?.kind===value.scope.kind&&(value.scope.kind!=='character'||value.locator.characterId===value.scope.owner),
      'INVALID_SCHEMA','Locator scope differs');
  }
}
