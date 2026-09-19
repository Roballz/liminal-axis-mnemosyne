# G1-R1/R2 repair evidence

Baseline: main@26f41713a6fd178162c2b633f419bbc67f526726. Windows / Node v24.19.0.

- before.tap: initial 18 targeted tests against unchanged implementation; 10 pass, 8 fail. The test file subsequently gained one close-retry case and an additional stale-native-IO assertion; these additions were not part of this red run.
- after.tap: original 131 tests plus 19 targeted regressions; 150 pass, no failures or skips. The two old same-owner close/recover assertions now require OWNER_CLOSED and verify retained state through a replacement owner.
- Native close-failure behavior is simulated by a namespace-dispatching mock, including failure before closing and after closing but losing the acknowledgement. These are not real TT IO failures.
- native-20260919g1.json: fixed TT Canary `367b0c7e9410` isolated run. Retired owner recover/read/native IO returned `OWNER_CLOSED`/`STALE_HANDLE`/`OWNER_CLOSED`; replacement reopen retained two confirmed operations. Missing root tip and an existing null payload both returned `NEEDS_RESOLUTION`; each namespace retained 20 physical nodes.
- after-final.tap: final full command result, 150/150 passed with zero failures, cancellations, or skips.
- syntax-final.json: 23 related `.mjs/.js` files passed `node --check` on Node `v24.19.0`.
- repair-hashes.json: source/deployed-harness/native-evidence SHA-256 comparison.

The parent `evals/t03/verification.json` and `evals/t03/native/` records remain the first submission's evidence and are not relabeled as repair evidence. G1 remains closed to P3; Chat review still decides whether to accept the repair and release the next increment.
