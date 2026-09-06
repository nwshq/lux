import { posix } from 'node:path';
import type { ModuleResolutionResultV1, ProjectResolutionContextV1 } from '../contracts/program.js';
import { resolveExport, type ExportResolutionV1 } from './export-index.js';
import type { ModuleResolutionRequestV1 } from './types.js';
import { existingCandidates, normalizeRepositoryPath } from './candidates.js';

export interface LocalBindingResolutionV1 {
  module: ModuleResolutionResultV1;
  exported?: ExportResolutionV1;
}

/**
 * Resolve the Phase 7 module surface. Non-local specifiers are deliberately
 * classified as external here; Phase 8 may resolve them before this fallback.
 */
export function resolveModule(
  request: ModuleResolutionRequestV1,
  context: Pick<ProjectResolutionContextV1, 'sourceFiles'>
): ModuleResolutionResultV1 {
  return (
    resolveLocalModule(request, context.sourceFiles) ?? {
      status: 'external',
      specifier: request.specifier,
    }
  );
}

/**
 * Resolve a module and, when requested, its exported declaration through the
 * canonical export indexes. A non-resolved module never enters export lookup.
 */
export function resolveLocalBinding(
  request: ModuleResolutionRequestV1,
  context: Pick<ProjectResolutionContextV1, 'sourceFiles' | 'exportsByFile'>
): LocalBindingResolutionV1 {
  const module = resolveModule(request, context);
  if (module.status !== 'resolved' || request.importedName === undefined) return { module };

  return {
    module,
    exported: resolveExport(
      module.targetFile,
      request.importedName,
      context.exportsByFile,
      (fromFile, specifier) => {
        const nested = resolveModule(
          { importerFile: fromFile, specifier, mode: 'reexport' },
          context
        );
        return nested.status === 'resolved' ? nested.targetFile : undefined;
      }
    ),
  };
}

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
