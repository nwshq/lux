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
 * Path-granular rules (PATH_FORBIDDEN_RULES) additionally fence a specific subtree — not a whole
 * module — behind an explicit importer allowlist. This is how src/scanner/embeddings/ is fenced
 * from the rest of scanner/ (Decision-Boundary, the anchor embeddings fence): module-granular rules
 * collapse everything under scanner/ to one module name and cannot see a same-module violation
 * (e.g. scanner/anchors/ or scanner/associations/ reaching into scanner/embeddings/).
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

import {
  Project,
  SyntaxKind,
  type SourceFile,
  type ImportDeclaration,
  type ExportDeclaration,
} from 'ts-morph';
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
// Path-granular forbidden rules (Decision-Boundary — anchor embeddings fence)
// ---------------------------------------------------------------------------

/**
 * Unlike FORBIDDEN_IMPORTS/MODULE_LAYER — both keyed on the top-level module name, so everything
 * under scanner/ collapses to "scanner" — a PATH_FORBIDDEN_RULES entry fences a *subtree*: a
 * forbidden target path-prefix (relative to src/, POSIX, trailing slash) plus an explicit
 * allowlist of importer path-prefixes permitted to import it.
 *
 * `allowedImporters` entries ending in '/' match by prefix (a whole subtree may import in,
 * e.g. the fenced directory importing its own siblings); an entry with no trailing slash matches
 * exactly one file (e.g. one CLI entry point).
 *
 * Adding a consumer is a one-line edit to `allowedImporters` — deliberately, so crossing the
 * anchor/structural boundary (Decision-Boundary) is visible in a reviewed diff, not silent.
 */
interface PathForbiddenRule {
  /** forbidden target path-prefix, relative to src/, POSIX, trailing slash (a directory) */
  targetPrefix: string;
  /** importer path-prefixes (relative to src/, POSIX) permitted to import targetPrefix */
  allowedImporters: string[];
  /** short label folded into the violation message */
  label: string;
}

/**
 * The anchor embeddings fence (Decision-Boundary). ALLOW/DENY set frozen in
 * 03-ARCHITECTURE-AND-CONTRACT.md §Layer & fence analysis:
 *   ALLOW: src/scanner/embeddings/**      (internal — codec/cosine/embedder/node-embed-pass/etc.)
 *          src/cli/index.ts               (embed-pass tail — runNodeEmbedTail/getSharedEmbedder,
 *                                          03 §The four embed-pass integration points)
 *          src/cli/anchor-search.ts       (the shared hybrid orchestration — runAnchorSearch fetches
 *                                          the semantic candidates via topCosine)
 *          src/cli/anchors.ts             (the `lux anchors` CLI)
 *          src/mcp/server.ts              (the `lux_anchors` MCP mirror)
 *   DENY:  every other src/ importer ⇒ lint exit 1. Explicitly including:
 *          - src/scanner/anchors/**  (the NON-fenced lexical half — prepare-node-text, lexical-ranker,
 *            fusion, anchor-refusal — must stay embedding-free; fusion.ts is a pure RRF over two rank
 *            lists, the CLI hands it the semantic candidates);
 *          - feature-path, trace, delta, spec-evidence, operational, and the association/overlay
 *            machinery (structural surfaces — SC-Boundary: byte-identical output with a populated or
 *            absent anchor plane).
 * Paths below omit the leading "src/" — every path this file compares is already relative to SRC
 * (see getModule/resolveTargetModule above), so the allowlist follows the same convention.
 *
 * ACCEPTED STATIC-ANALYSIS LIMITS (deliberately NOT chased — a static AST fence cannot resolve them,
 * and reaching for them would trade a clean rule for false precision):
 *   - A computed/template-literal `import()` specifier (`import(`../embeddings/${name}.js`)`) — the
 *     specifier is not a literal at lint time, so no target path is resolvable. This is itself a review
 *     red flag: a computed specifier pointing into the fenced dir has no legitimate use here and should
 *     be caught in code review, not laundered past it.
 *   - `createRequire(import.meta.url)(...)` / other runtime module loaders — dynamic loads that never
 *     appear as an ImportDeclaration, ExportDeclaration, or `import()` call expression are invisible to
 *     any AST fence. (The one legitimate createRequire in the tree, wasm-local-embedder.ts, resolves an
 *     npm package's asset dir, not a fenced src/ module.)
 * The fence covers what a static fence CAN cover soundly: static `import`, `export … from`, and
 * literal-specifier `import()`. The residue above is an accepted, documented limit.
 */
