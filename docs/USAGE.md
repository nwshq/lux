# Lux CLI Reference

## Runtime path resolution

- corpus: `--corpus` -> `LUX_CORPUS_PATH` -> cwd
- db: `--db` -> `LUX_DB_PATH` -> `<resolved corpus>/.lux/lux.db`

## Index

```bash
lux index rebuild
lux index rebuild --content-only
lux index sync
lux index sync --force
lux index status
```

Notes:
- `lux index rebuild` is the canonical rebuild path
- `--content-only` skips overlay materialization
- `sync` may escalate to a full rebuild when structural changes are detected

## Search

```bash
lux search "query"
lux search '"exact phrase"'
lux search "prov*"
lux search "provider AND photos"
lux search "query" --type knowledge
lux search "query" --content
lux search "query" --legacy
```

Implemented search type values:
- `all`
- `knowledge`

## Hooks

Hooks now follow the shared runtime path resolver.

- corpus: `--corpus` -> `LUX_CORPUS_PATH` -> cwd
- explicit `--corpus` still wins over env and cwd

```bash
lux hooks install
lux hooks install --corpus /path/to/corpus
lux hooks uninstall
lux hooks uninstall --corpus /path/to/corpus
```

## Migrations

```bash
lux migrate status
lux migrate up
lux migrate create <name>
```

## Lint

```bash
lux lint
lux lint <path>
lux lint --severity warning
lux lint --rule <name>
lux lint --format json
lux lint --quiet
```

## Expert panel

```bash
lux expert list
lux expert list --status active
lux expert show <slug>
lux expert add <slug> --mount <path>
lux expert remove <slug> --yes
lux expert discover --dry-run
lux expert discover --accept-all
lux expert discover --diff
```

## Ask

```bash
lux ask "question"
lux ask "question" --expert <slug>
lux ask "question" --verbose
lux ask "question" --json
lux ask "question" --stream
lux ask "question" --no-stream
```

## Module dependency analysis

```bash
lux deps graph
lux deps graph --module <name>
lux deps graph --json
lux deps clusters
lux deps impact <file-path>
lux deps coverage
```

## Overlay

```bash
lux overlay status
lux overlay status --json
lux overlay check
lux overlay boundaries show
lux overlay boundaries show --focus Listing --include-paths
lux overlay boundaries explore
lux overlay boundaries list-regions
lux overlay boundaries list-families
lux overlay boundaries neighborhood Listing
```

Current operator-facing overlay states:
- `overlay-complete`
- `degraded-overlay`
- `content-only`

### Boundary exploration

Boundary exploration exposes the module-boundary map through three different lenses:

- `regions`: the places in the map, for example `Listing`, `Billing`, or `Checkout`
- `families`: the structural reason a relationship exists, for example `surface-bridge`, `service-container`, or `async-workflow`
- `neighborhood`: the local view around one region, meaning all relationships that touch that region

Use them for different jobs:

- `lux overlay boundaries list-regions` to discover the main domains Lux sees
- `lux overlay boundaries list-families` to understand which evidence patterns are shaping the graph
- `lux overlay boundaries neighborhood <region>` to inspect one domain before drilling into exact relationships
- `lux overlay boundaries show` to inspect the actual aggregated region-to-region relationships

Practical framing:

- region answers: what parts of the system exist as meaningful domains?
- family answers: what structural patterns are creating the connections?
- neighborhood answers: what is this specific domain connected to right now?
