import { posix } from 'node:path';
import type { ModuleResolutionResultV1 } from '../contracts/program.js';
import type { ModuleResolutionRequestV1 } from './types.js';
import { existingCandidates, normalizeRepositoryPath } from './candidates.js';

export function resolveLocalModule(
  request: ModuleResolutionRequestV1,
  sourceFiles: ReadonlySet<string>
): ModuleResolutionResultV1 | undefined {
  if (!request.specifier.startsWith('.') && !request.specifier.startsWith('/')) return undefined;

  const importer = normalizeRepositoryPath(request.importerFile);
  if (!importer) return { status: 'missing', specifier: request.specifier };
  const importerDir = posix.dirname(importer);
  const rawBase = request.specifier.startsWith('/')
    ? request.specifier.slice(1)
    : posix.join(importerDir, request.specifier);
  const base = normalizeRepositoryPath(rawBase);
  if (!base) return { status: 'missing', specifier: request.specifier };

  const exact = sourceFiles.has(base) ? [base] : [];
  if (exact.length === 1) return { status: 'resolved', targetFile: exact[0], via: 'relative' };

  const emittedSuffix = base.match(/\.(?:mjs|cjs|js|jsx)$/u);
  const candidateBase = emittedSuffix ? base.slice(0, -emittedSuffix[0].length) : base;
  const candidates = existingCandidates([candidateBase], sourceFiles);
  if (candidates.length === 1) {
    return { status: 'resolved', targetFile: candidates[0], via: 'relative' };
  }
  if (candidates.length > 1) {
    return { status: 'ambiguous', candidates, governingConfigs: [] };
  }
  return { status: 'missing', specifier: request.specifier };
}
