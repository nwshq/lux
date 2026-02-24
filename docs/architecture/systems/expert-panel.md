# Expert Panel System

The expert panel is Lux's domain-specialist AI routing system. It maintains a registry of experts — each scoped to a CORPUS subdirectory — and routes user questions to the most relevant expert through a three-stage pipeline: FTS5 scoring, LLM selection, and subprocess query.

## Architecture

```
User Question
    │
    ├─── CLI: lux ask <question>
    │    └── --expert <slug>  (bypass routing)
    │    └── --stream         (real-time output)
    │    └── --verbose        (routing details)
    │
    └─── MCP: lux_ask tool
         └── expert_hint      (bypass routing)
         └── context           (additional context)
    │
    ▼
┌─────────────────────────────────────────────────┐
│              Expert Router (routeQuery)          │
│                                                  │
│  Stage 1: FTS5 Scoring                           │
│    └── Score experts by document hit count        │
│                                                  │
│  Stage 2: LLM Selection (Haiku)                  │
│    └── Semantic expert selection                  │
│    └── Fallback: FTS5 → first active expert      │
│                                                  │
│  Stage 3: Expert Query (Subprocess)              │
│    └── Augmented query with FTS5 context          │
│    └── claude --print in expert's mount_path     │
└────────────────────────┬────────────────────────┘
                         │
                         ▼
                   QueryResult
                   (response, sessionId, expertSlug)
```

### Module Layout

| File | Responsibility |
|------|---------------|
| `src/experts/router.ts` | Three-stage routing pipeline, FTS5 scoring, LLM selection, query augmentation |
| `src/experts/session-manager.ts` | `ExpertSessionManager` interface, `ExpertSessionManagerImpl` (execFile-based) |
| `src/experts/subprocess-manager.ts` | `SubprocessSessionManager` (spawn-based, process tracking, streaming) |
| `src/cli/ask.ts` | CLI `lux ask` command — routes to panel or specific expert |
| `src/cli/expert.ts` | CLI `lux expert` commands — add, remove, list, show |
| `src/utils/subprocess-env.ts` | `buildCleanEnv()` — allowlist-based environment filter |
| `src/mcp/server.ts` | MCP `lux_ask` tool handler |

## Expert Registry

### Database Schema

Experts are stored in the `experts` table (migration 004):

```sql
CREATE TABLE experts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,          -- URL-safe identifier
    name TEXT NOT NULL,                  -- Display name
    mount_path TEXT NOT NULL,            -- CORPUS subdirectory this expert owns
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    claude_md_path TEXT,                 -- System prompt file path
    memory_path TEXT,                    -- Persistent memory file path
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

| Field | Purpose |
|-------|---------|
| `slug` | Unique identifier used in CLI commands, routing, and API calls |
| `mount_path` | Directory this expert owns — FTS5 hits under this path map to this expert |
| `model` | Claude model used for expert queries (e.g., `claude-sonnet-4-20250514`) |
| `claude_md_path` | Path to a markdown file injected as `--system-prompt` during queries |
| `memory_path` | Path to a `memory.md` file (informational — not currently used in queries) |
| `status` | `active` or `inactive` — only active experts participate in routing |

### Registration

Experts are registered via `lux expert add`:

```bash
lux expert add example-app \
  --mount knowledge/10_clients/example-app \
  --name "example-app Expert" \
  --model claude-sonnet-4-20250514
```

The registration process:
1. Resolves `--mount` relative to the CORPUS root (or accepts absolute paths)
2. Validates the mount path exists on disk and is inside the content root
3. Auto-detects `claude.md` or `CLAUDE.md` at the mount path for `claude_md_path`
4. Auto-detects `memory.md` at the mount path for `memory_path`
5. Inserts into the `experts` table

### Management Commands

| Command | Description |
|---------|-------------|
| `lux expert add <slug>` | Register a new expert with `--mount`, `--name`, `--model` |
| `lux expert remove <slug>` | Unregister an expert (requires `--yes`), cleans up sessions |
| `lux expert list` | List all experts with status, mount path, model |
| `lux expert show <slug>` | Show detailed expert information |

All commands support `--json` for machine-readable output.

## Three-Stage Routing Algorithm

### Stage 1: FTS5 Scoring

The router searches all FTS5 indexes and maps document hits to experts by `mount_path` prefix matching. This serves two purposes: ranking expert candidates and collecting documents for context enrichment in Stage 3.

```
User query: "How should we handle patient intake forms?"
    │
    ▼
