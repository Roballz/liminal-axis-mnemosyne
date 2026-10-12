# Read-only archive rescue implementation receipt

Status: implemented_unverified. Base 8d59735c (normal 1.3.15); dedicated rescue branch only. No user device or real RP accessed. No data recovery or selector change implemented.

Implementation: isolated two-module cold rescue entry; current-origin and selector read; database enumeration; existing-known-database open with upgrade abort and late-connection close; one readonly transaction per count/export snapshot; all-store counts; known archive-store raw key/value export with explicit unknown omissions; tagged structured-clone serialization; mobile-sized controls with privacy acknowledgement and known-hot-runtime rejection. Build emits rescue-only manifest and unique dist/rescue.js; original dist/index.js is unchanged and not loaded by rescue manifest.

Checks actually run:
- Final npm test (rerun after test additions): 44 files / 628 tests passed, including all 12 rescue tests; timeRel 810 assertions, vector depth 12 assertions, memory regressions 53 assertions
- Two focused read-timeout/error tests and File preservation assertion included; npx vitest run src/rescue/storage.test.ts: 12/12 passed
- npx tsc --noEmit: passed on final source/tests
- npm run build:rescue: passed, 2 modules, 16.70 KB artifact
- Compiled manifest/bundle assertions: no hooks/interceptor; auto_update false; unique entry; no normal boot/network/localStorage writes
- Independent read-only safety reviewer reported no blocker, requested timeout/error tests now included

Not run: actual Android UI/download, TT installation flow on user's device, user archive reads, recovery/import, huge-library memory stress. Missing-selector UI is source-reviewed only. No cross-context quiescence claim: user must close old contexts and cold-start; detection is only a warning/rejection aid. Unknown stores are counted, not exported; rescue JSON is not a standard core package.

Data impact: no DB writes/deletes/migrations/selector writes from rescue code, no uploads or host state changes. Package installation only changes extension files through host-managed branch switching. Rollback by returning to ordinary branch restarts ordinary automated functionality; defer until diagnosis and user decision. Do not uninstall/clear application data. Follow docs/archive-rescue.md for exact cold-start order and privacy notes.
