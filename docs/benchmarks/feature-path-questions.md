# Feature-Path Retrieval Benchmark Question Set

**Tranche:** 1 (route- and handler-centered feature questions)
**Status:** Active — prospective benchmark for tranche-one validation runs
**Contract:** `src/scanner/associations/feature-path/contract.ts`
**Schema:** `schemas/feature-path-answer.schema.json`

This document is the named benchmark referenced by R12 and consumed by tranche-one validation (R13). It is durable: validation reports under `docs/validation/` cite back to the question IDs here so reruns are comparable across branches and revisions.

## Scope

Tranche-one feature-path retrieval answers exactly five intents:

| Intent             | Question shape                                       |
| ------------------ | ---------------------------------------------------- |
| `route-handler`    | what handles this endpoint?                          |
| `route-ownership`  | what part of the system owns this route or workflow? |
| `route-callers`    | where is this route called from?                     |
| `route-contract`   | what request and response shape does this imply?     |
| `route-downstream` | what downstream work does this feature trigger?      |

Detector expansion is NOT a tranche-one success criterion (R11). New question classes require their own tranche.

## Repos

| Repo              | Role             | Why                                                                                                                                                                            |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Acme Core         | backend-centered | Real Laravel monolith with module boundaries, jobs, listeners, schedules. Exercises every backend dimension of the answer (handler, ownership, contracts, bounded downstream). |
| Example App       | mixed-language   | Real PHP + JS/TS mixed-language repo with `calls_surface` edges. Exercises cross-language promotion: at least one promoted path AND at least one honest refusal.               |
| Example Dashboard | tiebreak only    | Used only if Acme Core leaves a backend dimension unproven.                                                                                                                    |

R13 requires both at least one backend-centered repo AND at least one mixed-language repo. Acme Core + Example App satisfies the bar; Example Dashboard is optional follow-on.

## Question entry shape

Each question below specifies:

- **id**: stable identifier (`AC-<intent>-NN` for Acme Core, `CC-<intent>-NN` for Example App).
- **intent**: one of the five tranche-one intents.
- **target kind**: expected `FeaturePathTarget.kind` — `route-surface` or `handler-symbol`.
- **must-have answer dimensions**: which top-level fields of `FeaturePathAnswer` are expected to be populated and non-trivial when the answer is healthy.
- **acceptable failure classes**: any of `FEATURE_PATH_FAILURE_CLASSES` that may legitimately appear without invalidating the answer.
- **disallowed failure classes**: failures that, if present, mean the answer is NOT healthy for this question.
- **CLI command**: invocation pattern (`overlay operational ask` for now; will move under a dedicated feature-path command at promotion time).

The benchmark is intentionally prescriptive about what MUST be present and what MUST NOT be reported as proof; that is the point of a benchmark question set rather than a freeform sample.

## Acme Core (backend-centered)

DB copy pattern (mirrors `docs/validation/operational-operator-surface-2026-04-27.md`):

```sh
cp /path/to/acme-core/vcs/.lux/lux.db /tmp/lux-acme-core-feature-path.db
```

All commands below use `--corpus /path/to/acme-core/vcs --db /tmp/lux-acme-core-feature-path.db`.

### AC-handler-01 — Module-controlled POST route

- **id:** `AC-handler-01`
- **intent:** `route-handler`
- **target kind:** `route-surface`
- **must-have:** `target`, `primaryAnswer.summary` names a controller `@method`, `directEvidence` includes `route-declaration` AND `handler-recovery`, `ownership.basis` is `module-boundary`.
- **acceptable failures:** none — this is the canonical route-handler question and must succeed cleanly.
- **disallowed failures:** `unresolved-target`, `ambiguous-target`, `missing-handler-recovery`.
- **command:**
  ```sh
  overlay operational ask "what handles POST /private-offers?" --json
  ```

### AC-handler-02 — Resourceful route by name

- **id:** `AC-handler-02`
- **intent:** `route-handler`
- **target kind:** `route-surface`
- **must-have:** resolution `matchedBy` is `exact` or `semantic-exact`, `primaryAnswer.confidence` is `high`, handler `filePath` resolves under a module directory.
- **acceptable failures:** none.
- **disallowed failures:** `unresolved-target`, `ambiguous-target`, `missing-handler-recovery`.
- **command:**
  ```sh
  overlay operational ask "what handles the auctions.update route?" --json
  ```

### AC-ownership-01 — Module-owned workflow

- **id:** `AC-ownership-01`
- **intent:** `route-ownership`
- **target kind:** `route-surface`
- **must-have:** `ownership.regionId` starts with `module:`, `ownership.basis` is `module-boundary`, `ownership.trustTier` is 4 or higher.
- **acceptable failures:** none.
- **disallowed failures:** `weak-ownership`, `unresolved-target`.
- **command:**
  ```sh
  overlay operational ask "what part of the system owns POST /private-offers?" --json
  ```

