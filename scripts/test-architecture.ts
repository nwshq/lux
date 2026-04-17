#!/usr/bin/env npx tsx
/**
 * Architecture test — validates structural conventions across the codebase.
 *
 * Checks:
 *   1. Module boundary validation — src/ contains only recognized modules
 *   2. Test colocation — test files live in __tests__/ within their module
 *   3. CLI kebab-case naming — src/cli/ files use kebab-case
 *   4. Migration naming — src/db/migrations/ files follow NNN_description.sql
 *
 * Usage:
 *   npx tsx scripts/test-architecture.ts [--json]
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — violations found
 */

import { readdirSync, existsSync } from 'fs';
import { resolve, relative, join } from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const SRC = resolve(ROOT, 'src');

/** Recognized top-level modules under src/. */
const ALLOWED_MODULES = new Set([
  'cli',
  'db',
  'discovery',
  'experts',
  'init',
  'integration',
  'lint',
  'mcp',
  'scanner',
  'utils',
]);

/** Intentional root entry points under src/. */
const ALLOWED_ROOT_TS_FILES = new Set(['index.ts']);

/** Modules that are test-only (contain only __tests__/, no source files expected at root). */
const TEST_ONLY_MODULES = new Set(['integration']);

/** Pattern: NNN_description.sql (3-digit prefix, underscore, lowercase with underscores). */
const MIGRATION_PATTERN = /^\d{3}_[a-z][a-z0-9_]*\.sql$/;

/** Pattern: kebab-case TypeScript file (lowercase, hyphens allowed, no underscores or uppercase). */
const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.ts$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  check: 'module-boundary' | 'test-colocation' | 'cli-naming' | 'migration-naming';
  message: string;
}

