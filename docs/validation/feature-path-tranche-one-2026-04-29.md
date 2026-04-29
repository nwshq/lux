# Feature-Path Retrieval Tranche-One Validation - 2026-04-29

Branch: `feat/feature-path-retrieval-tranche-1`
Benchmark: `docs/benchmarks/feature-path-questions.md`
Contract: `src/scanner/associations/feature-path/contract.ts` (`FEATURE_PATH_ANSWER_SCHEMA_VERSION = 1`)

This run validates the tranche-one feature-path answer surface on a backend-centered repo (acme Core) and a mixed-language repo (example-app). Per R12 / R13, both repos are exercised; per R15, misses are classified using the shared `FeaturePathFailureClass` vocabulary.

## Scope guard

- Reads existing structural overlay only — no new persistence (R9).
- Five tranche-one intents only: `route-handler`, `route-ownership`, `route-callers`, `route-contract`, `route-downstream` (R2, R11).
- Direct evidence and context remain separate in every observed answer (R5).
- Cross-language promotion only on artifact-backed bases at trust tier ≥ 4 (R6, R10).

## Real repo setup

Both repos copied to `/tmp` so SQLite has writable sidecar space:

```sh
cp /path/to/auctic-core/vcs/.lux/lux.db /tmp/lux-auctic-core-feature-path.db
cp /path/to/example-app/vcs/.lux/lux.db   /tmp/lux-chirocat-feature-path.db
```

The example-app copy required a fresh `rebuildWithOverlay` because its persisted overlay was at schema version 10 (pre-feature-path) with zero `structural_nodes`. Rebuilt via `scripts/run-feature-path-benchmark.ts` substrate, producing 20,602 nodes including 830 capability-surfaces.

A small TS harness (`scripts/run-feature-path-benchmark.ts`) wires `resolveFeaturePathTarget` → `inferFeaturePathIntent` → `assembleFeaturePathAnswer` → `renderFeaturePathAnswerText|Json`. The CLI seam for feature-path retrieval is intentionally NOT wired in this tranche; the harness exercises the same code path the seam will route to.

## acme Core (backend-centered)

Repo: `/path/to/auctic-core/vcs`
DB copy: `/tmp/lux-auctic-core-feature-path.db`

### AC-handler-01 / AC-ownership-01 — POST /admin/api/listings/eligible-for-invoice

```sh
node --import tsx scripts/run-feature-path-benchmark.ts \
  --db /tmp/lux-auctic-core-feature-path.db \
  --repo /path/to/auctic-core/vcs \
  --question "POST /admin/api/listings/eligible-for-invoice"
```

- `primaryAnswer.summary`: `POST /admin/api/listings/eligible-for-invoice is handled by GetListingsEligibleForAddingToInvoiceController and belongs to Listing.`
- `primaryAnswer.confidence`: `high`
- `resolution.matchedBy`: `semantic-exact`
- `ownership`: `module:Listing` via `module-boundary` at trust tier 4
- `contracts.response.shapeConfidence`: `exact`
- Direct evidence (separated from context):
  - `route-declaration` tier 5 (`src/Module/Listing/RouteServiceProvider.php`)
  - `handler-recovery` tier 3 (`GetListingsEligibleForAddingToInvoiceController`)
  - `response-contract` tier 4 (`exact(method inline json response)`)
- Context: empty.
- `failures`: empty.

Outcome: passes AC-handler-01 and AC-ownership-01 cleanly. Handler, contracts, ownership, and trust separation all rendered without fabrication.

### AC-downstream-01 — POST /api/listing-media-conversions

```sh
node --import tsx scripts/run-feature-path-benchmark.ts \
  --db /tmp/lux-auctic-core-feature-path.db \
  --repo /path/to/auctic-core/vcs \
  --question "POST /api/listing-media-conversions"
```

