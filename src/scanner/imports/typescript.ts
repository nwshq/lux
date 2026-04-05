import type { ImportStatement } from './types.js';

/**
 * Parse JavaScript/TypeScript import statements from file content.
 *
 * Handles:
 * - `import ... from 'path';`
 * - `import 'path';` (side-effect)
 * - `import type ... from 'path';`
 * - `export ... from 'path';` (re-exports)
 * - `require('path')`
 * - Dynamic `import('path')`
 *
 * Ignores:
 * - Bare specifiers resolving to node_modules (no `.` or `/` prefix)
 * - Comments
 */
export function parseTsImports(content: string): ImportStatement[] {
  const results: ImportStatement[] = [];

  // Strip comments before parsing
  const stripped = stripComments(content);

  // Match ESM imports: import [type] [default, {named}] from 'path'
  const esmFromRegex =
    /\bimport\s+(?:type\s+)?(?:(?:\{[^}]*\}|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = esmFromRegex.exec(stripped)) !== null) {
    const importPath = match[1];
    if (isExternalPackage(importPath)) continue;

    const symbols = extractImportSymbols(match[0]);
    results.push({
      rawImport: importPath,
      resolvedModule: null,
      symbols,
    });
  }

  // Match re-exports: export { ... } from 'path' or export * from 'path'
  const reExportRegex = /\bexport\s+(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = reExportRegex.exec(stripped)) !== null) {
    const importPath = match[1];
    if (isExternalPackage(importPath)) continue;

    results.push({
      rawImport: importPath,
      resolvedModule: null,
      symbols: ['*'],
    });
  }

  // Match require('path')
  const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(stripped)) !== null) {
    const importPath = match[1];
    if (isExternalPackage(importPath)) continue;

    results.push({
      rawImport: importPath,
      resolvedModule: null,
      symbols: [],
    });
  }

  // Match dynamic import('path')
  const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(stripped)) !== null) {
    const importPath = match[1];
    if (isExternalPackage(importPath)) continue;

    // Skip if this path was already captured by ESM regex
    if (results.some((r) => r.rawImport === importPath)) continue;

    results.push({
      rawImport: importPath,
      resolvedModule: null,
      symbols: [],
    });
  }

  return results;
}

/**
 * Determine if an import path refers to an external package (node_modules).
 * External packages don't start with `.`, `/`, or `#`.
 */
function isExternalPackage(importPath: string): boolean {
  return !importPath.startsWith('.') && !importPath.startsWith('/') && !importPath.startsWith('#');
}

/** Extract named import symbols from an import statement string. */
function extractImportSymbols(importStr: string): string[] {
  const symbols: string[] = [];

  // Extract default import
  const defaultMatch = importStr.match(/import\s+(?:type\s+)?(\w+)\s*(?:,|\s+from)/);
  if (defaultMatch && defaultMatch[1] !== 'type') {
    symbols.push(defaultMatch[1]);
  }

  // Extract named imports
  const namedMatch = importStr.match(/\{([^}]+)\}/);
  if (namedMatch) {
    const names = namedMatch[1].split(',').map((s) => {
      const trimmed = s.trim();
      // Handle `name as alias`
      const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
      return asMatch ? asMatch[1] : trimmed;
    });
    symbols.push(...names.filter((n) => n.length > 0 && n !== 'type'));
  }

  // Side-effect import — no symbols
  return symbols;
}

/** Strip single-line (//) and multi-line comments from source. */
function stripComments(content: string): string {
  // Remove multi-line comments
  let result = content.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove single-line comments (but not inside strings — simple heuristic)
  result = result.replace(/\/\/.*$/gm, '');
  return result;
}
