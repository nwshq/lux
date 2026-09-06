import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { AliasRuleV1, SourceDiagnosticV1 } from '../contracts/program.js';
import { existingCandidates, normalizeRepositoryPath } from './candidates.js';
import {
  canonicalizeConfigRoots,
  parseJsoncConfig,
  readConfinedConfigFile,
  type ConfinedRootsV1,
} from './config-discovery.js';

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;

export interface TsconfigAliasResultV1 {
  rules: AliasRuleV1[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}

interface PathsDeclarationV1 {
  configFile: string;
  source: 'tsconfig' | 'jsconfig';
  baseUrl: string;
  paths: Record<string, unknown>;
}

function diagnostic(code: string, message: string, filePath: string): SourceDiagnosticV1 {
  return { code, message, location: { filePath, line: 1, column: 0 } };
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  );
}

function configKind(filePath: string): 'tsconfig' | 'jsconfig' {
  return filePath.endsWith('/jsconfig.json') || filePath.endsWith('\\jsconfig.json')
    ? 'jsconfig'
    : 'tsconfig';
}

function relativeRepositoryPath(rootPath: string, absolutePath: string): string | undefined {
  const item = relative(rootPath, absolutePath).replaceAll('\\', '/');
  return normalizeRepositoryPath(item) ?? undefined;
}

function literalExtends(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    !hasControlCharacter(value) &&
    !URI_SCHEME.test(value) &&
    !isAbsolute(value) &&
    (value.startsWith('./') || value.startsWith('../'))
    ? value
    : undefined;
}

function oneStar(value: string): boolean {
  return (value.match(/\*/gu) ?? []).length <= 1;
}

function sourceMatchesTemplate(sourceFile: string, template: string): boolean {
  const star = template.indexOf('*');
  if (star < 0) return sourceFile === template;
  return (
    sourceFile.startsWith(template.slice(0, star)) && sourceFile.endsWith(template.slice(star + 1))
  );
}

function templateCandidateExists(template: string, sourceFiles: ReadonlySet<string>): boolean {
  if (template.includes('*'))
    return [...sourceFiles].some((file) => sourceMatchesTemplate(file, template));
  return existingCandidates([template], sourceFiles).length > 0;
}

async function collectDeclarations(
  configFile: string,
  roots: ConfinedRootsV1,
  dependencies: Set<string>,
  diagnostics: SourceDiagnosticV1[],
  visiting: Set<string>,
  completed: Set<string>,
  declarations: PathsDeclarationV1[]
): Promise<void> {
  const read = await readConfinedConfigFile(configFile, roots);
  if (!read) {
    diagnostics.push(
      diagnostic(
        'tsconfig-path-escape',
        'Config is unreadable, symlinked, or outside the allowed root.',
        configFile
      )
    );
    return;
  }
  dependencies.add(read.filePath);
  if (completed.has(read.filePath)) return;
  if (visiting.has(read.filePath)) {
    diagnostics.push(
      diagnostic('tsconfig-extends-cycle', 'Config extends cycle was refused.', read.filePath)
    );
    return;
  }
  visiting.add(read.filePath);

  const parsed = parseJsoncConfig(read.filePath, read.source);
  diagnostics.push(...parsed.diagnostics);
  if (!parsed.value) {
    visiting.delete(read.filePath);
    completed.add(read.filePath);
    return;
  }

  if (parsed.value.extends !== undefined) {
    const specifier = literalExtends(parsed.value.extends);
    if (!specifier) {
      diagnostics.push(
        diagnostic(
          'tsconfig-extends-external',
          'Only a literal relative, root-confined extends path is supported.',
          read.filePath
        )
      );
    } else {
      let extended = resolve(read.filePath, '..', specifier);
      if (!extended.endsWith('.json')) extended += '.json';
      if (!isWithin(roots.rootPath, extended)) {
        diagnostics.push(
          diagnostic(
            'tsconfig-extends-external',
            'Root-escaping config extends was refused.',
            read.filePath
          )
        );
      } else {
        await collectDeclarations(
          extended,
          roots,
          dependencies,
          diagnostics,
          visiting,
          completed,
          declarations
        );
      }
    }
  }

  const compiler = parsed.value.compilerOptions;
  if (compiler && typeof compiler === 'object' && !Array.isArray(compiler)) {
    const options = compiler as Record<string, unknown>;
    if (options.paths !== undefined) {
      if (!options.paths || typeof options.paths !== 'object' || Array.isArray(options.paths)) {
        diagnostics.push(
          diagnostic(
            'tsconfig-paths-shape',
            'compilerOptions.paths must be an object.',
            read.filePath
          )
        );
      } else {
        const rawBaseUrl = options.baseUrl === undefined ? '.' : options.baseUrl;
        if (
          typeof rawBaseUrl !== 'string' ||
          rawBaseUrl.length === 0 ||
          hasControlCharacter(rawBaseUrl) ||
          URI_SCHEME.test(rawBaseUrl) ||
          isAbsolute(rawBaseUrl)
        ) {
          diagnostics.push(
            diagnostic(
              'tsconfig-baseurl-invalid',
              'baseUrl must be a confined relative path.',
              read.filePath
            )
          );
        } else {
          const baseUrl = resolve(read.filePath, '..', rawBaseUrl);
          if (!isWithin(roots.rootPath, baseUrl)) {
            diagnostics.push(
              diagnostic(
                'tsconfig-baseurl-escape',
                'baseUrl escapes the project root.',
                read.filePath
              )
            );
          } else {
            declarations.push({
              configFile: read.filePath,
              source: configKind(read.filePath),
              baseUrl,
              paths: options.paths as Record<string, unknown>,
            });
          }
        }
      }
    }
  }

  visiting.delete(read.filePath);
  completed.add(read.filePath);
}

