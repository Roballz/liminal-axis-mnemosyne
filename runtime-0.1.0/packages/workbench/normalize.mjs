import { foldMap } from './unicode/fold-map.mjs';
export const NORMALIZATION = 'ecmascript-nfkc_unicode17-full-default-fold_white-space-v1';
// NFKC uses the host ECMAScript implementation. Projections never cross runtimes.
export function normalize(text, mode = 'tolerant') {
  if (mode === 'exact') return text;
  if (mode !== 'tolerant') throw Object.assign(Error('未知匹配模式'), { code: 'INVALID_QUERY' });
  return Array.from(text.normalize('NFKC'), c => foldMap.get(c) ?? c).join('')
    .replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, ' ')
    .replace(/^ | $/g, '');
}
