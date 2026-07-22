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