function rulesForDeclaration(
  declaration: PathsDeclarationV1,
  rootPath: string,
  sourceFiles: ReadonlySet<string>,
  diagnostics: SourceDiagnosticV1[]
): AliasRuleV1[] {
  const rules: AliasRuleV1[] = [];
  for (const [pattern, rawTargets] of Object.entries(declaration.paths).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (
      pattern.length === 0 ||
      hasControlCharacter(pattern) ||
      pattern.startsWith('.') ||
      pattern.startsWith('/') ||
      !oneStar(pattern)
    ) {
      diagnostics.push(
        diagnostic(
          'tsconfig-alias-pattern-invalid',
          `Unsupported alias pattern ${JSON.stringify(pattern)}.`,
          declaration.configFile
        )
      );
      continue;
    }
    if (
      !Array.isArray(rawTargets) ||
      rawTargets.length === 0 ||
      rawTargets.some((item) => typeof item !== 'string')
    ) {
      diagnostics.push(
        diagnostic(
          'tsconfig-alias-target-invalid',
          `Alias ${JSON.stringify(pattern)} must have literal string targets.`,
          declaration.configFile
        )
      );
      continue;
    }

    const patternHasStar = pattern.includes('*');
    const targets: string[] = [];
    for (const rawTarget of rawTargets as string[]) {
      if (
        rawTarget.length === 0 ||
        hasControlCharacter(rawTarget) ||
        URI_SCHEME.test(rawTarget) ||
        isAbsolute(rawTarget) ||
        !oneStar(rawTarget) ||
        rawTarget.includes('*') !== patternHasStar
      ) {
        diagnostics.push(
          diagnostic(
            'tsconfig-alias-target-invalid',
            `Unsupported target ${JSON.stringify(rawTarget)} for ${JSON.stringify(pattern)}.`,
            declaration.configFile
          )
        );
        continue;
      }
      const absoluteTarget = resolve(declaration.baseUrl, rawTarget);
      if (!isWithin(rootPath, absoluteTarget)) {
        diagnostics.push(
          diagnostic(
            'tsconfig-alias-target-escape',
            `Alias target ${JSON.stringify(rawTarget)} escapes the project root.`,
            declaration.configFile
          )
        );
        continue;
      }
      const repositoryTarget = relativeRepositoryPath(rootPath, absoluteTarget);
      if (!repositoryTarget || !templateCandidateExists(repositoryTarget, sourceFiles)) {
        diagnostics.push(
          diagnostic(
            'tsconfig-alias-target-missing',
            `Alias target ${JSON.stringify(rawTarget)} has no scanned source candidate.`,
            declaration.configFile
          )
        );
        continue;
      }
      if (patternHasStar) {
        targets.push(repositoryTarget);
      } else {
        targets.push(...existingCandidates([repositoryTarget], sourceFiles));
      }
    }
    const uniqueTargets = [...new Set(targets)].sort();
    if (uniqueTargets.length === 0) continue;

    // Exact aliases always win. Wildcards rank by longest literal prefix; suffix length is a
    // deterministic tie-breaker without changing the frozen semantic rank.
    const star = pattern.indexOf('*');
    const precedence = star < 0 ? 0 : 10_000 - star * 100 - (pattern.length - star - 1);
    rules.push({
      pattern,
      targets: uniqueTargets,
      source: declaration.source,
      configFile: declaration.configFile,
      precedence,
    });
    if (uniqueTargets.length > 1 && !patternHasStar) {
      diagnostics.push(
        diagnostic(
          'tsconfig-alias-ambiguous',
          `Alias ${JSON.stringify(pattern)} has multiple existing targets at the winning rank.`,
          declaration.configFile
        )
      );
    }
  }
  return rules;
}

/** Parse JSONC path aliases and their root-confined literal extends chains. */
export async function parseTsconfigAliases(
  configFiles: readonly string[],
  rootPath: string,
  allowedRoots: readonly string[],
  sourceFiles: ReadonlySet<string>
): Promise<TsconfigAliasResultV1> {
  const roots = await canonicalizeConfigRoots(rootPath, allowedRoots);
  if (!roots) {
    return {
      rules: [],
      dependencies: [],
      diagnostics: [
        diagnostic('tsconfig-root-invalid', 'Config root or allowed roots are invalid.', rootPath),
      ],
    };
  }

  const dependencies = new Set<string>();
  const diagnostics: SourceDiagnosticV1[] = [];
  const declarations: PathsDeclarationV1[] = [];
  const completed = new Set<string>();
  for (const configFile of [...new Set(configFiles)].sort()) {
    await collectDeclarations(
      configFile,
      roots,
      dependencies,
      diagnostics,
      new Set(),
      completed,
      declarations
    );
  }

  const rules = declarations.flatMap((declaration) =>
    rulesForDeclaration(declaration, roots.rootPath, sourceFiles, diagnostics)
  );
  // A child declaration replaces an inherited alias with the same pattern. Configuration input is
  // sorted, and declaration order is parent-before-child, making this stable.
  const byPattern = new Map<string, AliasRuleV1>();
  for (const rule of rules) byPattern.set(rule.pattern, rule);
  return {
    rules: [...byPattern.values()].sort(
      (a, b) => a.precedence - b.precedence || a.pattern.localeCompare(b.pattern)
    ),
    dependencies: [...dependencies].sort(),
    diagnostics,
  };
}
