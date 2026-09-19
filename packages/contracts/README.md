# T-02 Reference Contracts

Status: implemented_unverified. Requires Node.js 24 (tested on 24.19.0).
No package installation, server, TT module imports, persistence, or model calls.

```powershell
node --test packages/contracts/tests/contracts.test.mjs
node --test apps/tt-adapter-probe/tests/probe.test.js
node --check apps/tt-adapter-probe/index.js
git diff --check
```

Import functions from `index.mjs`. `validate(type, value)` checks exact JSON
shapes; `validateState(state)` also checks references and historical transitions.
Use `commitHistory` for atomic *in-memory* history changes, `archiveMemory` and
`selectMemory` for immutable derivations/branch selections, `memoryStatus` and
`rebuildPlan` for scoped validity, and `canApply` for current prepare gating.
`exportLogical` / `importLogical` validate an in-memory logical package.

Public functions consume a previously validated state. Failed operations never
mutate it. Callers must not treat an archived memory as selected or applicable.
Adapters must supply fresh run/observation state before applying any response.
Fixtures use deterministic synthetic IDs and no real RP data.

This small oracle intentionally clones state and expands whole manifests.
Two-entry chunks only demonstrate sharing. It is not a production tree or a
performance baseline. No durable write acknowledgement, persistent job ledger,
automatic identity alignment, LLM rebuilding, field-level state graph, HTTP
authentication, UI, or raw JSON parser is implemented.

Field dictionary, four fingerprint projections, errors, migration limits, and
review questions: `../../docs/06-contracts.md`.