interface CheckResult {
  check: string;
  passed: boolean;
  violations: Violation[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all files under a directory. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

/** Get immediate file names in a directory. */
function getFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Check 1: Module boundary validation
// ---------------------------------------------------------------------------

function checkModuleBoundaries(): CheckResult {
  const violations: Violation[] = [];

  // Check that src/ only contains recognized module directories
  const entries = readdirSync(SRC, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ALLOWED_MODULES.has(entry.name)) {
        violations.push({
          file: `src/${entry.name}/`,
          check: 'module-boundary',
          message: `Unrecognized module directory "src/${entry.name}/". Allowed modules: ${[...ALLOWED_MODULES].sort().join(', ')}`,
        });
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      // No loose .ts files at src/ root, except explicit package entry points.
      if (!ALLOWED_ROOT_TS_FILES.has(entry.name)) {
        violations.push({
          file: `src/${entry.name}`,
          check: 'module-boundary',
          message: `Loose TypeScript file at src/ root. All source files must live within a module directory unless explicitly allowed as a package entry point.`,
        });
      }
    }
  }

  // Check each module has an entry point (index.ts or a primary .ts file)
  // Test-only modules (e.g. integration/) are exempt — they contain only __tests__/
  for (const mod of ALLOWED_MODULES) {
    if (TEST_ONLY_MODULES.has(mod)) continue;

    const modDir = resolve(SRC, mod);
    if (!existsSync(modDir)) continue;

    const tsFiles = getFiles(modDir).filter((f) => f.endsWith('.ts'));
    if (tsFiles.length === 0) {
      violations.push({
        file: `src/${mod}/`,
        check: 'module-boundary',
        message: `Module "src/${mod}/" has no TypeScript files at its root.`,
      });
    }
  }

  return {
    check: 'module-boundary',
    passed: violations.length === 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Check 2: Test colocation
// ---------------------------------------------------------------------------

function checkTestColocation(): CheckResult {
  const violations: Violation[] = [];

  // Find all test files in the codebase
  const allFiles = walkDir(SRC);
  const testFiles = allFiles.filter((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'));

  for (const testFile of testFiles) {
    const rel = relative(SRC, testFile);
    const parts = rel.split('/');

    // Test files must be inside a __tests__/ directory
    if (!parts.includes('__tests__')) {
      violations.push({
        file: `src/${rel}`,
        check: 'test-colocation',
        message: `Test file is not inside a __tests__/ directory. Move to the colocated __tests__/ directory within its module.`,
      });
      continue;
    }

    // The __tests__/ directory must be within a recognized module
    const moduleName = parts[0];
    if (!ALLOWED_MODULES.has(moduleName)) {
      violations.push({
        file: `src/${rel}`,
        check: 'test-colocation',
        message: `Test file is inside unrecognized module "src/${moduleName}/".`,
      });
      continue;
    }

    // __tests__/ must be a direct child of the module or a sub-module, not deeply nested elsewhere
    const testsIndex = parts.indexOf('__tests__');
    // Valid patterns:
    //   src/<module>/__tests__/file.test.ts           (testsIndex = 1)
    //   src/<module>/<submod>/__tests__/file.test.ts   (testsIndex = 2)
    //   src/<module>/<submod>/<sub>/__tests__/file.test.ts (testsIndex = 3 at most)
    // The test file should be directly inside __tests__/ (not further nested)
    if (testsIndex + 2 !== parts.length) {
      violations.push({
        file: `src/${rel}`,
        check: 'test-colocation',
        message: `Test file is nested inside __tests__/. Test files should be direct children of __tests__/.`,
      });
    }
  }

  return {
    check: 'test-colocation',
    passed: violations.length === 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Check 3: CLI kebab-case naming
// ---------------------------------------------------------------------------

function checkCliNaming(): CheckResult {
  const violations: Violation[] = [];
  const cliDir = resolve(SRC, 'cli');

  if (!existsSync(cliDir)) {
    return { check: 'cli-naming', passed: true, violations };
  }

  const tsFiles = getFiles(cliDir).filter((f) => f.endsWith('.ts'));

  for (const file of tsFiles) {
    // index.ts is always allowed
    if (file === 'index.ts') continue;

    if (!KEBAB_CASE_PATTERN.test(file)) {
      violations.push({
        file: `src/cli/${file}`,
        check: 'cli-naming',
        message: `CLI command file "${file}" does not follow kebab-case naming convention. Expected pattern: lowercase-with-hyphens.ts`,
      });
    }
  }

  return {
    check: 'cli-naming',
    passed: violations.length === 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Check 4: Migration naming conventions
// ---------------------------------------------------------------------------

function checkMigrationNaming(): CheckResult {
  const violations: Violation[] = [];
  const migrationsDir = resolve(SRC, 'db', 'migrations');

  if (!existsSync(migrationsDir)) {
    return { check: 'migration-naming', passed: true, violations };
  }

  const files = getFiles(migrationsDir).filter((f) => f.endsWith('.sql'));

  // Track migration numbers for gap/duplicate detection
  const seenNumbers = new Map<number, string>();

  for (const file of files) {
    if (!MIGRATION_PATTERN.test(file)) {
      violations.push({
        file: `src/db/migrations/${file}`,
        check: 'migration-naming',
        message: `Migration file "${file}" does not follow naming convention. Expected: NNN_description.sql (e.g., 001_initial_schema.sql)`,
      });
      continue;
    }

    const num = parseInt(file.substring(0, 3), 10);

    // Check for duplicate migration numbers
    if (seenNumbers.has(num)) {
      violations.push({
        file: `src/db/migrations/${file}`,
        check: 'migration-naming',
        message: `Duplicate migration number ${num.toString().padStart(3, '0')}. Also used by "${seenNumbers.get(num)}".`,
      });
    } else {
      seenNumbers.set(num, file);
    }
  }

  // Check for gaps in migration numbering
  if (seenNumbers.size > 0) {
    const numbers = [...seenNumbers.keys()].sort((a, b) => a - b);
    const expectedStart = numbers[0];
    for (let i = 0; i < numbers.length; i++) {
      const expected = expectedStart + i;
      if (numbers[i] !== expected) {
        violations.push({
          file: `src/db/migrations/`,
          check: 'migration-naming',
          message: `Gap in migration numbering: expected ${expected.toString().padStart(3, '0')} but found ${numbers[i].toString().padStart(3, '0')}. Migrations must be sequential.`,
        });
        break; // Report only the first gap
      }
    }
  }

  return {
    check: 'migration-naming',
    passed: violations.length === 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  const results: CheckResult[] = [
    checkModuleBoundaries(),
    checkTestColocation(),
    checkCliNaming(),
    checkMigrationNaming(),
  ];

  const allViolations = results.flatMap((r) => r.violations);
  const allPassed = allViolations.length === 0;

  if (jsonOutput) {
    const output = {
      results: results.map((r) => ({
        check: r.check,
        passed: r.passed,
        violationCount: r.violations.length,
        violations: r.violations,
      })),
      summary: {
        totalChecks: results.length,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
        totalViolations: allViolations.length,
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    for (const result of results) {
      const status = result.passed ? 'PASS' : 'FAIL';
      const label = result.check.replace(/-/g, ' ');
      console.log(`  [${status}] ${label}`);

      if (!result.passed) {
        for (const v of result.violations) {
          console.error(`         ${v.file}`);
          console.error(`         ${v.message}`);
          console.error('');
        }
      }
    }

    console.log('');
    if (allPassed) {
      console.log(
        `Architecture tests passed. ${results.length} checks, 0 violations.`,
      );
    } else {
      console.error(
        `${allViolations.length} violation(s) across ${results.filter((r) => !r.passed).length} check(s).`,
      );
    }
  }

  process.exit(allPassed ? 0 : 1);
}

main();
