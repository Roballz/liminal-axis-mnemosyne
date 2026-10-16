# Native edit summary controls: initial diagnosis snapshot

This records the initial diagnosis before implementation authorization. The subsequent candidate and final regression inventory are in `v1.4.9-native-edit-review.md`; diagnostic tests were consolidated into repair regressions rather than retaining obsolete expected failures.

Date: 2026-10-16. Investigated published Mnemosyne v1.4.8, commit `eb08dac5385cb08697c5d19ec996f38b7b8e2c0f`, branch `work/daily-memory-mvp-baibai`.

## Scope and environment

- Remote branch HEAD was checked with `git ls-remote origin` and fetched. Existing recovery directory was clean at v1.4.7; it was not reset or overwritten.
- Diagnostic worktree: `mnemosyne-edit-diagnosis-20261016`, detached at v1.4.8.
- At the time of this initial snapshot, production source was unchanged and only synthetic diagnostic tests plus this note were local. The later authorized implementation is recorded separately below. No publication was performed during diagnosis.
- User reports a complete assistant body followed by an API error suffix, then manually deletes the suffix and saves with the floor editor's native checkmark. Both edit-popup review buttons are gray; archive review actions are absent.
- The screenshot shows the exact `ReplyFinalityError` text and no affected-summary count.
- User's actual phone runtime, saved chat metadata, and installed TT build were not inspected. Findings below distinguish code-level reproduction from device evidence.

## Confirmed behavior and failure chain

The feature still requires manual summary retention or regeneration. It has not been replaced by automatic summary review.

1. `prepareSummaryEditPrompt()` first calls `syncDaily()` and `readDailyReview()` (`src/mnemosyne/summary-edit-prompt.ts:19-36`).
2. Both require `ReplyFinality.assertArchivable()` before returning current review data (`src/mnemosyne/bridge.ts:277-292,374-384`).
3. If any assistant body is unresolved, incomplete, or has a stale finality hash, the check throws. The popup catch opens the dialog with `count: 0`; its two buttons disable for `!prompt.count` (`src/components/SummaryEditPrompt.vue:17-18`).
4. Archive sync sets `pending=true`, status `回复未确认 · 暂不归档`, and clears the current projection (`src/mnemosyne/bridge.ts:682-696`). The review panel cannot load a current review list while pending (`src/components/SummaryReviewPanel.vue:35-60`).
5. Therefore the gray buttons are a consequence of the upstream body-confirmation failure, not evidence that summaries were automatically processed or deleted.

Deleting the visible error text alone does not clear the durable finality receipt. The intended native-save route is: trusted `.mes_edit_done` click -> capture current editor/floor/chat/swipe -> `MESSAGE_EDITED` validates saved text -> `MESSAGE_UPDATED` stamps `edited` and hashes the accepted body (`bridge.ts:902-919`, `reply-finality.ts:157-176`). Automatic or synthetic edits are intentionally not sufficient.

## Native-save gaps reproduced

### A. Completed processor with an unobserved UI end event

`ReplyFinality.edited()` rejects any current candidate when `!run.ended && !run.stopped`, without considering a terminal processor already observed for the same run (`reply-finality.ts:173-174`).

A synthetic run with a full body plus error marker, `MESSAGE_RECEIVED`, and a finished processor records `uncertain`. If the UI end event was not observed, removing the error suffix and clicking native save still fails this condition even after the host processor is removed. The old uncertain receipt remains and the screenshot's count-zero path follows.

This is a deterministic production-code gap, not yet a verified trace of the user's phone. A missing UI end event is an explicit repro condition, not a claimed observed fact.

### B. Popup opens before native save is finished

The popup listens to `MESSAGE_EDITED` and uses a fixed 350ms delay (`summary-edit-prompt.ts:64-77`). The actual acceptance happens at `MESSAGE_UPDATED`. If host content processing delays UPDATED, the popup can open with count zero before acceptance. A later valid UPDATED restores archiving, but the existing error popup has no success-triggered refresh.

This alone explains a stale gray popup; it does not explain a persistently pending archive after a successful final UPDATED.

### Other reproduced boundaries, not established as this incident's trigger

- A host edit-time regex/macro transformation changes textarea text before MESSAGE_EDITED; the exact-text check rejects the save. Native click itself can be valid.
- A different unresolved floor blocks the entire current observation, even when the edited floor was correctly accepted.
- The plugin's deferred `syncItemLogFromMessage()` can rewrite a managed `<bbs_items>` block after an accepted save; without reconciling the edited receipt, its body hash becomes stale. This requires the relevant leaf/managed sidecar/settings. It was not established for this user incident and is not automatically included in the two-fix scope.