sanitizeFtsQuery()
    │  Split on whitespace, strip special chars, wrap in quotes
    │  Result: "patient" OR "intake" OR "forms"
    ▼
collectFtsHits()
    │  Search: knowledge_entries_fts, clients_fts, projects_fts, communications_fts
    │  Collect: file_path, rank, content, title, metadata per hit
    ▼
scoreExperts()
    │  For each hit, find the expert whose mount_path is a prefix of hit.file_path
    │  Accumulate: hits count + raw FTS5 rank per expert
    │  Sort: most hits first, then by cumulative rank (lower = more relevant)
    ▼
ScoredExpert[]
    e.g., [{ expert: example-app, hits: 7, score: -3.2 },
           { expert: acme, hits: 2, score: -0.8 }]
```

The `isUnderMountPath()` function performs normalized prefix matching: both the file path and mount path have a trailing `/` appended before comparison, preventing false matches (e.g., `/clients/foo` should not match mount path `/clients/foobar`).

Each FTS5 hit maps to at most one expert (first match wins). Hits that don't fall under any expert's mount path are ignored for scoring but still collected for potential context enrichment.

### Stage 2: LLM Selection (Haiku)

A lightweight LLM (Claude Haiku) selects the best expert from the roster. The LLM receives a structured prompt containing expert descriptions extracted from their `claude_md_path` files.

**Roster construction** (`buildExpertRoster()`):
- Reads each expert's `claude_md_path` file
- Strips YAML frontmatter and markdown headers
- Takes the first ~200 characters as a brief description
- Formats as: `` - `slug` — Name: description ``

**Prompt format:**
```
You are a query router. Given a user's question and a list of domain experts,
respond with ONLY the slug of the single best expert to answer the question.
Do not explain your choice. Respond with just the slug.

## Available Experts

- `example-app` — example-app Expert: This expert handles chiropractic practice...
- `acme` — acme Expert: Manages eBay auction platforms and...

## Question

How should we handle patient intake forms?
```

**Execution:**
- Spawns `claude --print --model claude-haiku-4-5-20251001` as a stateless subprocess
- 30-second timeout (`ROUTING_TIMEOUT_MS`)
- Parses response: strips backticks and whitespace, validates against known slugs
- Returns `LlmRoutingResult` with telemetry (slug, prompt, raw response, model, duration, error)

**Fallback chain:**

```
LLM returns valid slug? ──yes──► Use LLM-selected expert (routingMethod: 'llm')
    │ no
    ▼
FTS5 has qualified matches (hits >= minHits)? ──yes──► Use FTS5 top match (routingMethod: 'fts5')
    │ no
    ▼
Use first active expert as last resort (routingMethod: 'fts5')
```

LLM routing can be disabled entirely via `useLlmRouting: false`, which skips directly to FTS5 fallback.

### Stage 3: Expert Query (Subprocess)

The chosen expert receives an augmented query containing FTS5-retrieved document content, implementing a RAG (Retrieval-Augmented Generation) pattern.

**Query augmentation** (`buildAugmentedQuery()`):

FTS5 hits under the chosen expert's mount path are packed into a "Reference Documents" section with a configurable byte budget (default ~150KB):

```
Answer the following question using the reference documents provided below.

## Reference Documents

### Patient Intake Process
> **LSP Relationships**
> **extends**: IntakeForm → BaseForm
> **dependencies**: FormValidator.php
[document content...]
---

### Scheduling Configuration
[document content...]
---

## Question