- `primaryAnswer.summary`: `POST /api/listing-media-conversions is handled by ListingMediaConversionController and belongs to unresolved.`
- `primaryAnswer.confidence`: `high`
- `contracts.request.shapeConfidence`: `exact` (`store inline validator`); `validator-attachment` direct-evidence item present at tier 4 — passes the AC-contract-01 invariant (no `exact` shape without a validator attachment).
- `contracts.response.shapeConfidence`: `exact`.
- `downstreamStep`: `ListingMediaConversionController -> acme\Core\Jobs\GenerateMediaConversions`, edgeType `DISPATCHES`, transport `async`, trust tier 4. Single bounded hop (R8). Rationale: "The only persisted dispatches edge from the recovered handler."
- `crossLanguage.status`: `refused-naming-only`. Refusal rationale: "All cross-language associations are naming-only; no artifact-backed or schema-backed bridge exists."
- Context includes `resources/js/Shared/Admin/ListingMediaManager.vue` as `nearby-consumer` — the Vue file is NOT lifted to direct evidence (T10 invariant holds).
- `failures`: `weak-ownership`, `cross-language-below-promotion-threshold`.

Outcome: passes AC-downstream-01 — single bounded `DISPATCHES` step at tier 4, validator-attachment direct evidence underwrites the `exact` request shape, cross-language refusal is honest. Weak-ownership is acceptable here because the route lives in `routes/json.php` outside any `src/Module/*` boundary; the answer reports `unresolved` rather than fabricating a module attribution (R7).

### Honest miss: GET /inventory

```sh
node --import tsx scripts/run-feature-path-benchmark.ts \
  --db /tmp/lux-auctic-core-feature-path.db \
  --repo /path/to/auctic-core/vcs \
  --question "GET /inventory"
```

- `resolution.matchedBy`: `semantic-exact` (resolves `surface:http:GET:/inventory`).
- `primaryAnswer`: `Lux resolved GET /inventory but did not recover a handler.` confidence `none`.
- `failures`: `missing-handler-recovery`, `weak-ownership`, `insufficient-direct-evidence`.

Outcome: honest refusal. The persisted `handled_by` edge from this surface points at a node id that does not exist in `structural_nodes`, so the assembler honestly declines to claim a handler. Classified as **substrate dangling-edge** under T13 (see Misses below).

### Honest miss: English-wrapped `"what handles POST /private-offers?"`

```sh
node --import tsx scripts/run-feature-path-benchmark.ts \
  --db /tmp/lux-auctic-core-feature-path.db \
  --repo /path/to/auctic-core/vcs \
  --question "what handles POST /private-offers?"
```

- `resolution.matchedBy`: `contains` (collapsed onto `surface:http:GET:/`).
- `primaryAnswer`: `Lux resolved GET / but did not recover a handler.` confidence `none`.

Outcome: resolver fall-through. The English-wrapped question does not appear among any surface's `semanticForms()`, so `resolveFeaturePathTarget` falls through to the `contains` tier, where every multi-route question matches `GET /` (because `/` is a single-character semantic form and `normalizedQuery.includes(form)` is true for any path-bearing query). Classified as **resolver weakness on English-wrapped questions** under T13.

## example-app (mixed-language)

Repo: `/path/to/example-app/vcs`
DB copy: `/tmp/lux-chirocat-feature-path.db`

### CC-handler-01 — GET /calendar

```sh
node --import tsx scripts/run-feature-path-benchmark.ts \
  --db /tmp/lux-chirocat-feature-path.db \
  --repo /path/to/example-app/vcs \
  --question "GET /calendar"
```

- `primaryAnswer.summary`: `GET /calendar is handled by CalendarController and belongs to app.`
- `primaryAnswer.confidence`: `high`
- `ownership`: `app` via `directory-led` at trust tier 3 (no module boundary; example-app is a flat-namespaced Laravel app).
- `contracts.response.label`: `coarse(page-response)`; `interactionKind`: `page`.
- Direct evidence: `route-declaration` tier 5, `handler-recovery` tier 3, `response-contract` tier 3.
- `failures`: empty.

