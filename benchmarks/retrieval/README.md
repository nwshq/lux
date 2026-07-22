# Retrieval Benchmark Harness

This harness runs real-repo Lux retrieval questions against explicit corpus roots and records evidence-bearing results. It is the Phase 5 gate for retrieval promotion: new retrieval breadth should be driven by benchmark failures, not by speculative detector expansion.

## Run

```bash
npm run benchmark:retrieval
```

Optional flags:

```bash
npx tsx benchmarks/retrieval/run.ts \
  --fixture benchmarks/retrieval/fixtures/auctic-core.json \
  --out benchmarks/retrieval/results/manual-run
```

## What it validates

- Dedicated overlay JSON remains native/unwrapped.
- Successful retrieval keeps direct evidence and context distinct.
- Ambiguous or unresolved retrieval refuses honestly and exits nonzero.
- Each repo matrix captures `lux index status --json` first so trust/state is part of the result.
- Every command uses explicit `--corpus`; no global/default corpus behavior is allowed.

## Fixtures

Fixture files live in `benchmarks/retrieval/fixtures/` and define:

- `repoId` — stable name for the repository.
- `repoPath` — explicit corpus root.
- `cases` — retrieval/status questions and expected structural outcomes.

Cases may target these surfaces:

- `feature-path`
- `operational`
- `status`
- `spec-evidence`
- `delta` — `lux delta --json` diff-scoped structural delta (spec 14/15/16). Case fields mirror the
  CLI flags: `base`, `committedOnly`, `depth`, `maxNodes`, `check`, `failOn`. Expectations cover the
  envelope (`deltaSchemaVersion`, `deltaSurface`, `minTouchedFiles`/`minTouchedSymbols`,
  `minModulesChanged`, `minEntrySurfaces`, `deltaTruncated`, `deltaGateCategoriesInclude`) and the
  SC-9 empty-not-errored contract on non-PHP repos (`emptyEntrySurfaces`,
  `emptyOwnershipTransitions`, `emptySpecTargets`). Delta cases are live-repro: the corpus needs a
  current `.lux` index (`lux index rebuild`) so the default base (`last_indexed_commit`) is reachable.

Modes:

- `overlay` — dedicated overlay seam.
- `status` — `lux index status --json`.
- `delta` — `lux delta --json`.

## Output

Each run writes a timestamped directory under `benchmarks/retrieval/results/` by default:

- `summary.json` — aggregate pass/fail summary and compact per-case result.
- `<repoId>/status.json` — status/trust/runtime snapshot for the repo.
- `<repoId>/<caseId>.stdout.txt` — raw stdout.
- `<repoId>/<caseId>.stderr.txt` — raw stderr.

`benchmarks/retrieval/results/` is ignored and intended for generated output. Copy selected summarized reports into CORPUS when preserving validation evidence.

## Phase 5 gate contract

Before promoting new retrieval breadth, run the full harness and preserve a compact report in CORPUS. The report should include:

- Lux commit/tag.
- Benchmark command and output directory.
- Per-repo pass totals.
- Status snapshot summary: overlay mode, corpus source, DB source, surface count, knowledge entries.
- Any failure messages and the follow-up decision.

A passing Phase 5 gate requires explicit corpora and repo-local DB defaults unless a fixture intentionally tests an override. The runner validates `index status --json` runtime metadata so accidental fallback to implicit/global state is visible.
