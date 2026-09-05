# Real-corpus benchmark runners

The retrieval and bootstrap runners use the owner-approved portable corpus manifest at
`benchmarks/corpora/manifest.json`. Fixtures name a `corpusId`; they never contain a checkout path.
Before creating output, opening a DB, constructing a scanner, spawning Lux, running status, or
executing a case, each runner validates every selected fixture and invokes the T17 batch preflight
for all unique corpus IDs. Real corpora are always clean, detached isolated checkouts at their exact
manifest pins.

## Positive preflight control

```bash
npm run benchmark:retrieval
npm run benchmark:bootstrap -- --preflight-only
```

The retrieval default selects only `lux` and runs an index-independent refusal case. This case is
safe on the v2.16 pinned snapshot and does not claim indexed-content success. The runner uses a new
explicit temporary `--db` for status and every case command, so status and the case truthfully refuse
with an absent index while still proving the preflight-to-runner handoff. To test only
resolution/isolation without spawning Lux or creating output, use:

```bash
npm run benchmark:retrieval -- --preflight-only
```

## Selecting fixtures and checkouts

```bash
npm run benchmark:retrieval -- \
  --manifest benchmarks/corpora/manifest.json \
  --checkout-overrides /absolute/path/to/checkouts.json \
  --fixture benchmarks/retrieval/fixtures/auctic-core.json \
  --fixture benchmarks/retrieval/fixtures/auctic-core-anchors.json \
  --out benchmarks/retrieval/results/manual

npm run benchmark:bootstrap -- \
  --manifest benchmarks/corpora/manifest.json \
  --checkout-overrides /absolute/path/to/checkouts.json \
  --fixture benchmarks/bootstrap/fixtures/canonical-lux.json
```

The override file is strict JSON containing only a corpus-ID-to-path map, for example:

```json
{
  "lux": "~/Code/lux/vcs",
  "auctic-core": "/work/checkouts/auctic-core"
}
```

Unknown IDs, non-string values, unsafe IDs, unknown fixture fields required by a newer schema,
owner/schema/gold-version mismatches, duplicate case IDs, and unmet manifest `minimumCases` refuse
the whole run. Multiple retrieval fixture files may target one corpus (for example `auctic-core` and
its anchors fixture): their case counts are aggregated and that corpus appears only once in batch
preflight.

Historical `auctic-atlas` and `example-app` fixtures remain portable but are intentionally noncanonical.
They are never selected by default and explicit selection refuses unless an owner-approved supplied
manifest includes their pins. Do not add local or guessed pins to the canonical manifest.

## Isolation, outputs, and cleanup

- Retrieval invokes the current built CLI path outside the isolated v2.16 Lux corpus. It passes the
  isolated root as `--corpus` and a temporary explicit `--db` to every status/case command. It never
  reads or writes the source checkout's `.lux` database.
- Bootstrap constructs its database only under a temporary directory and writes memory/discovery
  reports only below `--out`; it never writes corpus `.lux`. The parked model-backed expert runtime
  remains unavailable, so bootstrap accepts only `--discovery-mode deterministic`.
- Prepared corpus checkouts and temporary DB directories are removed on success and failure. A
  cleanup error fails the run. `--keep-dbs` is intentionally refused.
- Generated retrieval output contains `summary.json`, `<repoId>/status.json`, and per-case stdout and
  stderr files. Bootstrap contains `summary.json` plus per-corpus memory/discovery reports.

The full retrieval fixture schema retains the existing feature-path, operational, status,
spec-evidence, delta, search, and anchors expectations. Existing historical gold is preserved; only
portable identity and Phase 5 ownership/version metadata were added.
