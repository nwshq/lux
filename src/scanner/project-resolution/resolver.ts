import { posix } from 'node:path';

import type {
  AliasRuleV1,
  ModuleResolutionResultV1,
  ProjectResolutionContextV1,
} from '../contracts/program.js';
import { existingCandidates, normalizeRepositoryPath } from './candidates.js';
import { resolveExport, type ExportResolutionV1 } from './export-index.js';
import { resolveLocalModule } from './local-resolver.js';
import { resolvePackageExport } from './package-exports.js';
import type { ModuleResolutionRequestV1 } from './types.js';

export interface ProjectBindingResolutionV1 {
  module: ModuleResolutionResultV1;
  exported?: ExportResolutionV1;
}

/** Resolve a module and, when requested, its exported declaration through the shared index. */
export function resolveProjectBinding(
  request: ModuleResolutionRequestV1,
  context: ProjectResolutionContextV1
): ProjectBindingResolutionV1 {
  const module = resolveProjectModule(request, context);
  if (module.status !== 'resolved' || request.importedName === undefined) return { module };
  return {
    module,
    exported: resolveExport(
      module.targetFile,
      request.importedName,
      context.exportsByFile,
      (fromFile, specifier) => {
        const nested = resolveProjectModule(
          { importerFile: fromFile, specifier, mode: 'reexport' },
          context
        );
        return nested.status === 'resolved' ? nested.targetFile : undefined;
      }
    ),
  };
}

/**
 * Resolve only existing scanned first-party targets. The first matching rank is final, including a
 * missing/ambiguous result: lower-precedence aliases or packages never hide a governing refusal.
 */
export function resolveProjectModule(
  request: ModuleResolutionRequestV1,
  context: ProjectResolutionContextV1
): ModuleResolutionResultV1 {
  const local = resolveLocalModule(request, context.sourceFiles);
  if (local) return local;

  const alias = resolveAlias(
    request.importerFile,
    request.specifier,
    context.aliases,
    context.sourceFiles
  );
  if (alias) return alias;

  const workspace = resolvePackageExport(
    request.specifier,
    context.workspacePackages,
    context.sourceFiles
  );
  if (workspace) return workspace;

  return { status: 'external', specifier: request.specifier };
}

function resolveAlias(
  importerFile: string,
  specifier: string,
  aliases: readonly AliasRuleV1[],
  sourceFiles: ReadonlySet<string>
): ModuleResolutionResultV1 | undefined {
  const matched = aliases
    .map((rule, declarationOrder) => ({
      rule,
      declarationOrder,
      capture: matchRule(rule.pattern, specifier, rule.source),
    }))
    .filter((item): item is typeof item & { capture: string } => item.capture !== null);
  if (matched.length === 0) return undefined;

  const nearest = nearestConfigMatches(matched, importerFile);
  const bestSourceRank = Math.min(...nearest.map(({ rule }) => aliasSourceRank(rule.source)));
  const atSourceRank = nearest.filter(
    ({ rule }) => aliasSourceRank(rule.source) === bestSourceRank
  );
  const exact = atSourceRank.filter(({ rule }) => !rule.pattern.includes('*'));
  const shapeRank = exact.length > 0 ? exact : longestPrefixWinners(atSourceRank);
  const bestPrecedence = Math.min(...shapeRank.map(({ rule }) => rule.precedence));
  const winners = shapeRank.filter(({ rule }) => rule.precedence === bestPrecedence);

  const candidates = [
    ...new Set(
      winners.flatMap(({ rule, capture }) =>
        existingCandidates(
          rule.targets.map((target) => substituteTarget(target, capture, specifier, rule.pattern)),
          sourceFiles
        )
      )
    ),
  ].sort();
  const governingConfigs = [...new Set(winners.map(({ rule }) => rule.configFile))].sort();

  if (candidates.length > 1 || governingConfigs.length > 1) {
    return { status: 'ambiguous', candidates, governingConfigs };
  }
  if (candidates.length === 0) return { status: 'missing', specifier };

  const winner = winners[0].rule;
  return {
    status: 'resolved',
    targetFile: candidates[0],
    via: winner.source,
    evidenceFile: winner.configFile,
  };
}

function aliasSourceRank(source: AliasRuleV1['source']): number {
  if (source === 'tsconfig' || source === 'jsconfig') return 0;
  if (source === 'vite') return 1;
  return 2;
}

function nearestConfigMatches<T extends { rule: AliasRuleV1 }>(
  matches: T[],
  importerFile: string
): T[] {
  const projectRules = matches.filter(
    ({ rule }) => rule.source === 'tsconfig' || rule.source === 'jsconfig'
  );
  if (projectRules.length === 0) return matches;
  const importerDirectory = posix.dirname(normalizeRepositoryPath(importerFile) ?? importerFile);
  const distances = projectRules.map(({ rule }) =>
    ancestorDistance(importerDirectory, posix.dirname(rule.configFile))
  );
  const finite = distances.filter((distance): distance is number => distance !== null);
  if (finite.length === 0) return matches.filter(({ rule }) => rule.source === 'vite');
  const nearest = Math.min(...finite);
  return projectRules.filter(
    ({ rule }) => ancestorDistance(importerDirectory, posix.dirname(rule.configFile)) === nearest
  );
}

function ancestorDistance(importerDirectory: string, configDirectory: string): number | null {
  const normalized = normalizeRepositoryPath(configDirectory);
  const ancestor = normalized === null ? configDirectory : normalized;
  if (ancestor === '.') return importerDirectory === '.' ? 0 : importerDirectory.split('/').length;
  if (importerDirectory !== ancestor && !importerDirectory.startsWith(`${ancestor}/`)) return null;
  if (importerDirectory === ancestor) return 0;
  return importerDirectory.slice(ancestor.length + 1).split('/').length;
}

function matchRule(
  pattern: string,
  specifier: string,
  source: AliasRuleV1['source']
): string | null {
  const star = pattern.indexOf('*');
  if (star < 0) {
    if (specifier === pattern) return '';
    // Vite string aliases replace matching path prefixes; ts/jsconfig exact rules do not.
    return source === 'vite' && specifier.startsWith(`${pattern}/`)
      ? specifier.slice(pattern.length)
      : null;
  }
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  const end = specifier.length - suffix.length;
  if (end < prefix.length) return null;
  return specifier.slice(prefix.length, end);
}

function longestPrefixWinners<T extends { rule: AliasRuleV1 }>(matches: T[]): T[] {
  const rank = Math.max(
    ...matches.map(({ rule }) => {
      const star = rule.pattern.indexOf('*');
      return star < 0 ? rule.pattern.length : star;
    })
  );
  return matches.filter(({ rule }) => {
    const star = rule.pattern.indexOf('*');
    return (star < 0 ? rule.pattern.length : star) === rank;
  });
}

function substituteTarget(
  target: string,
  capture: string,
  specifier: string,
  pattern: string
): string {
  if (target.includes('*')) return target.replace('*', capture);
  if (pattern.includes('*')) return target;
  if (specifier === pattern) return target;
  const suffix = capture.startsWith('/') ? capture.slice(1) : capture;
  return normalizeRepositoryPath(posix.join(target, suffix)) ?? target;
}