### AC-ownership-02 — Honest weak-ownership case

- **id:** `AC-ownership-02`
- **intent:** `route-ownership`
- **target kind:** `route-surface`
- **must-have:** `ownership` is populated; if the route lives outside any module, `ownership.basis` is `directory-led` or `unresolved` and `ownership.rationale` is present when `overlay-led`/`hybrid`.
- **acceptable failures:** `weak-ownership` — the benchmark explicitly accepts a clean refusal here over a fabricated module attribution.
- **disallowed failures:** `unresolved-target`, `missing-handler-recovery`.
- **command:**
  ```sh
  overlay operational ask "what part of the system owns the home route?" --json
  ```

### AC-callers-01 — Internal callers of a controller method

- **id:** `AC-callers-01`
- **intent:** `route-callers`
- **target kind:** `handler-symbol`
- **must-have:** `target.kind` is `handler-symbol`, `directEvidence` includes at least one item AND `context` is not lifted into proof, `trust.evidenceTrustTiers` is non-empty.
- **acceptable failures:** `insufficient-direct-evidence` IFF the handler genuinely has no persisted callers — refusal must be explicit.
- **disallowed failures:** items appearing in BOTH `directEvidence` and `context` for the same `nodeId` (R5/R6 violation).
- **command:**
  ```sh
  overlay operational ask "where is PrivateOfferController@store called from?" --json
  ```

### AC-contract-01 — Request and response shape

- **id:** `AC-contract-01`
- **intent:** `route-contract`
- **target kind:** `route-surface`
- **must-have:** `contracts` is non-null, `contracts.request.shapeConfidence` is `exact` if a FormRequest is attached, `contracts.response` populated when the handler structurally returns a known contract, `directEvidence` includes `validator-attachment` when `request.shapeConfidence` is `exact`.
- **acceptable failures:** `insufficient-contract-recovery` for actions that genuinely lack a typed request — but in that case `contracts.request.shapeConfidence` MUST be `coarse` or `contracts.request` MUST be absent (no fabricated `exact`).
- **disallowed failures:** an `exact` shape without a corresponding `validator-attachment` direct-evidence item (R6 violation).
- **command:**
  ```sh
  overlay operational ask "what request and response shape does POST /private-offers imply?" --json
  ```

### AC-downstream-01 — Job dispatch from handler

- **id:** `AC-downstream-01`
- **intent:** `route-downstream`
- **target kind:** `route-surface`
- **must-have:** `downstreamStep` is non-null, `downstreamStep.edgeType` is `DISPATCHES`, `downstreamStep.target.id` starts with `job:`, `downstreamStep.trustTier` is 4 or higher, `downstreamStep.rationale` is present.
- **acceptable failures:** none — this question is only meaningful if a downstream step exists.
- **disallowed failures:** more than one downstream step (R8 violation), `downstreamStep` populated for a sibling controller method's dispatch.
- **command:**
  ```sh
  overlay operational ask "what downstream work does POST /private-offers trigger?" --json
  ```

### AC-downstream-02 — Honest no-downstream case

- **id:** `AC-downstream-02`
- **intent:** `route-downstream`
- **target kind:** `route-surface`
- **must-have:** the answer renders without a downstream section when the handler dispatches nothing — `downstreamStep` is null and the renderer omits the slot.
- **acceptable failures:** none — silence on an empty downstream is the correct behavior, not a failure.
- **disallowed failures:** any fabricated downstream step on a read-only handler.
- **command:**
  ```sh
  overlay operational ask "what downstream work does GET /private-offers trigger?" --json
  ```

## Example App (mixed-language)

DB copy pattern:

```sh
cp /path/to/example-app/vcs/.lux/lux.db /tmp/lux-example-app-feature-path.db
```

All commands below use `--corpus /path/to/example-app/vcs --db /tmp/lux-example-app-feature-path.db`.

If the Example App path differs locally, substitute the actual repo root and DB sidecar path; the question semantics are independent of layout.

### CC-handler-01 — PHP handler behind an API route

- **id:** `CC-handler-01`
- **intent:** `route-handler`
- **target kind:** `route-surface`
- **must-have:** `target`, `directEvidence` includes `handler-recovery`, `target.filePath` ends in `.php`.
- **acceptable failures:** none.
- **disallowed failures:** `unresolved-target`, `ambiguous-target`, `missing-handler-recovery`.
- **command:**
  ```sh
  overlay operational ask "what handles POST /api/appointments?" --json
  ```

### CC-cross-language-01 — Promoted artifact-backed bridge