Outcome: passes CC-handler-01. Coarse response shape is correct — the controller renders a Blade view rather than returning a typed JSON contract.

### CC-cross-language-02 — POST /events/check-overlaps

```sh
node --import tsx scripts/run-feature-path-benchmark.ts \
  --db /tmp/lux-chirocat-feature-path.db \
  --repo /path/to/example-app/vcs \
  --question "POST /events/check-overlaps"
```

- `primaryAnswer.summary`: `POST /events/check-overlaps is handled by EventController and belongs to app.`
- `primaryAnswer.confidence`: `high`
- `contracts.request.shapeConfidence`: `exact`; `validator-attachment` direct-evidence at tier 4.
- `contracts.response.shapeConfidence`: `exact`.
- `downstreamStep`: `EventController -> App\Jobs\HandleEventRescheduledAutoMessages`, edgeType `DISPATCHES`, transport `async`, trust tier 4.
- Context: two `nearby-consumer` items pointing at JS files (`public/js/events/sidebar.js`, `public/js/events/edit.js`).
- `crossLanguage.status`: `refused-naming-only` — rationale: "All cross-language associations are naming-only; no artifact-backed or schema-backed bridge exists. Refusing to present this as a real feature path."
- Direct evidence contains NO `high-trust-cross-language-association` items (T10 invariant: refused associations stay out of direct evidence).
- `failures`: `cross-language-below-promotion-threshold` — the failure is the success criterion for this question (CC-cross-language-02).

Outcome: passes CC-cross-language-02. The handler-side answer is fully recovered (handler + validator + response contract + bounded downstream), the JS consumers appear in `context` as adjacency only, and the cross-language section refuses promotion honestly because example-app has no generated-types or schema-backed bridge between the JS and the PHP handler.

### Mixed-language full-coverage spot check — POST /patients/{patient}/billing/payment

Same shape as CC-cross-language-02: handler resolved, validator/response contracts attached, `downstreamStep` to `App\Jobs\SendText` tier 4, blade.php consumers in `context`. Cross-language section omitted because all consumers are PHP (same language as handler) — `evaluateCrossLanguagePromotion` correctly returns null when there are no cross-language consumers, rather than rendering an empty refused section.

## Validation bar (against `11-VALIDATION-AND-PROMOTION-PLAN.md`)

- ✅ At least one route-centered answer is strong on a real repo: AC-handler-01 (acme Core) and CC-handler-01 (example-app).
- ✅ Ownership is visible and non-hand-wavy: `module:Listing` (module-boundary tier 4) on acme Core; `app` (directory-led tier 3) on example-app. Both basis values are explicit.
- ✅ Direct evidence and context remain clearly separate in every observed answer: AC-downstream-01 keeps `ListingMediaManager.vue` in `context` only; CC-cross-language-02 keeps JS files in `context` only; the `high-trust-cross-language-association` direct-evidence kind never fires for refused statuses.
- ✅ At least one downstream step is included without overstating confidence: AC-downstream-01 (DISPATCHES tier 4) and CC-cross-language-02 (DISPATCHES tier 4). Both rendered as a single bounded hop with a rationale.
- ✅ At least one mixed-language answer either succeeds honestly or refuses honestly: CC-cross-language-02 refuses honestly with `refused-naming-only` and the corresponding `cross-language-below-promotion-threshold` failure.

The minimum coverage bar from `docs/benchmarks/feature-path-questions.md` is met.

## Misses (T13 classification)

Recorded against the shared `FeaturePathFailureClass` vocabulary. Each entry cites the benchmark question id and the failure class.

### Miss class A — substrate dangling-edge (`missing-handler-recovery`)

