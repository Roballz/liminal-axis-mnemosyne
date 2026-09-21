import { readFileSync, writeFileSync } from 'node:fs';
const source = readFileSync(new URL('./CaseFolding-17.0.0.txt', import.meta.url), 'utf8');
const entries = [];
for (const line of source.split('\n')) {
  const m = line.match(/^([0-9A-F]+); ([CF]); ([0-9A-F ]+);/);
  if (m) entries.push([String.fromCodePoint(parseInt(m[1],16)), String.fromCodePoint(...m[3].trim().split(' ').map(x=>parseInt(x,16)))]);
}
writeFileSync(new URL('./fold-map.mjs', import.meta.url), '// Generated from Unicode 17.0.0 CaseFolding.txt C+F; see LICENSE.txt.\nexport const foldMap = new Map('+JSON.stringify(entries)+');\n');
