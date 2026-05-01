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

- Top-level `lux ask --json` envelope stability for promoted retrieval.
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

Modes:

- `ask` — top-level `lux ask`.
- `overlay` — dedicated overlay seam.
- `status` — `lux index status --json`.

## Output

Each run writes a timestamped directory under `benchmarks/retrieval/results/` by default:

- `summary.json` — aggregate pass/fail summary and compact per-case result.
- `<repoId>/status.json` — status/trust snapshot for the repo.
- `<repoId>/<caseId>.stdout.txt` — raw stdout.
- `<repoId>/<caseId>.stderr.txt` — raw stderr.

`benchmarks/retrieval/results/` is ignored and intended for generated output. Copy selected summarized reports into CORPUS when preserving validation evidence.
