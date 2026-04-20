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
```

Current operator-facing overlay states:
- `overlay-complete`
- `degraded-overlay`
- `content-only`