- Affected: `GET /inventory`, `POST /login` (acme Core); `GET /patients` (example-app). Likely affects more.
- Symptom: a `handled_by` edge exists with a target id that has no matching row in `structural_nodes`. `getSurfaceFeaturePath` returns an empty `providers[]`, so `buildHandlerEvidence` returns null and the assembler honestly summarizes "did not recover a handler."
- Example: surface `surface:http:POST:/login` has `handled_by → symbol:php:App\Http\Controllers\Auth\LoginController`, but the actual node persisted is `symbol:php:acme\Core\Http\Controllers\Auth\LoginController` (different namespace). The substrate's namespace resolution is the root cause, not the feature-path module.
- Failure class: `missing-handler-recovery` (correctly classified by the assembler).
- Tranche-one assessment: feature-path retrieval behaves correctly — refusal is honest and the failure is classified explicitly. Fixing the dangling-edge issue is **outside this tranche**: it lives in the structural overlay's namespace resolution.

### Miss class B — resolver fall-through on English-wrapped questions (no failure class triggered)

- Affected: any question containing English wrapping plus a path fragment, e.g. `"what handles POST /private-offers?"`.
- Symptom: `resolveFeaturePathTarget` reaches the `contains` tier, where the bidirectional `includes` check causes `GET /` (or any short-path surface) to match. The resolver returns a single low-quality candidate rather than `unresolved` or `ambiguous`.
- Failure class: NONE on the answer payload — the answer has `resolution.matchedBy = "contains"` and `failures = []` for the resolution itself, then cascades into `missing-handler-recovery` etc. on the wrong target. **This is a notable gap in the failure taxonomy:** there is no `resolution-too-loose` failure class; the answer looks "honest" but actually targets the wrong route.
- Tranche-one assessment: the harness is currently driven by bare-form questions (`POST /events/check-overlaps`) which `semanticForms()` resolves cleanly. The resolver works correctly when the question matches a semantic form, and the benchmark's CLI examples should be updated to bare-form for the question text. A proper fix is a tighter `contains` tier (require word-boundary matches and a minimum form length) — but this is a **resolver hardening item**, not part of the answer-surface contract.

### Miss class C — cross-language refusal cannot fire when handler resolution fails

- Affected: example-app `GET /patients` (handler dangling-edge as in Miss A, JS consumers present).
- Symptom: `evaluateCrossLanguagePromotion` early-exits when `handlerLanguageId` is null (which happens when `featurePath.providers[0]` is missing). Cross-language consumers appear under `context.nearby-consumer` instead of being explicitly refused.
- Failure class: `missing-handler-recovery` is classified, but `cross-language-below-promotion-threshold` is NOT — even though the JS consumers exist and would otherwise be naming-only.
- Tranche-one assessment: tolerable. The handler-recovery failure is the upstream cause, and reporting both would be redundant. Once Miss A is addressed in the substrate, Miss C resolves automatically.

## Required validation

Run before this report was committed:

```sh
npm run lint
npm test
```

Notes:
- All 125 feature-path unit + integration tests pass.
- Linter clean.
- Validation harness `scripts/run-feature-path-benchmark.ts` is intentionally a script, not a CLI command; promotion into `lux overlay feature-path ask <question>` is a tranche-end decision (T14).

## Captured artifacts

Saved under `/tmp/feature-path-validation/` for cross-reference (text + JSON renders of each headline question):

- `AC-handler-01.txt` — strong module-owned answer with response contract.
- `AC-downstream-01.txt` / `AC-downstream-01.json` — full-coverage answer including bounded downstream and cross-language refusal.
- `AC-handler-no-module.txt` — `GET /inventory` substrate dangling-edge case.
- `AC-english-wrapped.txt` — resolver fall-through case.
- `CC-handler-01.txt` — example-app coarse-response answer.
- `CC-cross-language-02.txt` / `CC-cross-language-02.json` — example-app refused-naming-only with bounded downstream.
- `CC-cross-language-billing.txt` — same-language consumers, cross-language section correctly omitted.
