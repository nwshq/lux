# Integration Test Scripts

Shell-based and Node.js integration tests that exercise Lux against real MCP server processes, git repositories, and databases. These are separate from the Vitest unit tests in `src/**/__tests__/`.

## Prerequisites

All scripts require a built project:

```bash
npm run build
```

Some scripts also require:
- A populated database (`lux index rebuild`)
- `jq` for JSON output parsing (edge-case tests)
- `sqlite3` CLI (list-projects test)

## Script Inventory

| Script | Type | What It Tests |
|--------|------|---------------|
| `test-mcp-stdio.sh` | Shell | MCP server startup, stdio transport, tool registration |
| `test-list-projects.sh` | Shell | `lux_list_projects` MCP tool — parameter schema, error handling, live data |
| `test-log-event.sh` | Shell | `lux_log_event` MCP tool — basic event logging with context |
| `test-log-event-edge-cases.sh` | Shell | `lux_log_event` MCP tool — empty payloads, nested objects, special chars |
| `test-hooks-integration.sh` | Shell | Full git hook lifecycle: install → commit → rebuild → skip → uninstall |
| `test-post-commit-hook.sh` | Shell | Post-commit hook scenarios: CORPUS changes, skip directives, missing CLI |
| `test-get-file-simple.cjs` | Node (CJS) | `lux_get_file` MCP tool — temp file creation, read-back, content verification |
| `test-get-file-mcp.cjs` | Node (CJS) | `lux_get_file` MCP tool — real CORPUS files, error handling for missing files |

## Running

All scripts are run from the project root:

```bash
# Shell scripts
bash test-mcp-stdio.sh
bash test-list-projects.sh
bash test-hooks-integration.sh
bash test-post-commit-hook.sh
bash test-log-event.sh
bash test-log-event-edge-cases.sh

# Node.js scripts
node test-get-file-simple.cjs
node test-get-file-mcp.cjs
```

Scripts exit with code 0 on success and code 1 on failure.

## Script Details

### test-mcp-stdio.sh

Verifies the MCP server starts correctly over stdio transport and advertises all expected tools.

**Tests (8):**
1. Server starts and accepts JSON-RPC input
2. `lux_search` tool is listed
3. `lux_get_client` tool is listed
4. `lux_log_comm` tool is listed
5. `lux_rebuild_index` tool is listed
6. Server advertises tools capability
7. Server script has proper shebang (`#!/usr/bin/env node`)
8. Server file is executable

**Pattern:** Pipes JSON-RPC `tools/list` requests to `node dist/mcp/server.js` via stdin and greps stdout for expected patterns.

---

### test-list-projects.sh

Tests the `lux_list_projects` MCP tool including schema validation and live data queries.

**Tests (5–8):**
1. Tool is listed in `tools/list` response
2. Tool description matches expected text
3. Tool requires `client_slug` parameter
4. Returns error for non-existent client
5. *(Live data)* Successfully lists projects for a real client
6. *(Live data)* Response contains JSON array
7. *(Live data)* Sample response display

Tests 5–7 only run when `~/.lux/lux.db` contains client data.

---

### test-log-event.sh

Tests basic `lux_log_event` functionality across different parameter combinations.

**Tests (5):**
1. Basic event logging (source + event_type + summary)
2. Event with client context (`client_slug`)
3. Event with client and project context
4. Event with custom JSON payload
5. Event with non-existent client (should succeed without client_id)

Verifies events in the database after all tests using a Node.js inline script.

---

### test-log-event-edge-cases.sh

Tests `lux_log_event` with unusual and boundary inputs.

**Tests (6):**
1. Empty payload object `{}`
2. Complex nested payload (arrays, deep nesting, booleans, nulls)
3. Very long summary string (~250 chars)
4. Special characters (quotes, apostrophes, ampersands, unicode)
5. Project slug without client slug (orphan reference)
6. Numeric values in string fields (type preservation)

---

### test-hooks-integration.sh

End-to-end test of the git hook lifecycle. Creates a temporary git repository with CORPUS structure.

**Tests (7):**
1. `lux hooks install` creates hook file
2. Hook file contains Lux marker
3. Re-install detects existing hook
4. Hook triggers on CORPUS changes (via mock CLI)
5. Hook respects `[skip lux]` commit message directive
6. `lux hooks uninstall` removes hook file
7. Re-uninstall reports no hook found

**Environment:** Creates temp directory, initializes git repo, uses mock `LUX_CLI` and `LUX_LOG_FILE` for verification. Cleans up via trap.

---

### test-post-commit-hook.sh

Tests the raw `bin/post-commit-hook.sh` script directly (without the CLI install/uninstall layer).

**Tests (6):**
1. Commit with `knowledge/` changes triggers rebuild
2. Commit without CORPUS changes skips rebuild
3. Commit with `[skip lux]` directive skips rebuild
4. `LUX_SKIP_REBUILD=1` env var skips rebuild
5. Missing lux CLI handled gracefully
6. Changes to `explorations/` trigger rebuild

**Environment:** Same temp git repo pattern as hooks-integration. Tests the hook script in isolation.

---

### test-get-file-simple.cjs

Node.js CJS script that tests `lux_get_file` with a controlled temp file.

**Tests (1):**
1. Creates a markdown file with YAML frontmatter, reads it via MCP, verifies exact content match

**Pattern:** Spawns MCP server as child process, sends JSON-RPC via stdin, parses JSON-RPC response from stdout. Creates and cleans up temp files.

---

### test-get-file-mcp.cjs

Node.js CJS script that tests `lux_get_file` against real CORPUS files.

**Tests (4):**
1. Read client file (`~/CORPUS/clients/acme/CLIENT.md`)
2. Read project file (`~/CORPUS/clients/acme/lux-knowledge-platform/PROJECT.md`)
3. Read non-existent file (expects error response)
4. Read communication file (tolerates missing file)

**Requires:** Populated CORPUS directory at `~/CORPUS`.

## Common Patterns

### MCP Stdio Test Pattern (Shell)

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{...}}' \
  | node dist/mcp/server.js 2>/dev/null \
  | jq '.result.content[0].text'
```

### MCP Stdio Test Pattern (Node.js CJS)

```javascript
const server = spawn('node', [MCP_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
server.stdin.write(JSON.stringify(request) + '\n');
server.stdin.end();
// Parse JSON-RPC response from stdout
```

### Git Hook Test Pattern

```bash
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT
cd "$TEST_DIR" && git init -q
export LUX_CLI="echo mock"        # Mock CLI
export LUX_LOG_FILE="$TEST_DIR/hook.log"  # Capture hook output
# Make commits, verify log file contents
```

## Relationship to Vitest Tests

These integration scripts complement the Vitest unit tests (`npm test`):

| Aspect | Vitest (`src/**/__tests__/`) | Integration Scripts (root `test-*`) |
|--------|-----|------|
| **Runner** | Vitest framework | Direct bash/node execution |
| **Scope** | Unit/component level | Full process (MCP server, git repos) |
| **Isolation** | Mocked dependencies | Real processes and filesystem |
| **CI-ready** | Yes (`npm test`) | Manual — some require live data |
| **Speed** | Fast (in-process) | Slower (process spawn per test) |
