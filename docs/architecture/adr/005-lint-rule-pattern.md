# ADR-005: Pluggable Lint Rule Pattern

**Status:** accepted
**Date:** 2026-02-23

## Context

Lux manages a CORPUS of markdown files organized by clients, projects, explorations, and payloads. This structure follows naming conventions (date-prefixed filenames), location rules (project-scoped payloads), and content requirements (TASKS.md in payload directories). Violations of these conventions cause downstream issues — broken scanner assumptions, inconsistent navigation, and missing metadata.

A validation system is needed that:

1. **Enforces CORPUS conventions** — catches naming errors, misplaced files, and missing required content before they propagate.
2. **Categorizes findings by severity** — distinguishes hard errors from soft warnings and informational observations.
3. **Is extensible** — new rules can be added without modifying the engine. Rules should be self-contained units that can be independently tested.
4. **Provides actionable feedback** — results include not just what's wrong but how to fix it.

A monolithic validation function would be difficult to maintain as rules grow. A plugin-based approach with a shared interface allows rules to be developed, tested, and registered independently.

## Decision

We implement a **pluggable lint rule pattern** with a `LintRule` interface, a `LintEngine` runner, and categorized rule implementations in `src/lint/`.

### Core Types

Defined in `src/lint/types.ts`:

```typescript
export type Severity = 'error' | 'warning' | 'info';

export interface LintResult {
  path: string;          // Absolute path to the file or directory
  rule: string;          // Rule name (e.g., 'valid-exploration-filename')
  severity: Severity;    // Severity level
  message: string;       // Human-readable description of the issue
  suggestion?: string;   // Actionable fix suggestion
  autoFixable?: boolean; // Whether automated repair is possible (future use)
}

export interface LintFile {
  path: string;                       // Absolute path
  relativePath: string;               // Path relative to CORPUS root
  isDirectory: boolean;               // Whether this entry is a directory
  frontmatter?: Record<string, unknown>; // Parsed YAML frontmatter (if present)
}

export interface LintRule {
  name: string;          // Unique identifier (kebab-case)
  description: string;   // Human-readable purpose
  severity: Severity;    // Default severity for this rule's findings
  check(file: LintFile, corpusPath: string): LintResult[];
}
```

**Key design choices:**

- `LintFile` is the unit of inspection. The engine passes every file and directory to every rule. Rules decide internally whether a file is relevant (early return `[]` for non-applicable files).
- `check()` is synchronous and returns an array. A rule may produce zero, one, or multiple results per file.
- `severity` is declared at both the rule level (default) and result level (per-finding). Rules use `this.severity` in results for consistency but could override per-finding if needed.
- `suggestion` provides actionable remediation text, often including a concrete rename or move command.

### LintEngine

The engine in `src/lint/index.ts` orchestrates file collection and rule execution:

```typescript
export class LintEngine {
  private rules: LintRule[];

  constructor(rules?: LintRule[]) {
    this.rules = rules ?? DEFAULT_RULES;
  }

  async lint(corpusPath: string, targetPath?: string): Promise<LintResult[]> {
    const scanPath = targetPath ?? corpusPath;
    const files = await this.collectFiles(scanPath, corpusPath);
    const results: LintResult[] = [];

    for (const file of files) {
      for (const rule of this.rules) {
        const ruleResults = rule.check(file, corpusPath);
        results.push(...ruleResults);
      }
    }

    return results;
  }
}
```

**Engine behavior:**

- Collects all `.md` files and directories under the scan path via glob.
- Iterates files × rules, applying every rule to every file. Rules self-filter by checking `file.isDirectory`, path patterns, and file extensions.
- Accepts an optional `targetPath` for scoped linting (a subdirectory) while maintaining `corpusPath` as the reference root for relative path computation.
- Constructor accepts custom rules for testing; defaults to `DEFAULT_RULES` for production.

### Rule Implementation Pattern

Each rule is a plain object literal conforming to `LintRule`, exported as a named constant from its own file. Rules follow a consistent pattern:

```typescript
// src/lint/rules/naming/valid-exploration-filename.ts

import { basename } from 'path';
import type { LintFile, LintResult, LintRule } from '../../types.js';

const EXPLORATION_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

export const validExplorationFilename: LintRule = {
  name: 'valid-exploration-filename',
  description: 'Exploration filenames must match YYYY-MM-DD-<slug>.md pattern',
  severity: 'error',

  check(file: LintFile, _corpusPath: string): LintResult[] {
    // 1. Guard: skip non-applicable files
    if (file.isDirectory) return [];
    if (!file.relativePath.includes('explorations/')) return [];

    // 2. Validate against the rule's criteria
    const filename = basename(file.path);
    if (EXPLORATION_FILENAME_PATTERN.test(filename)) return [];

    // 3. Return result with actionable suggestion
    return [{
      path: file.path,
      rule: this.name,
      severity: this.severity,
      message: `Exploration filename "${filename}" does not match required pattern`,
      suggestion: `Rename to match YYYY-MM-DD-<slug>.md`,
    }];
  },
};
```

