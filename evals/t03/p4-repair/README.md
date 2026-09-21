# T-03 P4/P5 repair evidence

Baseline: main@fc3264b. Synthetic fixtures only. Final implementation uses 1024 references per directory batch, a 512-entry registered-reference cache, and hard temporary limits of 16384 candidate pages / 16MiB. No physical-page deletion or format migration.

- `before-summary.json`: actual first four old-implementation failures and initial repair pass, summarized from tool output; not a TAP transcript.
- `regression.tap`: final 333/333, preserving the original 322 tests. `focused.tap` is an earlier focused run, not final-source evidence.
- `compat.json`: fc3264b package reader/writer in both directions with current code; logical content, checkpoint and operation receipt matched.
- `small-before.json`, `small-after.json`, `small-128-final.json`, `small-final.json`: layered measurement before optimization, intermediate 128 batch, and final 1024 batch. Generated UUIDs remain normal runtime UUIDs, so tree shape counts can vary slightly.
- `resource-128-1x.json`: intermediate Node result that justified increasing the explicitly bounded reference batch. Its preserved package is `.t03-local/p4/p4-repair-128-1x.ndjson`; the path inside the original report is the original run path.
- `resource-1x.json`: final Node original 1x, with original heap/RSS/time/node/package/disk limits. Counters aggregate native/provider call duration, not mutually exclusive elapsed-time partitions.
- `20260921r2-*`: intermediate 128-batch native fault evidence. `20260921r3-*`: final 1024-batch native publish-before / published-before-ack crash and recovery. Exit records are cleanup, not fault evidence.
- `native-deploy-final.json`: deployed source hashes for final native tests. `native-before.json`: disk/data-root baseline before final native 1x.
- `native-r1-*`: invalid initial collector run due sandbox EPERM; no persistence conclusion. Its library remains preserved.
- `20260921r4-p4-resource.json`: final native original 1x stopped on the original elapsed-time assertion; last reported growth was 20/32. User reported resizing TT and interacting with other apps/window stacking during this run; timing impact was not measured. Do not attribute the stop solely to the algorithm or claim an uncontaminated benchmark. The exit JSON is guarded cleanup, not crash-recovery evidence. Libraries are retained.

Host: isolated TT 367b0c7e9410, executable SHA256 11a9bc110da5dc634ff8c0b7b8fe244110c360af46693e50de67968cb811f2c4. Automatic maintenance remains HOST_MAINTENANCE_UNSUPPORTED. Mobile and 5x/10x are not covered by these runs. See the task and repair handoff for final 1x status.
