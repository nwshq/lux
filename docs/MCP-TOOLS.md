# MCP Tools

Current MCP tool surface from `src/mcp/server.ts`. Every tool returns a single `content[0].text`
payload; unless noted, that text is pretty-printed JSON. A tool signals a failure/refusal by setting
`isError: true` on the response alongside a structured error payload — the outer handler also wraps any
unexpected throw as `{ isError: true, text: "Error: <message>" }`.

## Live tools

- `lux_search` — full-text search over indexed documents (optionally federated)
- `lux_log_event` — append an event to the audit trail
- `lux_get_file` — read an indexed file by path
- `lux_rebuild_index` — rescan the corpus and rebuild the index + overlay
- `lux_spec_derivation_evidence` — source-evidence packet for one operational target
- `lux_trace` — trace calls from a symbol across the app→vendor boundary (optionally federated)
- `lux_anchors` — rank structural-node anchors from a natural-language concept
- `lux_delta` — structural impact of a git change (optionally cross-repo)
- `lux_deps_impact` — blast radius of changing one file
- `lux_overlay_status` — structural-overlay trust state and freshness
- `lux_index_status` — index freshness and knowledge/event stats

## `lux_search`

Search all indexed documents; returns document title and file path, optionally filtered by entity
type. `content_only` scopes the match to file content; `snippets` adds a query-centered FTS5 snippet
per result. `with` federates across registered siblings (names, or `['all']`), returning repo-grouped,
independently-ranked result groups plus a per-sibling freshness block.

```json
{
  "query": "string",
  "type": "all|knowledge",
  "limit": 20,
  "content_only": false,
  "snippets": false,
  "with": ["sibling-name"]
}
```

Only `query` is required. `limit` is coerced by the shared search-limit rule before it can reach the
SQL `LIMIT` (a negative, zero, or non-integer limit is neutralized rather than dumping unbounded rows
or hard-aborting WASM). The response is the `buildSearchReport` envelope (query echo + ranked results).

**Refusal behavior:** an invalid FTS5 expression (or an unavailable FTS index) returns `isError: true`
with the `buildSearchRefusalReport` envelope — `refusal.reason` is `invalid-query` or `fts-unavailable`
and the offending expression is echoed back. In the federated path an invalid query fails identically
for every group including `main`, so it surfaces as the same query-level refusal rather than a
per-sibling degrade.

## `lux_log_event`