### Rule Directory Organization

Rules are organized into three categories under `src/lint/rules/`:

```
src/lint/rules/
├── naming/           # File and directory naming conventions
│   ├── valid-exploration-filename.ts
│   └── valid-payload-dirname.ts
├── location/         # Directory structure and placement validation
│   ├── index.ts      # Barrel re-exports
│   ├── exploration-location.ts
│   ├── exploration-corpus-location.ts
│   ├── payload-location.ts
│   └── payload-corpus-location.ts
└── structure/        # Content and structural requirements
    └── payload-has-tasks.ts
```

### Current Rule Inventory

| Rule | Category | Severity | Purpose |
|------|----------|----------|---------|
| `valid-exploration-filename` | naming | error | Exploration files must match `YYYY-MM-DD-<slug>.md` with valid calendar dates |
| `valid-payload-dirname` | naming | error | Payload directories must match `YYYY-MM-DD-<slug>/` with valid calendar dates |
| `exploration-location` | location | error | Explorations must be cross-cutting (`explorations/`) or project-scoped (`knowledge/.../projects/<name>/explorations/`) |
| `exploration-corpus-location` | location | info | Flags cross-cutting explorations at CORPUS root (allowed but notable) |
| `payload-location` | location | error | Payloads must be project-scoped (`knowledge/.../projects/<name>/payloads/`) — catches deprecated `implementation-payloads/` |
| `payload-corpus-location` | location | error | Payloads at CORPUS root are errors — must be project-scoped |
| `payload-has-tasks` | structure | error | Every payload directory must contain a `TASKS.md` file |

### Registration

Rules are registered in `src/lint/index.ts` as a static array:

```typescript
const DEFAULT_RULES: LintRule[] = [
  // Naming rules
  validExplorationFilename,
  validPayloadDirname,
  // Structure rules
  payloadHasTasks,
  // Location rules
  explorationLocation,
  explorationCorpusLocation,
  payloadLocation,
  payloadCorpusLocation,
];
```

### Adding a New Rule

1. Create a new file in the appropriate category directory (e.g., `src/lint/rules/naming/my-rule.ts`).
2. Export a `LintRule` object with `name`, `description`, `severity`, and `check()`.
3. Import and add the rule to `DEFAULT_RULES` in `src/lint/index.ts`.
4. Create a test in `src/lint/__tests__/my-rule.test.ts`.

### CLI Integration

The `lux lint` command exposes the engine with filtering options:

```bash
lux lint [path]              # Lint entire CORPUS or a specific path
lux lint --severity error    # Show only errors
lux lint --rule valid-exploration-filename  # Run a single rule
lux lint --format json       # Machine-readable output
lux lint --quiet             # Errors only (suppresses warnings and info)
```

The CLI exits with code 1 if any errors are found, making it suitable for CI pipelines and git hooks.

## Consequences

### Positive

- **Independent rule development.** Each rule is a self-contained file with its own logic, tests, and documentation. Rules can be added without modifying the engine.
- **Consistent interface.** All rules produce `LintResult` objects with the same shape — path, rule name, severity, message, and optional suggestion. This enables uniform formatting, filtering, and JSON output.
- **Testable in isolation.** Rules are plain functions that take a `LintFile` and return results. Tests can construct synthetic `LintFile` objects without touching the filesystem (except for rules like `payload-has-tasks` that check file existence).
- **Actionable output.** Every finding includes a `suggestion` field with concrete remediation (e.g., a specific rename command), not just a description of the violation.
- **Severity-based filtering.** The three-tier severity system (`error` > `warning` > `info`) lets the CLI, CI, and users control verbosity. Only `error`-level findings cause non-zero exit codes.

### Negative

- **All rules run on all files.** The engine passes every collected file to every rule. Each rule must internally guard against non-applicable files (early-return `[]`). This is O(files × rules) and relies on rules being efficient in their guard clauses.
- **No rule dependency or ordering.** Rules run independently — one rule cannot depend on or be informed by another rule's findings. If a future rule needs context from another (e.g., "only check structure if naming is valid"), this would require engine-level changes.
- **Static registration.** Adding a rule requires importing it into `src/lint/index.ts` and adding it to the `DEFAULT_RULES` array. There is no dynamic discovery or plugin loading.

### Neutral

- **Object literal rules, not classes.** Rules are plain `LintRule` objects, not class instances. This is simpler for stateless rules but means rules with shared helpers (like `isPayloadDir()`) duplicate the helper across files rather than inheriting from a base class.
- **Synchronous `check()` method.** Rules that need filesystem access (e.g., `payload-has-tasks` checking for `TASKS.md`) use synchronous `existsSync()`. This is acceptable because the CORPUS is local and the engine already uses `async` for file collection via glob.
- **`autoFixable` field is forward-looking.** The `LintResult` interface includes `autoFixable?: boolean` but no rule currently implements auto-fixing. This field is reserved for future `lux lint --fix` functionality.
