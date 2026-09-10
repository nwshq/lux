# Operational Operator Surface Validation - 2026-04-27

Branch: `feat/operational-boundary-operator-surface`

Implementation validated: one operator-facing CLI seam, `lux overlay operational ask <question...>`, with optional `--target`, `--kind`, `--json`, `--max-depth`, and `--min-trust-tier`.

## Scope Guard

- Replaced the boundary-ID-first `overlay operational show <boundaryId>` surface with a question-first `overlay operational ask` surface.
- Did not change operational detectors.
- Did not change operational persistence schema.
- Did not change persisted trust or transport semantics.
- Did not add HTTP, MCP, or expert-facing operational surfaces.
- Retrieval answers reuse existing operational retrieval helpers as the source of truth.

## Real Repo Setup

SQLite needed writable sidecar space in this sandbox, so the live DB files were copied to `/tmp` while keeping `--corpus` pointed at the real repo roots for repo-root filtering:

```sh
cp /path/to/acme-core/vcs/.lux/lux.db /tmp/lux-acme-core-operational.db
cp /path/to/acme-atlas/vcs/.lux/lux.db /tmp/lux-acme-atlas-operational.db
```

## Acme Core

Repo: `/path/to/acme-core/vcs`
DB copy: `/tmp/lux-acme-core-operational.db`

### What dispatches `App\Jobs\CreatePrivateOffer`?

Command:

```sh
node --import tsx ./src/cli/index.ts \
  --db /tmp/lux-acme-core-operational.db \
  --corpus /path/to/acme-core/vcs \
  overlay operational ask "what dispatches App\\Jobs\\CreatePrivateOffer?" --json
```

Result:

- `primaryAnswer.summary`: `PrivateOffer dispatches job:App\Jobs\CreatePrivateOffer.`
- `primaryAnswer.confidence`: `high`
- Target trust tier: `4`
- Evidence trust tiers: `[4]`
- Transport: `DISPATCHES sync`
- Provenance: `src/Nova/Actions/PrivateOffer.php`
- JSON contained top-level `primaryAnswer`, `trust`, `transport`, and `evidence`.

### What listeners handle `Acme\Core\Events\AuctionCreated`?

Command:

```sh
node --import tsx ./src/cli/index.ts \
  --db /tmp/lux-acme-core-operational.db \
  --corpus /path/to/acme-core/vcs \
  overlay operational ask "what listeners handle Acme\\Core\\Events\\AuctionCreated?"
```

Result:

- Primary answer: `AuctionCreatedListener handles event:Acme\Core\Events\AuctionCreated.`
- Confidence: `high`
- Target trust tier: `5`
- Transport: `HANDLED_BY event-bus`
- Evidence tier: `5`
- Listener provenance: `src/Module/Webhooks/Listeners/AuctionCreatedListener.php`
- Contract evidence: `opc:opb:event:Acme\Core\Events\AuctionCreated:event tier=5`

### Operational neighborhood around a known workflow boundary

Command:

```sh
node --import tsx ./src/cli/index.ts \
  --db /tmp/lux-acme-core-operational.db \
  --corpus /path/to/acme-core/vcs \
  overlay operational ask "what operational boundaries can reach this workflow?" \
  --target "App\\Jobs\\CreatePrivateOffer"
```

Result:

- Primary answer: `job:App\Jobs\CreatePrivateOffer can reach or be reached by symbol:php:App\Jobs\CreatePrivateOffer, PrivateOffer.`
- Confidence: `high`
- Target trust tier: `4`
- Transport/evidence:
  - `HANDLED_BY sync tier=4`
  - `DISPATCHES sync tier=4`
- Provenance includes `PrivateOffer -> job:App\Jobs\CreatePrivateOffer`.

## Acme Atlas

Repo: `/path/to/acme-atlas/vcs`
DB copy: `/tmp/lux-acme-atlas-operational.db`

### What schedules `releases:sync`?

Command:

```sh
node --import tsx ./src/cli/index.ts \
  --db /tmp/lux-acme-atlas-operational.db \
  --corpus /path/to/acme-atlas/vcs \
  overlay operational ask "what schedules releases:sync?" --json
```

Result:

- `primaryAnswer.summary`: `schedule:command:releases:sync@routes/console.php:24 schedules command:releases:sync.`
- `primaryAnswer.confidence`: `high`
- Target trust tier: `5`
- Evidence trust tiers: `[5]`
- Transport: `TRIGGERS sync`
- Provenance: `routes/console.php`
- Cadence contract preserved methods: `hourly`, `withoutOverlapping`, `runInBackground`, `onOneServer`
- JSON contained top-level `primaryAnswer`, `trust`, `transport`, and `evidence`.

### What command is triggered by `command:data-lake:sync --source=github@routes/console.php:59`?

Command:

```sh
node --import tsx ./src/cli/index.ts \
  --db /tmp/lux-acme-atlas-operational.db \
  --corpus /path/to/acme-atlas/vcs \
  overlay operational ask "what command is triggered by command:data-lake:sync --source=github@routes/console.php:59?"
```

Result:

- Primary answer: `schedule:command:data-lake:sync --source=github@routes/console.php:59 triggers command:data-lake:sync --source=github.`
- Confidence: `high`
- Target trust tier: `5`
- Transport: `TRIGGERS sync`
- Evidence tier: `5`

### What evidence and trust support that schedule to command path?

Command:

```sh
node --import tsx ./src/cli/index.ts \
  --db /tmp/lux-acme-atlas-operational.db \
  --corpus /path/to/acme-atlas/vcs \
  overlay operational ask "what evidence and trust support command:data-lake:sync --source=github@routes/console.php:59?"
```

Result:

- Primary answer: `command:data-lake:sync --source=github is supported by 1 persisted operational evidence item(s).`
- Confidence: `high`
- Target trust tier: `5`
- Transport: `TRIGGERS sync`
- Evidence tier: `5`
- Provenance: `routes/console.php`
- Contract evidence: `opc:opb:schedule:command:data-lake:sync --source=github@routes/console.php:59:cadence tier=5`

## Required Validation

Passed:

```sh
npm run lint
npm run format:check
npm run build
npm test
node --import tsx scripts/validate-dead-code.ts
```

Notes:

- The first `npm test` attempt was run concurrently with dead-code validation and hit two default 5 second test timeouts. Rerunning `npm test` by itself passed: 69 files, 1226 tests.
- `npm run validate:dead-code` failed in this sandbox before executing the script because the `tsx` wrapper could not create `/var/folders/.../tsx-501/*.pipe` (`listen EPERM`). The underlying script passed via `node --import tsx scripts/validate-dead-code.ts`: `Dead code check passed. 459 exports across 80 files, all referenced.`