How should we handle patient intake forms?
```

Each reference document includes:
- Title from the FTS5 hit
- LSP relationship summary if available (extends, implements, dependencies, referenced_by, symbols)
- Document content truncated to fit within the remaining byte budget

Documents are added in FTS5 relevance order until the budget is exhausted.

**Subprocess execution:**

The `SubprocessSessionManager` spawns the expert query:

```
claude --print \
  --model <expert.model> \
  --system-prompt <claude_md_path contents> \
  --resume <session_ref>           (if existing session)
  "<augmented question>"
```

- Working directory: `expert.mount_path`
- Environment: filtered via `buildCleanEnv()`
- stdin: closed (`'ignore'`)
- stdout/stderr: piped
- Timeout: 5 minutes (300,000ms)
- Max output: 10MB

### Multi-Expert Mode

When `maxExperts > 1`, the LLM selection stage is bypassed. Instead, the top N FTS5-qualified experts each receive their own augmented query with context specific to their mount path. Responses are collected via `Promise.allSettled` — individual expert failures do not block other responses.

### Router Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `maxExperts` | `1` | Number of experts to query per route |
| `minHits` | `1` | Minimum FTS5 hit count for expert qualification |
| `maxContextBytes` | `153,600` (~150KB) | Byte budget for augmented query reference documents |
| `useLlmRouting` | `true` | Enable/disable LLM-based expert selection |
| `routingModel` | `claude-haiku-4-5-20251001` | Model for the routing LLM call |
| `onChunk` | — | Streaming callback for real-time expert response output |

## Session Management

### Session States

Expert sessions track the lifecycle of interactions with each expert:

```sql
CREATE TABLE expert_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expert_id INTEGER NOT NULL,
    session_ref TEXT NOT NULL,       -- UUID for conversation resumption
    spawned_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_active_at INTEGER NOT NULL DEFAULT (unixepoch()),
    status TEXT NOT NULL DEFAULT 'warm',
    FOREIGN KEY (expert_id) REFERENCES experts(id) ON DELETE CASCADE
);
```

| Status | Meaning |
|--------|---------|
| `warm` | Session exists, ready for queries. Default state after creation and after successful query. |
| `active` | Query is currently executing. Prevents concurrent queries to the same expert. |
| `idle` | Query failed. Session is retained but marked as degraded. |

**State transitions:**

```
[create] ──► warm ──► active ──► warm    (successful query)
                         │
                         └──► idle       (failed query)
                                │
                                └──► [delete]  (terminate)
