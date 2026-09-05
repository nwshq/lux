# Lux

Developer and agent reference.

## Runtime

- Node >= 22.12 (WASM SQLite — no native build; `commander@15` sets the floor)
- ESM project
- CLI binary: `lux`
- MCP binary: `lux-mcp`

## Path resolution

Shared resolver: `src/utils/runtime-paths.ts`

- CLI corpus: `--corpus` -> `LUX_CORPUS_PATH` -> cwd
- CLI db: `--db` -> `LUX_DB_PATH` -> `<corpus>/.lux/lux.db`
- MCP: explicit `LUX_CORPUS_PATH`/`LUX_DB_PATH`, otherwise exactly one client-provided `file://` root
- MCP root changes switch subsequent calls atomically; never fall back to an accidental process cwd
  when a root is missing, ambiguous, invalid, or unavailable

## Current CLI surface

- `lux index rebuild|sync|status`
- `lux search`
- `lux init [--json|--yes]`
- `lux doctor [--json]`
- `lux hooks install|uninstall`
- `lux migrate status|up|create`
- `lux deps graph|clusters|impact|coverage`
- `lux vendor-pack build|status`
- `lux trace <symbol> [--direction outgoing|incoming|both] [--max-fanout <n>] [--with <siblings>]`
- `lux delta [--base <ref>] [--check] [--fail-on <list>] [--json]`
- `lux overlay status|check|ownership|operational ask|boundaries ...`

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
- `lux_deps_impact`
- `lux_overlay_status`
- `lux_index_status`
- `lux_doctor`

## Diff-scoped structural delta (`lux delta`)

Change-shaped entry point: from a git diff, report touched symbols/surfaces, downstream
HTTP/operational entry surfaces, module dependents, kernel/client ownership transitions, and
invalidated spec-evidence. Read-only w.r.t. structural/overlay state; `--base` is validated
(argv-form git, no shell) before any git call. `--json` emits the frozen `schemaVersion:1` envelope,
mirrored by the `lux_delta` MCP tool.

`--check` gates in CI: exit nonzero on a gate violation or degraded overlay, else 0. Categories come
from `--fail-on <comma-list>` > `lux.yaml delta.gates` > default `overlay-not-complete`. Unknown
categories hard-error; a configured-but-unevaluable gate (e.g. `client-gap-created` without a fresh
kernel index; a Phase-4 gate with no `--baseline-db`) fails loud — never a silent pass.

```yaml
# lux.yaml
delta:
  gates: [overlay-not-complete, client-gap-created, budget-truncated]
```

CI: `actions/checkout` with `fetch-depth: 0` (the base commit must be reachable — a shallow clone
refuses `baseline-unavailable`), then `lux delta --check --fail-on ... --base "$GITHUB_BASE_REF"`.
Pre-push hook: `lux delta --check --fail-on overlay-not-complete || exit 1`.

## Overlay

Important commands:

```bash
lux index rebuild
lux overlay status
lux overlay check
```

Current operator-facing overlay states:

- `overlay-complete`
- `degraded-overlay`
- `content-only`

## Kernel/client handler ownership (#62)

Two ways to answer "which of the kernel's routes does this client override / inherit / gap?":

- **Cross-area overlay (cheap, read-only):** `lux overlay ownership --kernel`. The client names its kernel package in `lux.yaml`:

  ```yaml
  overlay:
    kernel:
      package: acme/core # the composer path-repo package that IS the kernel
  ```

  The pass resolves the kernel from `realpath(vendor/<package>)`, ATTACHes the kernel's `.lux` **read-only** (no import, no kernel nodes written into the client), and classifies the kernel's routes: `kernel-owned` / `client-override` (implements a delegated `App\` handler, or route-overrides a Core handler) / `client-gap` / `external`, plus the client's own routes as `client-local`. `--json` carries per-route detail + the matched kernel handler. **Prerequisite:** the vendored kernel worktree must have a current `.lux` index (`lux index rebuild` there) — the command fails fast otherwise.

- **First-party promotion (heavier, merged):** `lux.yaml` `firstParty.packages` re-scans the kernel into the client overlay so `trace`/`deps` also cross the boundary. Use this when you want the kernel's nodes _in_ the client index; use the cross-area overlay when you only need the ownership/coverage map. They are alternatives, not stacked.

## Key files

- `src/cli/index.ts`
- `src/cli/search.ts`
- `src/cli/hooks.ts`
- `src/cli/deps.ts`
- `src/cli/trace.ts`
- `src/cli/overlay.ts`
- `src/mcp/server.ts`
- `src/utils/runtime-paths.ts`

## Agent integration

- canonical Skill: `skills/lux-code-intel/SKILL.md`
- Open Plugins manifest: `plugin.json`
- Skill policy + MCP tools are complementary: policy determines when/how; MCP provides capability
- `scripts/verify-docs-surface.ts` rejects stale Skill MCP-tool references and missing investigation
  routes

## Read safety

- repository investigation/status commands require an existing current-schema index and do not
  create, migrate, or append usage records
- JSON reads report `telemetry: { recorded: false, reason: "read-only-index" }`
- only explicit index/migrate/rebuild/hook-event/audit-log operations write

## Rules

- trust code over stale prose
- do not document removed command groups or MCP tools as live
- corpus files are source of truth, db is derived state
