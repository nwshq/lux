# Lux

Internal reference for the current Lux CLI and MCP server.

## Runtime path resolution

Shared resolver: `src/utils/runtime-paths.ts`

- corpus: `--corpus` -> `LUX_CORPUS_PATH` -> current working directory
- db: `--db` -> `LUX_DB_PATH` -> `<resolved corpus>/.lux/lux.db`

## Current CLI surface

- `lux index rebuild|sync|status`
- `lux search`
- `lux hooks install|uninstall`
- `lux migrate status|up|create`
- `lux deps graph|clusters|impact|coverage`
- `lux trace <symbol>`
- `lux anchors <query> [--limit <n>] [--json]`
- `lux delta [--base <ref>] [--check] [--fail-on <list>] [--json]`
- `lux vendor-pack build|status`
- `lux usage report`
- `lux overlay status|check|ownership|boundaries|operational ask|feature-path ask|spec-evidence ask`

## Current MCP surface

From `src/mcp/server.ts`:
- `lux_search`
- `lux_log_event`
- `lux_get_file`
- `lux_rebuild_index`
- `lux_trace`
- `lux_delta`
- `lux_spec_derivation_evidence`
- `lux_anchors`

## `lux delta` — diff-scoped structural delta

Answers "what does this change touch structurally" from a git diff: touched symbols/surfaces,
downstream HTTP/operational entry surfaces, module dependents, kernel/client ownership transitions,
and invalidated spec-evidence targets. Read-only with respect to structural/overlay state; the base
ref is validated (argv-form git, no shell) before any git call. `--json` emits the stable
`schemaVersion:1` envelope (exposed identically as the `lux_delta` MCP tool).

`--check` turns it into a CI gate: exit nonzero on a gate violation or degraded overlay, exit 0
otherwise. Gate categories come from `--fail-on <comma-list>`, else `lux.yaml delta.gates`, else the
default `overlay-not-complete`. Unknown categories hard-error; a configured-but-unevaluable gate
(e.g. `client-gap-created` with no fresh kernel) fails loud rather than silently passing.

```yaml
# lux.yaml
delta:
  gates:
    - overlay-not-complete    # overlay trust below overlay-complete
    - client-gap-created      # diff removes a client handler a kernel route expects
    - budget-truncated        # reverse walk exhausted its budget — blast radius unknown
    # Phase 4, require --baseline-db:
    - boundary-edge-added
    - surface-removed
```

### CI gate (GitHub Actions)

`--base` defaults to the index's `last_indexed_commit`; the base commit must be reachable in the
checkout, so fetch full history (`fetch-depth: 0`) — a shallow clone yields a `baseline-unavailable`
refusal.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0            # delta needs the base commit reachable (no shallow clone)
- run: npm ci && npx lux index rebuild
- run: npx lux delta --check --fail-on overlay-not-complete,client-gap-created --base "$GITHUB_BASE_REF"
```

### Pre-push hook

```sh
# .git/hooks/pre-push  (chmod +x)
#!/bin/sh
lux delta --check --fail-on overlay-not-complete || {
  echo "lux delta gate failed — see the report above." >&2
  exit 1
}
```

## Anchor embeddings (`lux anchors`)

`lux anchors <query>` mints ranked structural-node anchors (real symbol ids) from a natural-language
concept. The ranker's lexical half always runs; a semantic half fuses in once the anchor plane is
embedded. Embedding is **opt-in** and, by default, **native-free and fully on-machine**:

- Default install: no embeddings. `lux index rebuild --embeddings` fetches the pinned local bge model
  (~34 MB, one-time) and embeds the plane; nothing leaves the machine.
- Routine `lux index rebuild`/`sync` stay cached-only — they embed iff the weights are already local
  and never trigger a network fetch.

### `lux.yaml` config reference

```yaml
# lux.yaml — the entire embedding config surface (optional; absent ⇒ native-free local default)
embedding:
  provider: openai                 # optional: openai (the sole shipped provider)
  model: text-embedding-3-small    # optional: provider default applies
  # NO token key. The API path is selected by the LUX_EMBEDDING_TOKEN env var; an inline
  # `embedding.token` here is REJECTED at load (fail-closed) and must be rotated — a key written to
  # a committed file must be considered leaked.
```

### `LUX_EMBEDDING_TOKEN` — the API embedder opt-in (off-machine export)

Setting `LUX_EMBEDDING_TOKEN` switches the active embedder to the configured API provider (OpenAI),
using `provider`/`model` from `lux.yaml` above. The key is read from the environment **only** — never
from `lux.yaml`.

> **`LUX_EMBEDDING_TOKEN` sends your codebase's identifier surface off-machine.** With the env token
> set, `lux index` sends the prepared text for every in-scope node — symbols' names, identifiers,
> qualified names, file paths, signature lines, and leading doc-comments (never full file bodies) — to
> the configured third-party embedding provider (OpenAI). Egress is not limited to indexing: with the
> token set, `lux anchors <query>` also sends the natural-language **query** text to the same provider
> at query time (it must be embedded for the semantic half). This is a deliberate, operator-initiated
> export gated on the env var; the default install embeds locally with the native-free bge model and
> sends **nothing** off-machine. Turning on the key ships the codebase's identifier surface and
> documentation comments to an external service — set it only where that is acceptable.

## Working rules

- corpus files are source of truth
- db is derived state
- `lux index rebuild` is the canonical rebuild path
- `lux overlay check` is the hard gate for overlay-complete validation
- trust code over stale prose

## Pointers

- `CLAUDE.md`
- `docs/README.md`
- `docs/USAGE.md`
- `docs/MCP-CONFIGURATION.md`
- `docs/MCP-TOOLS.md`