```

### Session Managers

Two implementations of the `ExpertSessionManager` interface exist:

**`ExpertSessionManagerImpl`** (session-manager.ts):
- Uses Node.js `execFile` (fire-and-forget)
- Simpler implementation, no process tracking
- Session refs are timestamp-based: `session-{slug}-{Date.now()}`

**`SubprocessSessionManager`** (subprocess-manager.ts):
- Uses Node.js `spawn` with piped I/O
- Tracks active child processes in a `Map<number, ActiveProcess>`
- Prevents concurrent queries to the same expert via `hasActiveQuery()`
- Supports response streaming via `onChunk` callback
- Session refs are UUIDs for conversation resumption
- Provides `terminateAll()` for graceful shutdown
- Supports `--resume <session_ref>` for conversation continuity

The `SubprocessSessionManager` is used in production (both CLI and MCP server). The `ExpertSessionManagerImpl` serves as a simpler alternative.

### Session Lifecycle

1. **Get or create session:** `getSession(expertSlug)` checks for an existing `warm` session for the expert. If found, it touches `last_active_at` and returns it. Otherwise, creates a new session.

2. **Query execution:** The session status transitions to `active`. The `SubprocessSessionManager` checks `hasActiveQuery()` to prevent concurrent queries to the same expert. The subprocess is spawned and tracked.

3. **Success:** Session returns to `warm`, `last_active_at` is updated, and an `expert_ask` event is logged.

4. **Failure:** Session transitions to `idle`, and an `expert_ask_error` event is logged with the error details.

5. **Termination:** `terminate()` kills any active subprocess (SIGTERM, then SIGKILL after 5s), sets status to `idle`, and deletes the session from the database.

## Subprocess Isolation

All Claude CLI subprocesses — routing calls and expert queries — run in isolated environments constructed by `buildCleanEnv()` in `src/utils/subprocess-env.ts`.

### Environment Allowlist

The function filters `process.env` through an explicit allowlist:

**Exact matches:**

| Variable | Why Allowed |
|----------|------------|
| `PATH` | Binary resolution — `claude`, `node`, `git` |
| `HOME` | Claude CLI config and cache at `~/.claude/` |
| `SHELL` | Default shell for subprocess tooling |
| `USER`, `LOGNAME` | User identity for file permissions |
| `TERM` | Terminal capability detection |
| `TMPDIR` | Temporary file location |

**Prefix matches:**

| Prefix | Why Allowed |
|--------|------------|
| `LANG`, `LC_*` | Locale settings — prevents encoding issues |
| `XDG_*` | Freedesktop directory standards |
| `ANTHROPIC_*` | API keys and Anthropic configuration |

### What Gets Excluded

Variables not on the allowlist are silently dropped. Key exclusions:

| Variable | Why Excluded |
|----------|-------------|
| `CLAUDECODE` | Triggers nested-session guard in `claude` CLI |
| `NODE_OPTIONS` | Parent's Node.js flags should not affect subprocesses |
| `npm_*` | npm lifecycle metadata leaks parent context |
| `DEBUG` | Debug logging from parent pollutes subprocess output |
| `AWS_*`, `GCP_*` | Cloud credentials unnecessary for Claude CLI |

This allowlist approach means new environment variables from future tooling are excluded by default — secure without code changes.

### Subprocess Configuration

| Parameter | Router (Haiku) | Expert Query |
|-----------|---------------|-------------|
| Binary | `claude` | `claude` |
| Mode | `--print` (stateless) | `--print` (stateless) |
| Model | `claude-haiku-4-5-20251001` | Expert's configured model |
| cwd | inherited | `expert.mount_path` |
| stdin | closed (`'ignore'`) | closed (`'ignore'`) |
| stdout/stderr | piped | piped |
| Timeout | 30s | 300s (5 min) |
| Max output | — | 10MB |
| System prompt | — | Expert's `claude_md_path` content |
| Session resume | — | `--resume <session_ref>` |
| Environment | `buildCleanEnv()` | `buildCleanEnv()` |

## Error Handling

### Routing Errors

| Error | Handling |
|-------|---------|
| No active experts | Return empty `RouteResult` with no matches or responses |
| FTS5 query fails | Return empty hits; routing falls through to first active expert |
| LLM routing timeout (30s) | Log telemetry event, fall back to FTS5 scoring |
| LLM returns invalid slug | Log telemetry event, fall back to FTS5 scoring |
| LLM subprocess error | Log telemetry event, fall back to FTS5 scoring |

All LLM routing calls — successes and failures — are logged to the `events` table with event type `expert_route_llm`, capturing the prompt, raw response, model, duration, and error.

### Query Errors

| Error | Handling |
|-------|---------|
| Expert not found | Throw `Error("Expert not found: {slug}")` |
| Expert not active | Throw `Error("Expert is not active: {slug}")` |
| Mount path missing | Throw `Error("Expert mount path does not exist: {path}")` |
| Concurrent query | Throw `Error("Expert already has an active query")` |
| Subprocess timeout (5 min) | Kill process (SIGTERM → SIGKILL), set session to `idle`, throw |
| Output exceeds 10MB | Throw `Error("Output exceeded maximum size")` |
| Non-zero exit code | Extract stderr message, set session to `idle`, throw |

All query errors are logged to the `events` table with event type `expert_ask_error`, including the expert slug, session ID, question, and error message.

### Process Cleanup

The `SubprocessSessionManager.killProcess()` method implements graceful shutdown:

1. Send `SIGTERM` to the child process
2. Wait 5 seconds
3. If the process hasn't exited, escalate to `SIGKILL`
4. Remove the process from the active tracking map

`terminateAll()` calls `killProcess()` for every tracked subprocess, used during application shutdown.

### Telemetry Events

| Event Type | Source | When |
|------------|--------|------|
| `expert_route_llm` | `expert-router` | Every LLM routing call (success or failure) |
| `expert_route` | `expert-router` | Final routing decision — chosen expert, FTS5 top-5, LLM agreement |
| `expert_ask` | `subprocess-session-manager` | Successful expert query |
| `expert_ask_error` | `subprocess-session-manager` | Failed expert query |

The `expert_route` event captures both the LLM and FTS5 decisions, enabling after-the-fact comparison:

```json
{
  "routing_method": "llm",
  "chosen_slug": "example-app",
  "fts5_top": [
    { "slug": "example-app", "hits": 7, "score": -3.2 },
    { "slug": "acme", "hits": 2, "score": -0.8 }
  ],
  "fts5_would_pick": "example-app",
  "llm_agreed_with_fts5": true,
  "llm_slug": "example-app",
  "llm_duration_ms": 1423
}
```

## Performance

### Latency Budget

A typical routed query involves two sequential LLM calls:

| Stage | Typical Latency |
|-------|----------------|
| FTS5 scoring | < 50ms |
| LLM routing (Haiku) | 1–5s |
| Query augmentation | < 10ms |
| Expert query (Sonnet) | 5–60s |
| **Total** | **6–65s** |

Disabling LLM routing (`useLlmRouting: false`) saves 1–5 seconds but loses semantic selection.

### Resource Usage

- **Memory:** Each subprocess is a separate `claude` process. The `SubprocessSessionManager` tracks active processes in memory but does not cache model state between queries.
- **Disk:** Session state is persisted in SQLite (lightweight — one row per session). Expert registration is a single row in the `experts` table.
- **Concurrency:** Only one query per expert at a time (enforced by `hasActiveQuery()`). Multiple experts can be queried in parallel when `maxExperts > 1`.

### Limitations

- **No persistent model context.** Each query spawns a new subprocess. Model weights are not cached between invocations. The `--resume` flag provides conversation history but not model warm-up.
- **Two LLM calls per query.** The routing hop adds latency and cost. For single-expert deployments, set `useLlmRouting: false`.
- **FTS5-based context retrieval is keyword-only.** Documents using different terminology for the same concept will not be retrieved as context.
- **150KB context budget is a heuristic.** May be too large for simple questions or too small for multi-document analysis.
- **No expert load balancing.** If multiple experts qualify, selection is by FTS5 rank or LLM choice, not by current load or availability.

## Key Source Files

| File | Role |
|------|------|
| `src/experts/router.ts` | Three-stage routing: `routeQuery()`, `scoreExperts()`, `buildAugmentedQuery()`, `sanitizeFtsQuery()`, `selectExpertWithLlm()` |
| `src/experts/session-manager.ts` | `ExpertSessionManager` interface, `ExpertSessionManagerImpl` |
| `src/experts/subprocess-manager.ts` | `SubprocessSessionManager` — process tracking, streaming, lifecycle |
| `src/utils/subprocess-env.ts` | `buildCleanEnv()` — environment allowlist filter |
| `src/cli/ask.ts` | CLI `lux ask` command |
| `src/cli/expert.ts` | CLI `lux expert` management commands, `validateMountPath()` |
| `src/mcp/server.ts` | MCP `lux_ask` tool handler |
| `src/db/migrations/004_add_expert_panel.sql` | Database schema for experts and sessions |

## Related Documentation

- [ADR-003: Expert Routing](../adr/003-expert-routing.md) — decision rationale for three-stage routing
- [ADR-004: Subprocess Isolation](../adr/004-subprocess-isolation.md) — decision rationale for `buildCleanEnv()` allowlist
- [FTS5 Search System](fts5-search.md) — how FTS5 indexes power Stage 1 scoring
- [Architecture Overview](../OVERVIEW.md) — system-level architecture and expert routing pipeline diagram
