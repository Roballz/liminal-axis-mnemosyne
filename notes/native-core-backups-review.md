# Native core backup implementation receipt — 2026-10-12

Status: **implemented_unverified**. No commit, push, phone mutation, or TT application patch was performed for this task.

## Included source changes

New backup-owned files:

- `src/st/native-backups.ts` and `.test.ts`: fixed native API namespace adapter; no browser-store/network fallback
- `src/mnemosyne/core-backups.ts` and `.test.ts`: consistent core snapshots, file validation, per-library banks, protected copies, loss guards and bounded automatic retention
- `src/mnemosyne/core-backup-runtime.ts` and `.test.ts`: default-off settings, foreground scheduling, debounce/backoff, stale generation/lifecycle guards
- `src/components/CoreBackupPanel.vue`: enablement disclosure, backup preview, explicit protected baseline/pin, confirmed recovery
- `docs/18-native-core-backups.md`: exact host contract, safety limits, recovery and full-data export scope

Narrow integration:

- `src/index.ts`: import backup runtime and invoke after `bindDaily()` with pending/error/conflict/tableError guard and generation/revision/tableRevision stamp
- `src/pages/archive/index.vue`: import and mount `CoreBackupPanel` immediately before existing data-package section; the source-difference length display edit belongs to current-body work
- `src/mnemosyne/bridge.ts`: `serializeDailyActivation` helper only belongs to backup recovery; remaining reply-finality changes belong to their owner
- `src/mnemosyne/bridge.test.ts`: two recovery tests cover writer drain/latched failure and old host binding plus empty active DB; remaining guard tests belong to their owner
- `src/mnemosyne/db.ts`: previous rejected open/old-connection cleanup must not turn committed activation into failure; DB_VERSION bump belongs to current-body work
- `src/mnemosyne/db-activation.test.ts`: two actual export/restore activation regressions, contributed by current-body owner

No other current-body/core schema or migration behavior was changed for backups.

## Verification

Candidate frozen before event-membership UI work. Exact final code checks:

- `vue-tsc --noEmit`: passed
- `npm run build`: passed, 193 modules, existing large-chunk warning only
- `npm test`: **51 files / 685 Vitest tests passed**
- `test-time-rel.mjs`: 810 assertions passed
- `test-vector-depth.mjs`: 12 assertions passed
- `test-memory-regressions.mjs`: 53 assertions passed
- Dedicated backup/native adapter/runtime suite: 20 tests; extra db activation tests: 2; extra bridge recovery tests: 2

Frozen production output checksums:

- `dist/index.js`: `05b8191c1103a365b6f8dae35803418f9b70db4b73d91add0a292be22a9e9472`
- `dist/index.css`: `09f5c49354a213d67b459df53bd9e0764a10560dbe34bbaa0c6aba0042deeaf5`

Do not copy these generated bundles over later event-membership work. Final combined publication requires a fresh build of that combined candidate.

## User-facing behavior

Entry: **档案 / 迁移 → 本机磁盘核心包备份 → 检查接口 / 读取备份列表 → 启用自动备份**. Default OFF, default 10 per library (5 optional), automatic snapshots at least 30 minutes apart while foreground. Unchanged data does not generate duplicates. Manual, pinned and pre-restore files are additional protected copies; old library banks are not auto-deleted.

Restore explicitly confirms a new verified library switch, then ordinary current-host archive synchronization. It does not rewrite host chat, but may update restored current bodies and mark derived records for review. The original IndexedDB library and selected native snapshot remain.

Settings corruption cannot hide the recovery list; uncertain settings writes explicitly warn that restart may use previously saved settings. Empty/invalid/shrunken cores and unreadable native files stop automatic rotation. File contents are local plaintext.

Pinned TT `007abf7f1edfff275cf2a0182bf19179bcef087a` source confirms **数据迁移 → 导出当前数据** routes to full data-root export and includes these `_tauritavern/extension-store` files. Single-user backup does not. Full exports can include credentials and must be stored privately. See source links in `docs/18-native-core-backups.md`.

Not verified: Android UI clicks, real native file write/readback, mobile heap/low-space behavior, process kill or power loss, actual full-data export, and real user-data recovery. Native API promises atomic single-file publication, not power-loss durability. No source/derived/global plugin writer transaction is claimed; restore serializes source synchronization and guards public revisions while preserving old DB data.
