// Local-only synthetic evidence endpoint; no chat data, arbitrary evaluation or uploads.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const phase = process.argv[2] ?? 'p0';
if (!['p0', 'before', 'recover-before', 'after', 'recover-after', 'roundtrip', 'reopen-check', 'g1-repair', 'p3-intent', 'p3-recovery', 'p3-before', 'p3-after', 'recover-p3-before', 'recover-p3-after', 'paged-reopen-check','paged-roundtrip', 'paged-before', 'paged-after', 'recover-paged-before', 'recover-paged-after', 'p4-resource'].includes(phase)) throw Error('Unknown phase');
const run = process.argv[3] ?? '20260919a';
if (!/^[a-z0-9]+$/.test(run)) throw Error('Invalid run');
const root = resolve('.t03-local/evidence'); mkdirSync(root, { recursive: true });
const events = [];
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://tauri.localhost');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method === 'GET' && req.url === '/phase') {
    res.setHeader('Content-Type', 'application/json');
    let crashEvidence = null;
    if (['recover-p3-before', 'recover-p3-after', 'recover-paged-before', 'recover-paged-after'].includes(phase)) {
      crashEvidence = JSON.parse(readFileSync(resolve(root, `${run}-${phase.slice(8)}.json`), 'utf8').replace(/^\uFEFF/, '')).events.at(-1);
      if (crashEvidence.type !== 'kill-ready' || crashEvidence.phase !== phase.slice(8)) throw Error('Invalid prior crash evidence');
    }
    res.end(JSON.stringify({ fixture: 'mnemosyne-t03-isolated-367b0c7', phase, run, crashEvidence })); return;
  }
  if (req.method !== 'POST' || req.url !== '/result') { res.writeHead(404).end(); return; }
  let body = '';
  for await (const part of req) { body += part; if (body.length > 300000) { res.writeHead(413).end(); return; } }
  try {
    const event = JSON.parse(body); events.push(event);
    writeFileSync(resolve(root, `${run}-${phase}.json`), JSON.stringify({ phase, run, events }, null, 2) + '\n');
    console.log(JSON.stringify(event)); res.end('ok');
    if (['done', 'error', 'kill-ready'].includes(event.type)) server.close();
  } catch { res.writeHead(400).end(); }
});
server.listen(19374, '127.0.0.1', () => console.log(`collector ${run} ${phase} listening`));
server.requestTimeout = 10000;
