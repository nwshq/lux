import type { ImportStatement } from './types.js';
import { parsePhpImports } from './php.js';
import { parseTsImports } from './typescript.js';

export type { ImportStatement, ModuleBoundaryConfig, ParsedModuleImports } from './types.js';

/** Parser function signature. */
type ImportParser = (content: string, options?: { includeExternal?: boolean }) => ImportStatement[];

/** Registry mapping language IDs to parser functions. */
const PARSER_REGISTRY: Record<string, ImportParser> = {
  php: parsePhpImports,
  typescript: parseTsImports,
  javascript: parseTsImports,
};

/**
 * Parse imports from file content using the appropriate language parser.
 *
 * @param content - Source file content.
 * @param language - Language identifier (e.g., 'php', 'typescript', 'javascript').
 * @returns Array of parsed import statements, or empty if language is unsupported.
 */
export function parseImports(
  content: string,
  language: string,
  options?: { includeExternal?: boolean }
): ImportStatement[] {
  const parser = PARSER_REGISTRY[language];
  if (!parser) return [];
  return parser(content, options);
}
