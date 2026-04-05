import type { ImportStatement } from './types.js';

/**
 * Parse PHP `use` statements from file content.
 *
 * Handles:
 * - `use Namespace\Module\Class;`
 * - `use Namespace\Module\{ClassA, ClassB};` (grouped)
 * - `use function Namespace\func;`
 * - `use const Namespace\CONST;`
 *
 * Ignores:
 * - `use` inside closures: `function() use ($var)`
 * - Comments (single-line and multi-line)
 */
export function parsePhpImports(content: string): ImportStatement[] {
  const results: ImportStatement[] = [];
  const lines = content.split('\n');
  let inBlockComment = false;

  for (const line of lines) {
    let trimmed = line.trim();

    // Handle block comments
    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        inBlockComment = false;
        trimmed = trimmed.slice(trimmed.indexOf('*/') + 2).trim();
      } else {
        continue;
      }
    }

    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) {
        inBlockComment = true;
        continue;
      }
      trimmed = trimmed.slice(trimmed.indexOf('*/') + 2).trim();
    }

    // Skip single-line comments
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
      continue;
    }

    // Skip closure use: `function(...) use (...)`
    if (/\)\s*use\s*\(/.test(trimmed)) {
      continue;
    }

    // Match `use [function|const] Namespace\...\{A, B};` (grouped)
    const groupedMatch = trimmed.match(
      /^use\s+(?:function\s+|const\s+)?([A-Za-z0-9_\\]+)\\\{([^}]+)\}\s*;/
    );
    if (groupedMatch) {
      const baseNamespace = groupedMatch[1];
      const symbols = groupedMatch[2]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const symbol of symbols) {
        results.push({
          rawImport: `${baseNamespace}\\${symbol}`,
          resolvedModule: null,
          symbols: [symbol],
        });
      }
      continue;
    }

    // Match `use [function|const] Namespace\Module\Class;`
    const simpleMatch = trimmed.match(/^use\s+(?:function\s+|const\s+)?([A-Za-z0-9_\\]+)\s*;/);
    if (simpleMatch) {
      const rawImport = simpleMatch[1];
      const parts = rawImport.split('\\');
      const symbol = parts[parts.length - 1];

      results.push({
        rawImport,
        resolvedModule: null,
        symbols: [symbol],
      });
    }
  }

  return results;
}
