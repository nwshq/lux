import { extname, posix } from 'node:path';

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'] as const;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function normalizeRepositoryPath(path: string): string | null {
  if (hasControlCharacter(path)) return null;
  const normalized = posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//u, '');
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/'))
    return null;
  return normalized;
}

export function sourceCandidates(base: string): string[] {
  const normalized = normalizeRepositoryPath(base);
  if (!normalized) return [];
  const extension = extname(normalized).toLowerCase();
  if (SOURCE_EXTENSIONS.includes(extension as (typeof SOURCE_EXTENSIONS)[number])) {
    return [normalized];
  }
  const direct = SOURCE_EXTENSIONS.map((item) => `${normalized}${item}`);
  const indexes = SOURCE_EXTENSIONS.map((item) => `${normalized}/index${item}`);
  return [...direct, ...indexes];
}

export function existingCandidates(
  bases: readonly string[],
  sourceFiles: ReadonlySet<string>
): string[] {
  return [
    ...new Set(bases.flatMap(sourceCandidates).filter((file) => sourceFiles.has(file))),
  ].sort();
}
