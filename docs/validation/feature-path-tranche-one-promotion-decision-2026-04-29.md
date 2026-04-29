# Feature-Path Tranche-One Promotion Decision - 2026-04-29

Branch: `feat/feature-path-retrieval-tranche-1`
Validation report: `docs/validation/feature-path-tranche-one-2026-04-29.md`
Plan: `CORPUS/.../payloads/2026-04-28-feature-path-retrieval/11-VALIDATION-AND-PROMOTION-PLAN.md`

Per the tranche-end exit decision required by R14, three options are available:

1. **Promote** feature-path retrieval into a broader `ask` / router surface.
2. **Run one more narrow quality pass.**
3. **Defer promotion** because benchmark proof is still not strong enough.

## Decision

**Option 2 — run one more narrow quality pass.**

Promote on the next tranche, gated on two specific items below. Do not promote into the broader `ask` / router yet.

## Why not "promote now"

The substrate proves out: the answer surface separates direct evidence from context, refuses honestly when cross-language consumers are naming-only, recovers strong handler / contract / downstream answers on real repos. The schema is locked. The failure taxonomy works.

But two gaps would degrade operator trust the moment we widen the audience:

### Gap 1 — Resolver fall-through silently mis-targets English-wrapped questions

`resolveFeaturePathTarget` falls through to the `contains` tier when a question contains English wrapping (e.g. `"what handles POST /private-offers?"`). The bidirectional `includes` check there matches `surface:http:GET:/` — single-character `/` is included in any path-bearing query — and the answer renders with a confident `Resolution Match: contains` for the **wrong route**.

Verbatim from the validation run:

```
Lux resolved GET / but did not recover a handler.
Confidence: none
Resolution Match: contains
```

There is no failure class on the answer payload that flags this — `failures = []` for the resolution itself, then cascades into `missing-handler-recovery` on the wrong target. An operator reads the failure as "this route has no handler" rather than "the resolver picked the wrong route." That is exactly the kind of confident-but-wrong behavior R6 was written to prevent.

This is the gating issue. Promotion before fixing it puts a confidently mistargeted answer in front of every operator who phrases a question naturally.

### Gap 2 — No operator-facing CLI seam

The validation was driven through `scripts/run-feature-path-benchmark.ts` — a TS harness. There is no `lux overlay feature-path ask <question>` command yet, so promotion into a broader `ask` / router has nothing to plug in. The seam should mirror `lux overlay operational ask` (same flag shape, same JSON contract) so operators reason in one style across both surfaces.

Without a seam, "promote into broader ask" is a no-op; with one, the next tranche can simply route from `lux ask` into the same handler.

## What "one more narrow quality pass" must contain

Strictly two items. No surface growth, no new detectors, no broader contract changes.

### Item 1 — Tighten resolution OR add `resolution-too-loose` failure

Pick one of:

- **Tighten the resolver:** in `resolveFeaturePathTarget`, raise the `contains` tier's bar (require word-boundary matches, minimum form length ≥ 3 segments for path forms, drop the `normalizedQuery.includes(form)` direction). Verify no benchmark question regresses.
- **Add a `resolution-too-loose` failure class:** if the resolver lands on `contains` with very short forms, classify the answer as unresolved-with-suggestions and refuse a confident summary. This requires a contract bump (FEATURE_PATH_ANSWER_SCHEMA_VERSION = 2) and a new entry in `FEATURE_PATH_FAILURE_CLASSES`.

The first is preferred — it doesn't bump the schema and matches the spirit of "the resolver should refuse confidently, not pick wrongly."

### Item 2 — Wire a thin CLI seam

Add `lux overlay feature-path ask <question> [--json] [--target] [--corpus] [--db]` mirroring `lux overlay operational ask`. The seam:

- Calls `resolveFeaturePathTarget` → `inferFeaturePathIntent` → `assembleFeaturePathAnswer` → `renderFeaturePathAnswerText` / `Json`.
- Reuses `runtime-paths.ts` for `--corpus` / `--db` resolution.
- Honors `--json` to emit the full schema-validated payload.
- Does NOT add a new MCP tool yet; that belongs in a later tranche after the seam has run on real questions.

## Out of scope for the narrow pass

- Substrate dangling-edge issue (Miss class A in the validation report). The handler-recovery refusal is already honest; fixing the namespace resolution is the structural overlay's responsibility, not feature-path retrieval's.
- New intents, new detectors, new direct-evidence kinds, new context kinds. Tranche one's scope is locked (R11).
- Promotion into `lux ask` / router. That comes after the narrow pass and is its own tranche.
- Cross-language `shared-config` / `shared-event` bases. Their detectors don't exist yet; adding them would be a tranche of its own.