- **id:** `CC-cross-language-01`
- **intent:** `route-handler` (cross-language dimension is the focus)
- **target kind:** `route-surface`
- **must-have:** `crossLanguage.status` is `promoted`, `crossLanguage.trustTier` ≥ 4, at least one association has `basis` ≠ `naming-only`, `directEvidence` includes a `high-trust-cross-language-association` item, the same `frontendNodeId` does NOT also appear under `context.kind === 'nearby-consumer'`.
- **acceptable failures:** none.
- **disallowed failures:** `cross-language-below-promotion-threshold` (would contradict promotion), the same node appearing in both `directEvidence` and `context` (R5/R6 violation).
- **command:**
  ```sh
  overlay operational ask "what frontend surface participates in POST /api/appointments?" --json
  ```

### CC-cross-language-02 — Honest naming-only refusal

- **id:** `CC-cross-language-02`
- **intent:** `route-handler` (cross-language refusal is the focus)
- **target kind:** `route-surface`
- **must-have:** `crossLanguage.status` is `refused-naming-only`, `crossLanguage.rationale` is present, `crossLanguage.associations[]` is populated for auditability, `directEvidence` does NOT include any `high-trust-cross-language-association` items, `failures` includes `cross-language-below-promotion-threshold`.
- **acceptable failures:** `cross-language-below-promotion-threshold` is the expected failure here; its presence is a success.
- **disallowed failures:** `crossLanguage.status` of `promoted` (would over-claim), any `high-trust-cross-language-association` direct evidence.
- **command:** pick a route whose only frontend matches are name-similarity (resolver-tagged heuristic). Suggested candidates documented during T12.
  ```sh
  overlay operational ask "what frontend surface participates in <chosen-naming-only-route>?" --json
  ```

### CC-cross-language-03 — Honest low-trust refusal

- **id:** `CC-cross-language-03`
- **intent:** `route-handler` (cross-language refusal is the focus)
- **target kind:** `route-surface`
- **must-have:** `crossLanguage.status` is `refused-low-trust`, every association has `trustTier` < 4, `directEvidence` contains no `high-trust-cross-language-association` items.
- **acceptable failures:** `cross-language-below-promotion-threshold` is the expected failure; its presence is a success.
- **disallowed failures:** promotion of any tier-3-or-lower association.
- **command:** pick a route whose cross-language consumers are framework-inferred or heuristic-only. Suggested candidates documented during T12.
  ```sh
  overlay operational ask "what frontend surface participates in <chosen-low-trust-route>?" --json
  ```

### CC-contract-01 — Request shape with a typed PHP validator

- **id:** `CC-contract-01`
- **intent:** `route-contract`
- **target kind:** `route-surface`
- **must-have:** `contracts.request.shapeConfidence` is `exact`, `directEvidence` includes `validator-attachment`.
- **acceptable failures:** `insufficient-contract-recovery` IFF the route genuinely has no validator — in that case `contracts.request` is `coarse` or absent.
- **disallowed failures:** `exact` shape without the validator-attachment direct-evidence item.
- **command:**
  ```sh
  overlay operational ask "what request and response shape does POST /api/appointments imply?" --json
  ```

## Minimum coverage bar

A tranche-one validation run is considered complete when, at minimum, these IDs are run and reported:

- backend-centered: AC-handler-01, AC-ownership-01, AC-contract-01, AC-downstream-01
- mixed-language: CC-handler-01, AND at least one of {CC-cross-language-01, CC-cross-language-02, CC-cross-language-03}

This mirrors the validation bar in `payloads/2026-04-28-feature-path-retrieval/11-VALIDATION-AND-PROMOTION-PLAN.md`:

- at least one strong route-centered backend answer (AC-handler-01 + AC-ownership-01)
- ownership visible and non-hand-wavy (AC-ownership-01)
- direct evidence and context separated (every question)
- at least one bounded downstream step (AC-downstream-01)
- at least one mixed-language answer succeeds OR refuses honestly (CC-cross-language-* family)

A full run additionally exercises the honest-failure questions (AC-ownership-02, AC-callers-01 with no callers, AC-downstream-02) so the answer surface's silence and refusal behavior is also benchmarked, not only its strongest cases.

## Failure taxonomy

When a question returns a miss, classify it using the shared `FeaturePathFailureClass` vocabulary from `contract.ts`:

- `unresolved-target`
- `ambiguous-target`
- `missing-handler-recovery`
- `weak-ownership`
- `insufficient-contract-recovery`
- `insufficient-direct-evidence`
- `cross-language-below-promotion-threshold`

Validation reports MUST cite both the question ID (e.g. `CC-cross-language-02`) and the `failureClass` so misses are comparable across runs (R15).

## Maintenance

- New questions: append with the next available ID under the appropriate intent. Do not renumber existing IDs — they are the stable handle validation reports cite back to.
- Retired questions: mark with a `Retired:` line and the reason; do not delete, so historical validation reports remain interpretable.
- Schema bumps: when `FEATURE_PATH_ANSWER_SCHEMA_VERSION` increments, this benchmark must be reviewed for any field-level expectations that changed shape; bump the document's `Tranche` line to reflect the new schema.
