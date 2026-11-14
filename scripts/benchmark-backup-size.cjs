/** Optional, bounded large-package probe. Run: node scripts/benchmark-backup-size.cjs
 * BACKUP_BENCH_MIB may select 70..80 MiB (default: 72), or the bounded 288 MiB
 * capacity probe. Large mode avoids redundant standalone reads and releases the
 * synthetic source database after saving; fake IndexedDB otherwise retains both
 * source and restored database contents in RAM, unlike disk-backed browser IDB.
 * Production modules run in a real Node worker_threads worker, using fake-indexeddb
 * and an in-memory Blob disk. This is NOT TT, Android, browser or native-disk testing.
 * No user library, settings, real backup files or network services are accessed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const targetMiB = Number(process.env.BACKUP_BENCH_MIB ?? 72);
assert(Number.isInteger(targetMiB) && (targetMiB >= 70 && targetMiB <= 80 || targetMiB === 288),
    'BACKUP_BENCH_MIB must be an integer from 70 through 80, or exactly 288');
const largeMode = targetMiB === 288;
// Leave ten seconds for worker termination and temporary-file cleanup.
const budgetMs = largeMode ? 290_000 : 240_000;

// The large fixture is created inside the worker. Only short progress/results
// cross the boundary; the host never receives a full package or body string.
const workerSource = String.raw`
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { webcrypto } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { Library, freshLibraryName } from './src/mnemosyne/db';
import { synchronize } from './src/mnemosyne/canonical';
import { CoreBackups, BACKUP_MAX_BYTES } from './src/mnemosyne/core-backups';
import { exportLibrary } from './src/mnemosyne/migration';
import { fingerprint } from './src/mnemosyne/model';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const MiB = 1024 * 1024;
const stages = [];
const workerResources = {
    workerHeapLimitBytes: getHeapStatistics().heap_size_limit,
    customHeapLimit: /--max[-_]old[-_]space[-_]size/.test([...process.execArgv, process.env.NODE_OPTIONS ?? ''].join(' ')),
};
parentPort.postMessage({ type: 'resources', ...workerResources });
let peakSampledWorkerHeap = 0;
function memory() {
    const usage = process.memoryUsage();
    peakSampledWorkerHeap = Math.max(peakSampledWorkerHeap, usage.heapUsed);
    return { heapUsedBytes: usage.heapUsed, externalBytes: usage.external, rssBytes: usage.rss };
}
async function stage(name, task) {
    parentPort.postMessage({ type: 'phase', name, state: 'started' });
    const start = performance.now();
    const result = await task();
    const entry = { name, elapsedMs: +(performance.now() - start).toFixed(1), ...memory() };
    stages.push(entry);
    parentPort.postMessage({ type: 'phase', name, state: 'finished', elapsedMs: entry.elapsedMs });
    return result;
}

async function importThroughProductionWorker(blob) {
    // Execute the real import entrypoint in this Node worker. Only the Web Worker
    // message transport is simulated; parsing, checks and restore are production.
    const previousSelf = globalThis.self;
    const messages = [];
    let guardCalls = 0;
    const host = {
        onmessage: undefined,
        postMessage: message => {
            messages.push(message);
            if (message.type !== 'rpc') return;
            assert.equal(message.method, 'guard', 'Raw import must not access native backup files');
            guardCalls++;
            queueMicrotask(() => host.onmessage({ data: { type: 'reply', id: message.id, result: true } }));
        },
    };
    globalThis.self = host;
    try {
        await import('./src/mnemosyne/core-backup.worker');
        assert.equal(messages[0]?.type, 'ready');
        await host.onmessage({ data: { type: 'start', job: { kind: 'import', blob } } });
        const last = messages.at(-1);
        if (last?.type === 'failed') throw new Error(last.error);
        assert.equal(last?.type, 'done');
        assert.equal(last.result.state, 'restored');
        assert(guardCalls >= 2, 'Production import must check its lifecycle guard');
        return Library.open(last.result.library, true);
    } finally {
        if (previousSelf === undefined) delete globalThis.self;
        else globalThis.self = previousSelf;
    }
}

async function main() {
    assert(BACKUP_MAX_BYTES > 64 * MiB, 'Run this probe after raising the core-package limit');
    assert(BACKUP_MAX_BYTES > workerData.targetMiB * MiB, 'The configured package limit must fit this probe plus its metadata');
    const files = new Map();
    const io = { reads: 0, writes: 0, removes: 0 };
    const disk = {
        list: async () => [...files.keys()],
        read: async key => { io.reads++; assert(files.has(key), 'Missing synthetic backup'); return files.get(key); },
        write: async (key, blob) => { io.writes++; assert(!files.has(key), 'Unexpected overwrite'); files.set(key, blob); },
        remove: async key => { io.removes++; files.delete(key); },
        readSettings: async () => undefined,
        writeSettings: async () => { throw new Error('The probe must not write settings'); },
    };
    let lib = await Library.open(freshLibraryName());
    const originalLibraryName = lib.db.name;
    const ownedLibraries = new Set([originalLibraryName]);
    const discardOwnLibrary = async copy => {
        const name = copy.db.name;
        assert(ownedLibraries.has(name), 'Only this probe\'s fresh synthetic libraries may be removed');
        copy.close();
        await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = resolve;
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Synthetic library cleanup blocked'));
        });
        ownedLibraries.delete(name);
    };
    let backups, restored, rawRestored;
    try {
        await stage('create-synthetic-library', async () => {
            // Approximately 4 MiB per message avoids one pathological giant scalar.
            // Unicode markers exercise real UTF-8 byte counting as well as ASCII.
            const count = Math.ceil(workerData.targetMiB / 4);
            const bodyChars = Math.floor(workerData.targetMiB * MiB / count);
            const unit = 'Synthetic backup body. No private conversation or user data. ';
            const repeated = unit.repeat(Math.ceil(bodyChars / unit.length)).slice(0, bodyChars);
            const messages = Array.from({ length: count }, (_, index) => ({
                key: 'size-probe-' + index, role: index % 2 ? 'assistant' : 'user',
                content: '合成测试🙂 ' + index + '\n' + repeated, swipe: 0,
            }));
            await synchronize(lib, { scope: 'synthetic-backup-size-probe', messages, memories: [] });
        });
        const original = await stage('export-original', async () => {
            const pack = await exportLibrary(lib);
            const bytes = new Blob([JSON.stringify(pack)]).size;
            assert(bytes > 64 * MiB && bytes < BACKUP_MAX_BYTES, 'Synthetic package must exceed the former limit and fit the new one');
            return { bytes, version: pack.version, digest: await fingerprint(pack.data), counts: pack.counts };
        });
        backups = new CoreBackups(disk);
        const saved = await stage('save-and-verify-persisted-file', () => backups.save(lib, 'manual'));
        assert.equal(saved.state, 'saved');
        assert(saved.entry.bytes > 64 * MiB && saved.entry.bytes <= BACKUP_MAX_BYTES);
        if (!workerData.largeMode) await stage('read-and-validate-file', async () => {
            // CoreBackups.read runs the production strict JSON decoder, checksums
            // and full domain validation on the actual >64 MiB serialized Blob.
            const read = await backups.read(saved.entry.key);
            assert.equal(await fingerprint(read.file.pack.data), original.digest);
            // Strict JSON deliberately creates null-prototype dictionaries.
            assert.deepEqual({ ...read.file.pack.counts }, { ...original.counts });
        });
        if (workerData.largeMode) await stage('release-synthetic-source-before-restore', async () => {
            await discardOwnLibrary(lib);
            // fake-indexeddb's closed connection still owns _rawDatabase and all
            // its JS records. Also release this Library's weak observation cache.
            // Dropping handles makes them collectible; it does not force GC.
            lib = undefined;
        });
        restored = await stage('restore-fresh-library', () =>
            backups.prepareRestore(saved.entry.key, saved.entry.checksum));
        ownedLibraries.add(restored.db.name);
        assert.notEqual(restored.db.name, originalLibraryName);
        const rawBlob = await stage('verify-restored-roundtrip-and-export-raw', async () => {
            const copy = await exportLibrary(restored);
            assert.equal(await fingerprint(copy.data), original.digest);
            assert.deepEqual({ ...copy.counts }, { ...original.counts });
            return new Blob([JSON.stringify(copy)], { type: 'application/json' });
        });
        assert.equal(files.size, 1);
        assert.equal(io.writes, 1);
        assert.equal(io.removes, 0);
        assert(rawBlob.size > 64 * MiB && rawBlob.size <= BACKUP_MAX_BYTES);
        await stage('release-verified-synthetic-copies', async () => {
            // Release the two verified fake databases and envelope before making
            // another restore copy. These names were created by this probe only.
            await discardOwnLibrary(restored);
            restored = undefined;
            if (lib) { await discardOwnLibrary(lib); lib = undefined; }
            files.clear();
            // CoreBackups' completed writer-queue Promise retains its last result,
            // which here is the restored Library. The real Worker ends after one
            // job; this multi-job probe must release its manager before raw import.
            backups = undefined;
        });
        rawRestored = await stage('import-raw-through-production-worker', () => importThroughProductionWorker(rawBlob));
        ownedLibraries.add(rawRestored.db.name);
        await stage('verify-raw-import-roundtrip', async () => {
            const copy = await exportLibrary(rawRestored);
            assert.equal(await fingerprint(copy.data), original.digest);
            assert.deepEqual({ ...copy.counts }, { ...original.counts });
        });
        return {
            scope: 'Node worker_threads; fake-indexeddb; in-memory Blob disk; synthetic data only',
            targetBodyMiB: workerData.targetMiB, rawPackageBytes: original.bytes,
            backupFileBytes: saved.entry.bytes, limitBytes: BACKUP_MAX_BYTES,
            rawImportedBytes: rawBlob.size, rawImportEntrypoint: 'core-backup.worker.ts; guard messages simulated inside the Node worker',
            packageVersion: original.version, io, stages,
            peakWorkerHeapAtStageBoundariesBytes: peakSampledWorkerHeap,
            workerHeapLimitBytes: workerResources.workerHeapLimitBytes,
            probeMemoryPolicy: {
                forcedGc: false, customHeapLimit: workerResources.customHeapLimit,
                sourceFakeDatabaseReleasedBeforeRestore: workerData.largeMode,
                closedDatabaseHandlesCleared: true,
                additionalStandaloneRead: !workerData.largeMode,
                persistedReadbackAndRestoreRead: true,
            },
            roundtrip: 'passed', rawImportRoundtrip: 'passed',
        };
    } finally {
        rawRestored?.close();
        restored?.close();
        lib?.close();
        files.clear();
    }
}
main().then(result => parentPort.postMessage({ type: 'done', result }),
    error => parentPort.postMessage({ type: 'failed', error: error?.stack ?? String(error) }));
`;

async function main() {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mnemosyne-backup-size-'));
    let worker, heartbeat, sampler, timeout, measurement;
    try {
        const filename = path.join(temporary, 'worker.cjs');
        await build({
            stdin: { contents: workerSource, resolveDir: root, sourcefile: 'backup-size-probe.ts', loader: 'ts' },
            outfile: filename, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
            tsconfig: path.join(root, 'tsconfig.json'), logLevel: 'silent',
        });
        // Compilation is deliberately outside the responsiveness measurement.
        const start = performance.now();
        let last = start, beatCount = 0, maxGapMs = 0, gapsOver50Ms = 0;
        const initialRss = process.memoryUsage().rss;
        let peakRss = initialRss;
        let phase = 'worker-startup', workerResources;
        const hostResources = { reportedTotalMemoryBytes: os.totalmem(), reportedFreeMemoryBytes: os.freemem() };
        measurement = () => ({
            targetBodyMiB: targetMiB, elapsedMs: +(performance.now() - start).toFixed(1), phase,
            hostHeartbeat: { intervalMs: 10, count: beatCount, maxGapMs: +maxGapMs.toFixed(1), gapsOver50Ms },
            processMemory: { samplingIntervalMs: 100, initialRssBytes: initialRss, peakSampledRssBytes: peakRss },
            hostResources, workerResources, budgetMs,
        });
        const sampleRss = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
        heartbeat = setInterval(() => {
            const now = performance.now(), gap = now - last;
            last = now; beatCount++; maxGapMs = Math.max(maxGapMs, gap);
            if (gap > 50) gapsOver50Ms++;
        }, 10);
        sampler = setInterval(sampleRss, 100);
        worker = new Worker(filename, { workerData: { targetMiB, largeMode } });
        const result = await new Promise((resolve, reject) => {
            let done = false;
            timeout = setTimeout(() => reject(new Error('Synthetic size probe exceeded its ' + budgetMs / 1000 + '-second budget')), budgetMs);
            worker.on('error', reject);
            worker.on('exit', code => { if (!done) reject(new Error('Worker exited before completion, code ' + code)); });
            worker.on('message', message => {
                sampleRss();
                if (message.type === 'resources') {
                    const { type, ...resources } = message;
                    workerResources = resources;
                } else if (message.type === 'phase') {
                    phase = message.name + ':' + message.state;
                    console.error(message.name + ': ' + message.state +
                        (message.elapsedMs === undefined ? '' : ' (' + message.elapsedMs + ' ms)'));
                } else if (message.type === 'failed') reject(new Error(message.error));
                else if (message.type === 'done') { done = true; resolve(message.result); }
            });
        });
        sampleRss();
        console.log(JSON.stringify({
            status: 'passed', ...result, ...measurement(),
            limitations: 'RSS includes the complete Node process and fake IndexedDB stores, not just backup working memory; samples may miss short peaks. Large mode releases the synthetic source before restore but does not force GC or raise the default heap limit. Heartbeat measures this Node host only, not browser rendering, TT native IO, phone memory pressure, or 20-file rotation.',
        }, null, 2));
    } catch (error) {
        if (measurement) console.log(JSON.stringify({ status: 'failed', ...measurement(), error: error?.stack ?? String(error) }, null, 2));
        throw error;
    } finally {
        clearInterval(heartbeat); clearInterval(sampler); clearTimeout(timeout);
        if (worker) await worker.terminate();
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