Append an event to the local audit trail for tracking system activity. This is the explicit
event-log tool surface (see [Usage observability](#usage-observability) for how it differs from the
internal usage-event records).

```json
{
  "source": "string",
  "event_type": "string",
  "summary": "string",
  "payload": {}
}
```

`source`, `event_type`, and `summary` are required; `payload` is an optional free-form object. Returns
`{ "success": true }`.

## `lux_get_file`

Read and return the raw content of a file by path. The returned text is the file contents verbatim
(not JSON).

```json
{
  "file_path": "string"
}
```

`file_path` may be absolute or relative. **Error behavior:** an unreadable/missing path returns
`isError: true` with the text `Error reading file: <reason>`.

## `lux_rebuild_index`

Rebuild the entire index by rescanning the content directory, rebuilding the structural overlay, and
persisting overlay trust metadata (plus module dependencies). Run this after content files change. No
inputs.

```json
{}
```

Returns a JSON summary: `success`, `indexed.knowledge` (entry count), an `overlay` block
(`mode`, `trustLevel`, `surfaceCount`, `fileNodeCount`, `symbolNodeCount`, `warnings`), and the
`runtime` (`corpusPath`, `dbPath`) that was rebuilt. Uses the same canonical overlay-complete rebuild
semantics as the CLI `lux index rebuild`.

## `lux_spec_derivation_evidence`

Return a `SpecDerivationEvidencePacketV1` for one route, handler, job, listener, or command target.
Lux returns **source evidence only** — it does not write or approve specifications.

```json
{
  "question": "what source evidence supports this operation?",
  "target": "POST /orders/{id}/cancel",
  "kind": "route"
}
```

All three fields are required. Supported `kind` values: `route`, `handler`, `job`, `listener`,
`command` (deferred seed kinds such as `event`, `service`, `region`, file, and symbol are not
accepted). The response is the packet JSON, the same contract as CLI
`lux overlay spec-evidence ask --json`. **Error behavior:** an unresolved or ambiguous target is
returned with `isError: true` (the packet still carries the `target.resolutionState`).

## `lux_trace`

Trace calls from a symbol across the app→vendor boundary. Follows `calls`/`references` edges multi-hop
into merged vendor nodes; synchronous framework calls reach the resolving in-vendor method, while
dynamic-dispatch calls (dispatch/event) reach the dispatch machinery and are marked as
re-entry-deferred boundaries. Returns an annotated node/edge graph.

```json
{
  "symbol": "Ns\\Class::method",
  "depth": 8,
  "max_nodes": 2000,
  "edge_types": ["calls", "references"],
  "min_confidence": "framework-inferred",
  "include_external": true,
  "with": ["sibling-name"]
}
```

Only `symbol` is required (a structural node id, a PHP FQN, or a leaf name). `min_confidence` is one of
`proven`, `artifact-backed`, `framework-inferred`, `heuristic`. `with` federates across registered
siblings, crossing repo boundaries only on portable ids (namespace-qualified FQCNs; HTTP surfaces
toward the kernel). The response is the trace graph (`nodes`, `edges`, `stats`).

**Error behavior:** an unresolvable symbol returns `isError: true` with a plain-text hint to rebuild or
pass a fully-qualified name; an ambiguous symbol returns `isError: true` with
`{ "ambiguous": true, "candidates": [{ "id", "name" }, ...] }`.

## `lux_anchors`

Rank structural-node anchors (symbols) from a natural-language concept query. Returns real structural
node ids that `lux_trace` / feature-path / deps accept verbatim — the entry points for structural ops
on concept-spread questions. For documents/content use `lux_search` instead; this tool returns symbols.

```json
{
  "query": "string",
  "limit": 10
}
```

Only `query` is required; `limit` is truncated to a positive integer (defaults to 10). The response is
the `buildAnchorReport` envelope (ranked anchor ids, a `lowConfidence` flag, and anchor-plane
`coverage`).

**Refusal behavior:** an anchor refusal (e.g. the anchor plane is not embedded/available) returns
`isError: true` with the `buildAnchorRefusalReport` envelope — `refusal.reason`/`expression` plus an
accurate anchor-viable `coverage` count (non-zero even for a non-overlay refusal over a populated
index; a genuine `0` when the overlay or prepared texts are absent).

## `lux_delta`

Analyze what a git change touches structurally: touched symbols and declared surfaces, downstream
HTTP/operational entry surfaces (with honest async-boundary annotations), module dependents,
kernel/client ownership transitions, and invalidated spec-evidence targets. Read-only with respect to
structural state. Mirrors CLI `lux delta --json`.

```json
{
  "base": "ref-or-sha",
  "committed_only": false,
  "depth": 6,
  "max_nodes": 2000,
  "min_confidence": "framework-inferred",
  "against": ["sibling-name"]
}
```

All fields are optional; `base` defaults to the index's `last_indexed_commit`. `base` is validated
(`isSafeGitRef`, argv-form git, no shell) before any git call — this verb is exposed to
prompt-injectable agents, so validation is mandatory, not optional hardening. `against` reports
cross-repo impact in registered siblings (a read-only join; an unresolvable name surfaces as
`attached: false` in `crossRepoImpact`, never silently dropped). The response is the frozen
`schemaVersion: 1` delta envelope.

**Refusal behavior:** when the delta cannot be computed (e.g. `baseline-unavailable` for an
unreachable base commit) the tool returns `{ "error": <refusal> }`.

## `lux_deps_impact`

Analyze the blast radius of a change to a file: resolve the file to its module and return every module
that depends on it, with per-dependent reference counts and sample files. Read-only. Mirrors CLI
`lux deps impact <file>` (same `computeImpact`, no forked query).

```json
{
  "file_path": "string"
}
```

`file_path` (required) may be absolute or relative to the corpus root; it is resolved to its module via
the detected module boundaries. On success the response is the `impact` object (`module`, a
`blastRadius` module/reference count summary, and `dependentModules`).

**Error behavior:** a file that cannot be resolved to a module returns `isError: true` with
`{ "error": "module-unresolved", "file": "...", "message": "..." }`.

## `lux_overlay_status`

Report the structural-overlay trust state (`overlay-complete` / `degraded-overlay` / `content-only` /
`none`), surface and node counts, the runtime corpus/db resolution, and working-tree freshness (indexed
commit vs HEAD, dirty structural files). Read-only. Mirrors CLI `lux overlay status --json`. No inputs.

```json
{}
```

Returns the `{ overlay, runtime, freshness }` status payload (`buildOverlayStatusPayload`).

## `lux_index_status`

Report index freshness: knowledge/event stats, the structural-overlay trust state, the runtime
corpus/db resolution, and working-tree freshness (indexed commit vs HEAD, dirty structural files).
Read-only. Mirrors CLI `lux index status --json`. No inputs.

```json
{}
```

Returns the `{ stats, overlay, runtime, freshness }` status payload (`buildIndexStatusPayload`).

## Usage observability

Read tools (search, trace, anchors, spec-evidence, delta, deps-impact, the status tools, and rebuild)
emit normalized local **usage-event** records via `emitUsageEvent` wherever the handler has enough
context. `lux_usage_event` is **not** a callable tool — it is the internal event-record type. These
records are written to the same repo-local SQLite event store used by CLI observability and can be
reviewed with `lux usage report` from the CLI. External event shippers are not part of this surface.

The `lux_log_event` tool is the separate, explicit audit-trail surface: it appends a caller-supplied
event (`source` / `event_type` / `summary` / `payload`) to that same store on demand.