## Upstream TT source evidence

Read current upstream main pinned at `f6126b4fc9243eb3990f2c0bad86e2afcb502f22`; this is not evidence of the user's installed build.

- `src/tauri/main/routes/ai-routes.js:232-340,525-537`: TT can convert upstream errors into normal assistant content / stream content with an API error label and append `[DONE]`. A success-shaped stream end therefore does not prove valid story content.
- `src/script.js:4451-4456`: `GENERATION_ENDED` is emitted when the stop button changes from visible to hidden.
- `src/script.js:9836-9884`: native save applies edit regexes, whitespace trimming, and macro substitution before writing the body.
- `src/script.js:10141-10171`: native save emits EDITED, renders/reconciles content, then waits for finalization before UPDATED and host save.
- `src/tauri/main/services/chat-surface/install.js:119-128`: content finalization awaits asynchronous content preparation before emitting UPDATED.

Source links:
- https://github.com/Darkatse/TauriTavern/blob/f6126b4fc9243eb3990f2c0bad86e2afcb502f22/src/script.js#L10141-L10171
- https://github.com/Darkatse/TauriTavern/blob/f6126b4fc9243eb3990f2c0bad86e2afcb502f22/src/script.js#L4451-L4456
- https://github.com/Darkatse/TauriTavern/blob/f6126b4fc9243eb3990f2c0bad86e2afcb502f22/src/tauri/main/routes/ai-routes.js#L525-L537
- https://github.com/Darkatse/TauriTavern/blob/f6126b4fc9243eb3990f2c0bad86e2afcb502f22/src/tauri/main/services/chat-surface/install.js#L119-L128

## Local tests

Diagnostic-only tests appended to `src/mnemosyne/bridge.test.ts:1375+` use synthetic text and fake IndexedDB. No user chat was imported or sent to an API.

Commands executed:

- `vitest run src/mnemosyne/bridge.test.ts -t 'DIAG:'`: 4 passed, 74 skipped
- `vitest run src/mnemosyne/bridge.test.ts -t 'DIAG-API:'`: 2 passed, 78 skipped
- `vitest run src/mnemosyne/bridge.test.ts -t 'DIAG-API-LIVE:'`: 2 passed, 80 skipped
- `vitest run src/mnemosyne/bridge.test.ts -t 'DIAG-API-NO-END:|DIAG-SIDECAR:|DIAG-DELAY:'`: missed-END and delayed-UPDATED cases passed; initial sidecar fixture failed to enter the managed-tag parser
- The sidecar fixture was corrected to use the actual standalone managed-tag format after a `bbs_end` boundary. `vitest run src/mnemosyne/bridge.test.ts -t 'DIAG-SIDECAR:'`: 1 passed, 84 skipped
- `vitest run src/mnemosyne/reply-finality.test.ts`: 21 passed

Thus all 11 final diagnostic cases were individually exercised successfully; no combined whole-suite run or phone test was performed. Normal completed/stopped/uncertain cases with both expected edit events correctly become `edited`, retain old summary content, and require manual review. They do not prove the production native lifecycle is correct.

## Proposed minimal repair, awaiting implementation authorization

Estimated production change: roughly 80-140 lines across reply finality, edit-prompt coordination, and focused blocker text. Regression tests: roughly 100-180 lines after consolidating diagnostics. No schema migration, database reset, archive recreation, or summary API is required for the fix itself.

1. Reconcile native-save authorization with verified terminal processor evidence from the same generation. Do not treat `processor === null`, missing END, or absence of an error string as completion. Keep non-stream runs without terminal evidence conservative.
2. Before stamping `edited`, continue to require a real native save intent, exact floor/message/chat/swipe correlation, unexpired intent, and stable saved body. Block any genuinely live processor and stale cross-generation result.
3. Drive edit-prompt preparation from the completed/accepted edit sequence, not only the EDITED+350ms timer. Cancel/reload an existing stale error dialog when that sequence successfully finishes, while respecting popup setting, defer action, scope, generation, and ticket guards.
4. Expose a body-free blocker floor and reason so an unresolved other floor or rejected save does not look like absent review functionality. Do not provide unconditional enable/auto-accept of error replies.
5. Regressions: error-suffix deletion + native save, missing UI END with terminal processor evidence, live processor rejection, synthetic/untrusted save rejection, delayed UPDATED and stale dialog, chat/swipe/new generation invalidation, another unresolved floor remaining blocked, no implicit summary keep/regenerate/API calls.

The independent item-sidecar/hash mismatch and transformed-text cases should remain explicit follow-up boundaries unless included in authorized repair scope. Do not silently broaden confirmation semantics.
