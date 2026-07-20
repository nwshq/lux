#!/usr/bin/env npx tsx
/**
 * Architecture linter — validates layer dependency rules and forbidden patterns.
 *
 * Layers (top → bottom):
 *   1. Interface:      cli/, mcp/
 *   2. Business Logic: scanner/
 *   3. Data Access:    db/
 *   4. Shared:         utils/   (any layer may import)
 *
 * Dependency rule: a module may only import from its own layer, layers below it,
 * or utils/. Importing *upward* is a violation.
 *
 * Forbidden patterns are additional specific import pairs that are never allowed
 * even between modules on the same layer.
 *
 * Any import statement with a trailing `// @architecture-ignore` comment is
 * suppressed from violation reporting.
 *
 * Usage:
 *   npx tsx scripts/lint-architecture.ts [--json] [--fix-suggestions]
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found
 */

import { Project, SyntaxKind, type SourceFile, type ImportDeclaration } from 'ts-morph';
import { resolve, relative, dirname, posix } from 'path';

// ---------------------------------------------------------------------------
// Layer definitions
// ---------------------------------------------------------------------------

/** Layers ordered from highest (interface) to lowest (shared). */
const LAYERS = ['interface', 'business', 'data', 'shared'] as const;
type Layer = (typeof LAYERS)[number];

const MODULE_LAYER: Record<string, Layer> = {
  cli: 'interface',
  mcp: 'interface',
  scanner: 'business',
  db: 'data',
  utils: 'shared',
  integration: 'interface', // integration tests live at interface level
};

function layerRank(layer: Layer): number {
  return LAYERS.indexOf(layer);
}

// ---------------------------------------------------------------------------
// Forbidden cross-module imports (same-layer restrictions)
// ---------------------------------------------------------------------------

/**
 * Map of source module → set of modules it must NOT import from.
 * These go beyond the general layer rule (e.g. business-to-business bans).
 */
