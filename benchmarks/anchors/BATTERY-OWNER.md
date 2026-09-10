# Concept→Node Anchor Battery — Owner & Calibration Record

**Owner:** Example Maintainer (`maintainer@example.com`) — accountable for the gold node ids drifting with the
acme-core fixture, and for re-validating them after a structural refactor.

**Battery file:** `benchmarks/retrieval/fixtures/acme-core-anchors.json`
**Metric:** concept→structural-node hit@k / MRR (Decision 10), scored against **node ids** (the anchor
surface's contract — deterministic `astSymbolIdentity`), not file paths.

## Adequacy (Decision 10 — sized so a lift is detectable)

| Requirement                                                     | Minimum  | This battery                        |
| --------------------------------------------------------------- | -------- | ----------------------------------- |
| Total concept→node cases                                        | N ≥ 20   | **25**                              |
| Genuine vocabulary-mismatch cases (query/target share no token) | ≥ 6      | **7** (`knownMiss`)                 |
| Exact-identifier protection cases                               | ≥ 1      | **3** (`minMrr ≥ 0.5`)              |
| Named owner per case set                                        | required | **Example Maintainer** (every case) |

Case classes (spec 12 §Part H):

1. **Anchored (lexical-closable)** — name/path/identifier-derivable gold; the lexical tier is expected
   to close these in Phase 1 (`anchorHit` + `minMrr`). Includes the CA q1/q2 gold as node cases
   (`anchors-q2-payment-gateway`, `anchors-q1-settlement`).
2. **Vocabulary-mismatch `knownMiss` (7)** — query shares no token with the target's name/path/
   signature (e.g. "seller payouts split by marketplace" → `SettlementService::splitByPlatform`).
   Marked `knownMiss:true`: **measured + tallied but excluded from CI pass/fail** in Phase 1. These are
   the exact cases the Phase-3 semantic half must flip to `closable` — the shipped-side lift evidence
   (SC-Lift). They read red-but-excluded until then.
3. **Exact-identifier protection (3)** — `StripeService` / `SettlementService` / `EmailEventRegistrants`
   must resolve their own node id best-first (`minMrr ≥ 0.5`). A weight/semantic change that blurs
   exact-identifier precision reddens here (regression guard for Decision 3's lexical half).
4. **Refusal (1)** — an unterminated phrase → `anchorRefusalReason:'invalid-query'`, exit 1.
5. **Confidence-floor (1)** — a thin token-collision query (`"handles"`, present only in doc-comments)
   → `lowConfidence:true`, exit 0.

> **Gold node ids are owner-validated against the live acme-core index.** The FQNs here follow the
> exploration's domain design (the CA battery + payload spec 12 seeds). The owner re-confirms each
> `expectNodeIdsTopK` against `lux index rebuild` on `acme-core/vcs` and corrects any drift. The
> harness counts the seeded cases at run time (`knownMiss.{total,open,closable}` in `summary.json`), so
> an under-powered or drifted battery is a visible, recorded fact — never a silent weak gate.

## Confidence-floor calibration (T1.8 — the lexical bm25 floor)

The Phase-1 tier is lexical-only. A single-list RRF top hit always scores ≈ `1/(RRF_K+1)` ≈ 0.0164
regardless of match quality, so a **fused-score** floor cannot separate a confident anchor from a thin
token collision. `lowConfidence` in lexical-only mode therefore derives from the top hit's **raw
weighted-bm25 signal** (`ANCHOR_MIN_LEXICAL_BM25`, `src/scanner/anchors/fusion.ts`). In hybrid mode
(Phase 3, semantic present) the fused score becomes meaningful and `ANCHOR_MIN_FUSED_SCORE` gates.

**Method.** Build a realistic anchor corpus (the payment-domain fixture, mirrored in the vitest
`anchor-search.test.ts` seed), then measure the top weighted-bm25 (`bm25(fts, 0, 5, 4, 2, 2, 1)`, the
shipped column-weighted ranking) for confident name/identifier queries vs. thin context-only queries.
Pick the floor as the value that separates the two bands.

**Measured (calibration corpus, 15 nodes):**

| Query                   | Class                               | Top weighted-bm25 |
| ----------------------- | ----------------------------------- | ----------------- |
| `payment gateway`       | confident (name split)              | **-7.58**         |
| `stripe service`        | confident (name/identifier)         | **-4.59**         |
| `braintree`             | confident (identifier)              | **-4.39**         |
| `EmailEventRegistrants` | confident (exact id)                | **-4.15**         |
| `StripeService`         | confident (exact id)                | **-4.09**         |
| `user`                  | confident (exact name)              | **-3.47**         |
| `handles`               | thin (context-only collision)       | **-1.29**         |
| `class`                 | thin (matches ~all contexts, IDF≈0) | **0**             |

Confident hits land at **≤ -3.4**; thin collisions at **≥ -1.3**. The pinned floor sits in the gap:

```
ANCHOR_MIN_LEXICAL_BM25 = -2.0   // lowConfidence:true iff top bm25 > -2.0
```

**Where it holds and where it over-flags.** The (name 5, identifiers 4, qualified 2, path 2,
context 1) column weights dominate the separation — a name hit is ≥5× a context hit. But bm25 is
IDF-driven, so the separation is **not uniform across corpus sizes**. On an overlay **larger** than
this calibration set a rare identifier's higher IDF pushes confident hits **further** negative — the
gap widens and -2.0 stays conservative. On an overlay **smaller** than it the IDF shrinks and a strong
hit's top bm25 can rise above -2.0, so a **tiny overlay may over-flag a confident anchor** as low
confidence (e.g. "stripe service" measures ≈ -1.94 on a 3-node overlay vs -4.59 on the 15-node one).
That is benign: `lowConfidence` is a soft warning and the results are still returned. Net: the floor is
conservative for overlays **≥ the calibration size** and merely over-cautious for tiny ones — so a
production-scale overlay never under-flags a thin match, which is the property that matters. The -2.0
value's live-index (acme-core) validation is **deferred to the owner-run T1.8 battery in Phase 2**.
Guarded meanwhile by the deterministic vitest cases in
`src/scanner/anchors/__tests__/anchor-search.test.ts` ("a confident name hit is NOT lowConfidence" /
"a thin context-only token collision IS lowConfidence") and the pinned-value assertion in
`fusion.test.ts`.

`ANCHOR_MIN_FUSED_SCORE = 0.025` (hybrid-mode floor) is derived from the RRF math (between the
both-modalities-rank-1 score 2/61 ≈ 0.0328 and the single-modality-rank-1 score 1/61 ≈ 0.0164) and is
re-confirmed against the Phase-2/3 hybrid battery if and when the semantic half ships.