const PATH_FORBIDDEN_RULES: PathForbiddenRule[] = [
  {
    targetPrefix: 'scanner/embeddings/',
    allowedImporters: [
      'scanner/embeddings/', // internal (codec/cosine/embedder/model-cache/node-embed-pass importing each other)
      'cli/index.ts', // embed-pass tail (runNodeEmbedTail — 03 §four embed-pass integration points)
      'cli/anchor-search.ts', // the shared hybrid orchestration (runAnchorSearch)
      'cli/anchors.ts', // the `lux anchors` CLI
      'mcp/server.ts', // the `lux_anchors` MCP mirror
    ],
    label: 'anchor embeddings fence — Decision-Boundary',
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  sourceModule: string;
  targetModule: string;
  importPath: string;
  rule: 'layer-dependency' | 'forbidden-import' | 'path-forbidden';
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
 * Resolve an absolute path to its path relative to src/, POSIX-normalized (forward slashes),
 * or undefined if it falls outside src/. Shared by resolveTargetPath (target side, below) and
 * the per-file sourceRelPath computed once in analyzeFile/detectDynamicCrossModuleImports
 * (importer side) — both feed the PATH_FORBIDDEN_RULES allowlist match (Decision-Boundary).
 */
function toSrcRelativePosix(absPath: string): string | undefined {
  const rel = relative(SRC, absPath);
  if (rel.startsWith('..')) return undefined;
  return posix.normalize(rel.split('\\').join('/'));
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

/**
 * Resolve a relative import specifier to its path relative to src/, POSIX-normalized
 * (e.g. 'scanner/embeddings/cosine'), preserving the full subtree — unlike resolveTargetModule
 * (which collapses everything to the top-level module name), this lets PATH_FORBIDDEN_RULES
 * fence a directory *inside* a module (Decision-Boundary).
 */
function resolveTargetPath(importPath: string, sourceFilePath: string): string | undefined {
  if (!importPath.startsWith('.')) return undefined; // external package
  const sourceDir = dirname(sourceFilePath);
  const resolved = resolve(sourceDir, importPath);
  return toSrcRelativePosix(resolved);
}

/** Check whether an import OR export declaration has a trailing `@architecture-ignore` comment. The
 *  same escape hatch applies to `export … from` re-exports (Rule 3), so this accepts either node. */
function hasSuppression(decl: ImportDeclaration | ExportDeclaration): boolean {
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

/**
 * Evaluate PATH_FORBIDDEN_RULES for one resolved import (Decision-Boundary). Deliberately independent
 * of the module-granular same-module skip in analyzeFile/detectDynamicCrossModuleImports — this is
 * exactly the check module-granular rules cannot express (see Part 1/A above). Returns undefined
 * for a legal import (no matching rule, or importer on the allowlist).
 */
function checkPathForbidden(
  targetPath: string | undefined,
  sourceRelPath: string,
  filePath: string,
  line: number,
  importPath: string,
  suppressed: boolean,
  dynamic: boolean
): Violation | undefined {
  if (!targetPath) return undefined;
  for (const rule of PATH_FORBIDDEN_RULES) {
    if (!targetPath.startsWith(rule.targetPrefix)) continue;
    const allowed = rule.allowedImporters.some((prefix) =>
      prefix.endsWith('/') ? sourceRelPath.startsWith(prefix) : sourceRelPath === prefix
    );
    if (allowed) return undefined;
    return {
      file: relative(ROOT, filePath),
      line,
      sourceModule: sourceRelPath,
      targetModule: rule.targetPrefix,
      importPath,
      rule: 'path-forbidden',
      message: `${sourceRelPath} may not ${dynamic ? 'dynamically ' : ''}import ${rule.targetPrefix} (${rule.label})`,
      suppressed,
    };
  }
  return undefined;
}

function analyzeFile(sourceFile: SourceFile): Violation[] {
  const violations: Violation[] = [];
  const filePath = sourceFile.getFilePath();
  const sourceModule = getModule(filePath);
  if (!sourceModule || !(sourceModule in MODULE_LAYER)) return violations;

  const sourceLayer = MODULE_LAYER[sourceModule];
  // Path relative to src/, POSIX-normalized. Always defined here: every sourceFile reaching this
  // point already passed getModule()'s relative(SRC, filePath) check above, so filePath is under
  // SRC by construction — the `?? sourceModule` fallback only satisfies the type checker.
  const sourceRelPath = toSrcRelativePosix(filePath) ?? sourceModule;

  // Gather all import declarations (static imports)
  const imports = sourceFile.getImportDeclarations();

  for (const decl of imports) {
    const specifier = decl.getModuleSpecifierValue();
    const suppressed = hasSuppression(decl);
    const line = decl.getStartLineNumber();

    // Rule 3 (path-forbidden, Decision-Boundary): evaluated for EVERY import, independent of the
    // module-granular same-module skip below. This is the case module-granular rules cannot see
    // at all — e.g. scanner/anchors/*.ts or scanner/associations/*.ts importing scanner/embeddings/*.ts
    // resolves to targetModule === sourceModule === 'scanner' and would never reach Rule 1/2 below.
    const targetPath = resolveTargetPath(specifier, filePath);
    const pathViolation = checkPathForbidden(
      targetPath,
      sourceRelPath,
      filePath,
      line,
      specifier,
      suppressed,
      false
    );
    if (pathViolation) violations.push(pathViolation);

    const targetModule = resolveTargetModule(specifier, filePath);

    // Skip: external packages, same-module imports, or unknown modules
    if (!targetModule || targetModule === sourceModule || !(targetModule in MODULE_LAYER)) continue;

    const targetLayer = MODULE_LAYER[targetModule];

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

  // Rule 3 also applies to `export … from` re-exports (Decision-Boundary). getImportDeclarations()
  // does NOT see these, so without this walk a non-allowlisted module could launder the fenced
  // scanner/embeddings/ surface straight back out — `export { cosineSimilarity } from
  // '../embeddings/cosine.js'` or `export * from '../embeddings/cosine.js'` — while the fence stayed
  // green. Each export decl carrying a module specifier is resolved and matched through the SAME
  // checkPathForbidden path as an import; a bare local `export { x }` (no `from`) has no specifier and
  // is skipped. Only the path-forbidden fence is evaluated here — the layer/forbidden-pair rules
  // already fire on the corresponding value imports, and a re-export is a strictly narrower surface.
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const specifier = exportDecl.getModuleSpecifierValue();
    if (!specifier) continue; // local export (no `from`) — no re-export target to fence
    const suppressed = hasSuppression(exportDecl);
    const line = exportDecl.getStartLineNumber();
    const targetPath = resolveTargetPath(specifier, filePath);
    const pathViolation = checkPathForbidden(
      targetPath,
      sourceRelPath,
      filePath,
      line,
      specifier,
      suppressed,
      false
    );
    if (pathViolation) violations.push(pathViolation);
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

  const sourceRelPath = toSrcRelativePosix(filePath) ?? sourceModule;

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
    const line = call.getStartLineNumber();

    // Check full text of the statement for suppression comment
    const parent = call.getParent();
    const fullText = parent ? parent.getFullText() : call.getFullText();
    const suppressed = fullText.includes('@architecture-ignore');

    // Rule 3 (path-forbidden, Decision-Boundary): evaluated for EVERY dynamic import, independent of
    // the module-granular same-module skip below — same reasoning as analyzeFile (Part 1/B6).
    const targetPath = resolveTargetPath(specifier, filePath);
    const pathViolation = checkPathForbidden(
      targetPath,
      sourceRelPath,
      filePath,
      line,
      specifier,
      suppressed,
      true
    );
    if (pathViolation) violations.push(pathViolation);

    const targetModule = resolveTargetModule(specifier, filePath);
    if (!targetModule || targetModule === sourceModule || !(targetModule in MODULE_LAYER)) continue;

    const targetLayer = MODULE_LAYER[targetModule];
    const sourceLayer = MODULE_LAYER[sourceModule];

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
// Exports (testability) — scripts/test-architecture.ts imports these directly so the fence
// tests exercise the real rule, not a re-derived copy. The CLI entry point below still runs
// standalone, unaffected (see the main-guard at the bottom of this file).
// ---------------------------------------------------------------------------

export { analyzeFile, detectDynamicCrossModuleImports, PATH_FORBIDDEN_RULES };
export type { Violation };

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
          (suppressed.length > 0 ? ` (${suppressed.length} suppressed)` : '')
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
          (suppressed.length > 0
            ? ` (${suppressed.length} suppressed with @architecture-ignore)`
            : '')
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

// Runs main() only when this file is the process entry point (npx tsx scripts/lint-architecture.ts),
// not when imported — so scripts/test-architecture.ts can import analyzeFile/
// detectDynamicCrossModuleImports (B8) without triggering process.exit() as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