const FORBIDDEN_IMPORTS: Record<string, Set<string>> = {
  // Data layer must not import from any higher layer
  db: new Set(['cli', 'mcp', 'scanner']),
  // Utils must be leaf — imports nothing from src/
  utils: new Set(['cli', 'mcp', 'scanner', 'db']),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  sourceModule: string;
  targetModule: string;
  importPath: string;
  rule: 'layer-dependency' | 'forbidden-import';
  message: string;
  suppressed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const SRC = resolve(ROOT, 'src');

/** Extract the top-level module name from a file path under src/. */
function getModule(filePath: string): string | undefined {
  const rel = relative(SRC, filePath);
  if (rel.startsWith('..')) return undefined;
  return rel.split(/[\\/]/)[0];
}

/**
 * Resolve a relative import specifier to a target module.
 * Returns the top-level module name or undefined for external/unresolvable.
 */
function resolveTargetModule(importPath: string, sourceFilePath: string): string | undefined {
  if (!importPath.startsWith('.')) return undefined; // external package
  const sourceDir = dirname(sourceFilePath);
  const resolved = resolve(sourceDir, importPath);
  return getModule(resolved);
}

/** Check whether an import declaration has a trailing `@architecture-ignore` comment. */
function hasSuppression(decl: ImportDeclaration): boolean {
  // Check trailing comments on the statement itself
  const trailingComments = decl.getTrailingCommentRanges();
  for (const comment of trailingComments) {
    if (comment.getText().includes('@architecture-ignore')) return true;
  }

  // Also check leading comments on the next statement (some formatters move them)
  const nextSibling = decl.getNextSibling();
  if (nextSibling) {
    const leadingComments = nextSibling.getLeadingCommentRanges();
    for (const comment of leadingComments) {
      if (comment.getText().includes('@architecture-ignore')) return true;
    }
  }

  // Check comments within the declaration itself (inline)
  const fullText = decl.getFullText();
  if (fullText.includes('@architecture-ignore')) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

function analyzeFile(sourceFile: SourceFile): Violation[] {
  const violations: Violation[] = [];
  const filePath = sourceFile.getFilePath();
  const sourceModule = getModule(filePath);
  if (!sourceModule || !(sourceModule in MODULE_LAYER)) return violations;

  const sourceLayer = MODULE_LAYER[sourceModule];

  // Gather all import declarations (static imports)
  const imports = sourceFile.getImportDeclarations();

  for (const decl of imports) {
    const specifier = decl.getModuleSpecifierValue();
    const targetModule = resolveTargetModule(specifier, filePath);

    // Skip: external packages, same-module imports, or unknown modules
    if (!targetModule || targetModule === sourceModule || !(targetModule in MODULE_LAYER)) continue;

    const targetLayer = MODULE_LAYER[targetModule];
    const suppressed = hasSuppression(decl);
    const line = decl.getStartLineNumber();

    // Rule 1: Layer dependency — cannot import upward (lower rank number = higher layer)
    // Shared (utils) can be imported by anyone, so skip that check
    if (targetLayer !== 'shared' && layerRank(targetLayer) < layerRank(sourceLayer)) {
      violations.push({
        file: relative(ROOT, filePath),
        line,
        sourceModule,
        targetModule,
        importPath: specifier,
        rule: 'layer-dependency',
        message: `${sourceModule}/ (${sourceLayer}) imports from ${targetModule}/ (${targetLayer}) — upward layer dependency`,
        suppressed,
      });
      continue; // Don't double-report
    }

    // Rule 2: Forbidden import pairs (same-layer or explicit bans)
    const forbidden = FORBIDDEN_IMPORTS[sourceModule];
    if (forbidden?.has(targetModule)) {
      violations.push({
        file: relative(ROOT, filePath),
        line,
        sourceModule,
        targetModule,
        importPath: specifier,
        rule: 'forbidden-import',
        message: `${sourceModule}/ must not import from ${targetModule}/`,
        suppressed,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Dynamic import detection (forbidden pattern)
// ---------------------------------------------------------------------------

function detectDynamicCrossModuleImports(sourceFile: SourceFile): Violation[] {
  const violations: Violation[] = [];
  const filePath = sourceFile.getFilePath();
  const sourceModule = getModule(filePath);
  if (!sourceModule || !(sourceModule in MODULE_LAYER)) return violations;

  // Find dynamic import() expressions
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExpressions) {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.ImportKeyword) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    const arg = args[0];
    if (arg.getKind() !== SyntaxKind.StringLiteral) continue;

    const specifier = arg.getText().slice(1, -1); // Remove quotes
    const targetModule = resolveTargetModule(specifier, filePath);
    if (!targetModule || targetModule === sourceModule || !(targetModule in MODULE_LAYER)) continue;

    const targetLayer = MODULE_LAYER[targetModule];
    const sourceLayer = MODULE_LAYER[sourceModule];
    const line = call.getStartLineNumber();

    // Check full text of the statement for suppression comment
    const parent = call.getParent();
    const fullText = parent ? parent.getFullText() : call.getFullText();
    const suppressed = fullText.includes('@architecture-ignore');

    if (targetLayer !== 'shared' && layerRank(targetLayer) < layerRank(sourceLayer)) {
      violations.push({
        file: relative(ROOT, filePath),
        line,
        sourceModule,
        targetModule,
        importPath: specifier,
        rule: 'layer-dependency',
        message: `${sourceModule}/ (${sourceLayer}) dynamically imports from ${targetModule}/ (${targetLayer}) — upward layer dependency`,
        suppressed,
      });
    }

    const forbidden = FORBIDDEN_IMPORTS[sourceModule];
    if (forbidden?.has(targetModule)) {
      violations.push({
        file: relative(ROOT, filePath),
        line,
        sourceModule,
        targetModule,
        importPath: specifier,
        rule: 'forbidden-import',
        message: `${sourceModule}/ must not dynamically import from ${targetModule}/`,
        suppressed,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const showSuppressed = args.includes('--show-suppressed');

  const project = new Project({
    tsConfigFilePath: resolve(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: false,
  });

  const sourceFiles = project.getSourceFiles().filter((sf) => {
    const rel = relative(SRC, sf.getFilePath());
    // Only analyze files under src/, skip __tests__ directories
    return !rel.startsWith('..') && !rel.includes('__tests__');
  });

  const allViolations: Violation[] = [];

  for (const sf of sourceFiles) {
    allViolations.push(...analyzeFile(sf));
    allViolations.push(...detectDynamicCrossModuleImports(sf));
  }

  const active = allViolations.filter((v) => !v.suppressed);
  const suppressed = allViolations.filter((v) => v.suppressed);

  if (jsonOutput) {
    const output = {
      violations: active,
      suppressed: showSuppressed ? suppressed : undefined,
      summary: {
        total: allViolations.length,
        active: active.length,
        suppressed: suppressed.length,
        filesAnalyzed: sourceFiles.length,
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (active.length === 0) {
      console.log(
        `Architecture lint passed. ${sourceFiles.length} files analyzed, 0 violations.` +
          (suppressed.length > 0 ? ` (${suppressed.length} suppressed)` : ''),
      );
    } else {
      console.error(`\nArchitecture violations found:\n`);
      for (const v of active) {
        console.error(`  ${v.file}:${v.line}`);
        console.error(`    ${v.message}`);
        console.error(`    import: ${v.importPath}`);
        console.error(`    rule: ${v.rule}`);
        console.error('');
      }
      console.error(
        `${active.length} violation(s) in ${sourceFiles.length} files.` +
          (suppressed.length > 0 ? ` (${suppressed.length} suppressed with @architecture-ignore)` : ''),
      );
    }

    if (showSuppressed && suppressed.length > 0) {
      console.log(`\nSuppressed violations:\n`);
      for (const v of suppressed) {
        console.log(`  ${v.file}:${v.line} [suppressed]`);
        console.log(`    ${v.message}`);
        console.log(`    import: ${v.importPath}`);
        console.log('');
      }
    }
  }

  process.exit(active.length > 0 ? 1 : 0);
}

main();
