# ADR-004: Subprocess Environment Isolation

**Status:** accepted
**Date:** 2026-02-23

## Context

Lux spawns Claude CLI subprocesses in several contexts:

- **Expert routing** (`src/experts/router.ts`) — `claude --print` calls for LLM-based expert selection via Haiku.
- **Expert queries** (`src/experts/session-manager.ts`, `src/experts/subprocess-manager.ts`) — `claude --print` calls to query selected experts.
- **Corpus initialization** (`src/init/index.ts`) — `claude --print` calls for AI-assisted `lux.yaml` generation.

These subprocesses inherit the parent process's environment by default. This creates two problems:

1. **Nested-session guards.** When Lux runs inside Claude Code (e.g., as an MCP server or via CLI within an agent session), environment variables like `CLAUDECODE` signal that the process is already inside a Claude session. Spawned `claude --print` subprocesses inherit this variable and refuse to start, believing they are being recursively invoked.

2. **Environment leakage.** The parent process may carry variables from npm (`npm_config_*`, `npm_lifecycle_event`), Node.js (`NODE_OPTIONS`), debugging tools (`DEBUG`), or cloud credentials (`AWS_SECRET_ACCESS_KEY`) that are irrelevant or actively harmful to expert subprocesses. Passing these through creates implicit coupling between the calling context and expert behavior.

A naive solution — passing an empty `env: {}` — breaks subprocesses because they need basic system variables (`PATH`, `HOME`, `SHELL`) and API credentials (`ANTHROPIC_API_KEY`) to function.

## Decision

We implement an **allowlist-based environment filter** in `src/utils/subprocess-env.ts` via the `buildCleanEnv()` function. Every subprocess spawned by Lux uses this function to construct its environment.

### Implementation

```typescript
const EXACT_ALLOWLIST = new Set([
  'PATH',     // Required for binary resolution (claude, node, etc.)
  'HOME',     // Home directory — used by claude CLI for config/cache
  'SHELL',    // Default shell — used by some subprocess tooling
  'USER',     // Current username
  'LOGNAME',  // Login name (POSIX equivalent of USER)
  'TERM',     // Terminal type — affects output formatting
  'TMPDIR',   // Temp directory — used by Claude CLI and OS APIs
]);

const PREFIX_ALLOWLIST = [
  'LANG',       // LANG, LANGUAGE — locale settings
  'LC_',        // LC_ALL, LC_CTYPE, etc. — locale categories
  'XDG_',       // XDG_CONFIG_HOME, XDG_DATA_HOME — freedesktop paths
  'ANTHROPIC_', // ANTHROPIC_API_KEY — required for Claude API access
];

export function buildCleanEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (EXACT_ALLOWLIST.has(key)) {
      clean[key] = value;
      continue;
    }

    for (const prefix of PREFIX_ALLOWLIST) {
      if (key.startsWith(prefix)) {
        clean[key] = value;
        break;
      }
    }
  }

  return clean;
}
```

### Allowlist Rationale

| Variable / Prefix | Category | Why Allowed |
|---|---|---|
| `PATH` | System | Binary resolution — `claude`, `node`, `git` must be findable |
| `HOME` | System | Claude CLI reads config and cache from `~/.claude/` |
| `SHELL` | System | Some subprocess tooling respects the user's default shell |
| `USER`, `LOGNAME` | System | User identity — used by file permissions and audit trails |
| `TERM` | System | Terminal capability detection — affects output formatting |
| `TMPDIR` | System | Temp file location — used by Claude CLI internals and OS APIs |
| `LANG`, `LANGUAGE` | Locale | Text encoding and language — prevents mojibake in output |
| `LC_*` | Locale | Locale category overrides (collation, character type, etc.) |
| `XDG_*` | Paths | Freedesktop directory standards — config, data, cache locations |
| `ANTHROPIC_*` | API | API key and any Anthropic-specific configuration |

### Explicitly Excluded Variables

| Variable | Why Excluded |
|---|---|
| `CLAUDECODE` | Triggers nested-session guard in `claude` CLI — the root cause of this decision |
| `NODE_OPTIONS` | Parent's Node.js flags (e.g., `--max-old-space-size`) should not affect subprocess behavior |
| `npm_*` | npm lifecycle metadata leaks the parent's package manager context |
| `DEBUG` | Debug logging configuration from the parent would pollute subprocess output |
| `AWS_*`, `GCP_*`, etc. | Cloud credentials not needed by Claude CLI — principle of least privilege |
| `EDITOR`, `VISUAL` | Editor preferences irrelevant to non-interactive `--print` subprocesses |

### Usage Pattern

All subprocess spawn points pass `buildCleanEnv()` as the `env` option:

```typescript
// Expert routing (Haiku selection)
const child = spawn('claude', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: buildCleanEnv(),
});

// Expert query (subprocess manager)
const child = spawn('claude', args, {
  cwd: expert.mount_path,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: buildCleanEnv(),
});

// Expert query (session manager)
const { stdout } = await execFileAsync('claude', claudeArgs, {
  cwd: expert.mount_path,
  timeout: 300_000,
  maxBuffer: 10 * 1024 * 1024,
  env: buildCleanEnv(),
});
```

The function defaults to `process.env` as the source but accepts an explicit source parameter for testing:

```typescript
// In tests — provide a controlled environment
const env = buildCleanEnv({
  PATH: '/usr/bin',
  HOME: '/home/user',
  CLAUDECODE: '1',        // will be excluded
  ANTHROPIC_API_KEY: 'sk-ant-test',  // will be included
});
```

### Design Properties

- **Allowlist, not denylist.** New environment variables are excluded by default. Only explicitly listed variables pass through. This is the secure default — unknown variables from future tooling or CI environments are automatically blocked.
- **Stateless.** Each call to `buildCleanEnv()` returns a fresh object. No caching or shared state between calls.
- **Prefix matching.** The `PREFIX_ALLOWLIST` handles variable families (locale, XDG, Anthropic) without enumerating every possible variant.
- **Testable.** The `source` parameter allows unit tests to verify allowlist behavior without modifying `process.env`.

## Consequences

### Positive

- **Eliminates nested-session failures.** Excluding `CLAUDECODE` allows Lux to spawn Claude CLI subprocesses from within Claude Code sessions without triggering recursion guards.
- **Principle of least privilege.** Subprocesses receive only the variables they need. Cloud credentials, debugging flags, and npm metadata are stripped.
- **Predictable subprocess behavior.** Expert queries behave the same regardless of whether Lux is invoked from a terminal, an MCP server, a CI pipeline, or another agent.
- **Safe by default.** The allowlist approach means new environment variables introduced by future tooling are automatically excluded without code changes.

### Negative

- **Manual allowlist maintenance.** If a future subprocess legitimately needs a new environment variable (e.g., a proxy configuration via `HTTP_PROXY`), the allowlist must be updated. This is a deliberate friction point — it forces explicit consideration of what crosses the isolation boundary.
- **No per-subprocess customization.** All subprocesses get the same filtered environment. There is no mechanism for an expert to request additional variables (e.g., a database connection string). This would require extending the allowlist or adding per-expert overrides.
- **ANTHROPIC_* prefix is broad.** Any variable starting with `ANTHROPIC_` passes through, including potential future variables that may not be appropriate for all subprocesses.

### Neutral

- **Single shared implementation.** All four subprocess spawn sites use the same `buildCleanEnv()` function. Routing subprocesses (Haiku) and expert query subprocesses (configurable model) receive identical filtered environments.
- **No runtime overhead.** The allowlist check is a simple set lookup and prefix scan over the source environment, executed once per subprocess spawn.