## Promotion bar for the next tranche

After the narrow pass lands, promotion into a broader `ask` / router surface requires:

- Both items above shipped.
- A second validation rerun (this report's questions plus any added during the narrow pass) showing:
  - English-wrapped questions either resolve correctly OR refuse with an explicit failure class — never confidently mis-target.
  - The CLI seam answers the benchmark questions verbatim from the harness's output.
- No regression in the 125 feature-path tests.
- No silent expansion of the answer contract.

Once those clear, promotion is justified.

## Tranche-one summary

The tranche delivered exactly what `02-FOUNDATION-AND-REQUIREMENTS.md` framed it as: a **retrieval productization** tranche, not a detector-count tranche. The answer surface is honest, separated, ownership-bearing, and trust-aware. It refuses honestly on real repos. The remaining work to promote is small and well-scoped — and naming that work explicitly is the point of this exit decision.

---

## Narrow Pass Completion Record — 2026-04-29

Both gating items from this decision shipped on the same date.

### Item 1 — Resolver tightened (no schema bump)

`src/scanner/associations/feature-path/resolve.ts` — the `contains` tier now guards the `normalizedQuery.includes(form)` direction with a specificity predicate (`hasSpecificPathContent`). A semantic form is only allowed to substring-match an English-wrapped query when:

- it has no slash at all (route names / symbol names), or
- it contains at least one alphanumeric or underscore character after some slash.

This rejects forms like `/`, `get /`, `post /`, and `surface:http:get:/` — exactly the forms that previously made any path-bearing query confidently target the root route.

Two regression tests were added in `src/scanner/associations/feature-path/__tests__/resolve.test.ts`:

- `does not let GET / mis-target an English-wrapped question about a deeper route`
- `does not let single-character forms match unrelated path-bearing queries`

Both fail without the fix and pass with it. The `FEATURE_PATH_ANSWER_SCHEMA_VERSION` was NOT bumped — this is a pure resolver fix, no contract change.

### Item 2 — CLI seam wired

New module: `src/cli/feature-path.ts` exporting `runFeaturePathAsk`.

New CLI command: `lux overlay feature-path ask <question...> [--json] [--target <fragment>]`.

The seam mirrors `lux overlay operational ask` exactly:

- Reuses `runtime-paths.ts` for `--corpus` / `--db` resolution (inherited from program-level options).
- Calls `resolveFeaturePathTarget` → `inferFeaturePathIntent` → `assembleFeaturePathAnswer` → `renderFeaturePathAnswerText` / `Json`.
- `--json` emits the schema-validated `FeaturePathAnswer` payload verbatim.
- Exits 1 when resolution status is `unresolved` or `ambiguous`, matching the operational seam's exit semantics.
- Does NOT add a new MCP tool. That belongs in a later tranche after the seam has run on real questions.

Five CLI tests added in `src/cli/__tests__/overlay-feature-path-cli.test.ts`:

- text rendering with direct evidence section
- `--json` payload schema validation
- bare `--target POST /offers` resolves via semantic-exact
- unresolved targets exit 1 and refuse honestly
- regression: English-wrapped questions cannot mis-target `GET /` at the CLI seam

### Verification

- All 1360 tests pass (was 1353 before the narrow pass — 7 new tests).
- All 127 feature-path tests pass (was 125 — 2 new resolver regressions).
- The gating benchmark question `what handles POST /private-offers?` against the acme Core DB now returns `Resolution: unresolved` with a candidate suggestion list and exit code 1, instead of the pre-fix `Lux resolved GET / but did not recover a handler. Resolution Match: contains` confident mis-target.
- A known-good route (`what handles POST /login?`) still resolves correctly via the `contains` tier (the acme Core dangling-edge substrate issue, Miss class A in the validation report, persists — explicitly out of scope for this pass).

### Promotion bar — assessment

| Gate | Status |
|---|---|
| Both narrow-pass items shipped | ✅ |
| Benchmark rerun shows English-wrapped questions either resolve correctly or refuse with an explicit failure class | ✅ refuses with `unresolved-target` failure |
| CLI seam answers the benchmark questions verbatim from the harness's output | ✅ same answer object, rendered identically |
| No regression in the feature-path tests | ✅ 127/127 pass |
| No silent expansion of the answer contract | ✅ no schema bump, no new failure class, no new direct-evidence kinds |

Per the promotion bar in this document, the tranche is now ready for promotion into a broader `ask` / router surface in the next tranche. Promotion itself remains scoped to its own tranche — this pass shipped only the gates.
