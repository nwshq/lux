import { posix } from 'node:path';

import type {
  AliasRuleV1,
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../../../contracts/program.js';
import { resolveProjectModule } from '../../../project-resolution/resolver.js';
import { normalizeRepositoryPath } from '../../../project-resolution/candidates.js';
import { vueComponentId } from '../../../identity/program-identity.js';

export interface InertiaFrameworkConfigV1 {
  pageRoots?: readonly string[];
  namespaces?: Readonly<Record<string, readonly string[]>>;
  /** Config source used as bridge provenance and cache/fingerprint input. */
  sourceFile?: string;
}

export interface InertiaPageRegistryInputV1 {
  project: ProjectResolutionContextV1;
  /** Static source text only. No module or resolver code is evaluated. */
  sources?: readonly { filePath: string; content: string }[];
  config?: InertiaFrameworkConfigV1;
  onDiagnostic?: (diagnostic: SourceDiagnosticV1) => void;
}

export interface InertiaPageRegistrationV1 {
  pageName: string;
  componentFile: string;
  componentId: string;
  evidenceLocations: SourceLocationV1[];
}

export interface InertiaPageRegistryV1 {
  resolve(pageName: string): InertiaPageRegistrationV1 | undefined;
  registrations: readonly InertiaPageRegistrationV1[];
  dependencies: readonly string[];
}

interface RootEvidence {
  root: string;
  namespace?: string;
  declaration: SourceLocationV1;
  resolutionEvidence?: string;
}

interface StaticGlob {
  binding?: string;
  root: RootEvidence;
}

const STATIC_GLOB =
  /(?:\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?import\.meta\.glob\s*\(\s*(['"])([^'"\r\n]+)\2\s*(?:,\s*\{[^)]*\})?\)/gu;
const EXPLICIT_IMPORT =
  /\bimport\s+(?:[A-Za-z_$][\w$]*|\{[^}]+\})\s+from\s+(['"])([^'"\r\n]+\.vue)\1/gu;

/** Build the exact, existence-checked page registry from configuration and static JS facts. */
export function buildInertiaPageRegistry(input: InertiaPageRegistryInputV1): InertiaPageRegistryV1 {
  const dependencies = new Set<string>();
  const roots: RootEvidence[] = [];
  const explicit = new Map<string, RootEvidence[]>();
  const globsByBinding = new Map<string, RootEvidence>();
  const namespaceBindings = new Map<string, string>();

  addConfiguredRoots(input, roots, dependencies);
  for (const source of input.sources ?? []) {
    dependencies.add(source.filePath);
    collectExplicitImports(input, source, explicit);
    const globs = collectStaticGlobs(input, source);
    for (const glob of globs) {
      roots.push(glob.root);
      if (glob.binding) globsByBinding.set(glob.binding, glob.root);
    }
    collectStaticNamespaceMaps(source, globsByBinding, namespaceBindings);
  }

  const allRoots = [
    ...roots,
    ...[...namespaceBindings].flatMap(([namespace, binding]) => {
      const root = globsByBinding.get(binding);
      return root ? [{ ...root, namespace: normalizeNamespace(namespace) }] : [];
    }),
  ];

  const registrations = materializeRegistrations(
    input.project.sourceFiles,
    allRoots,
    explicit,
    input.config?.sourceFile
  );
  const byPage = new Map<string, InertiaPageRegistrationV1[]>();
  for (const registration of registrations) {
    const list = byPage.get(registration.pageName) ?? [];
    list.push(registration);
    byPage.set(registration.pageName, list);
  }

  return {
    registrations,
    dependencies: [...dependencies].sort(),
    resolve(pageName) {
      if (!isSafePageName(pageName)) return undefined;
      const candidates = byPage.get(canonicalPageName(pageName)) ?? [];
      return candidates.length === 1 ? candidates[0] : undefined;
    },
  };
}

function addConfiguredRoots(
  input: InertiaPageRegistryInputV1,
  roots: RootEvidence[],
  dependencies: Set<string>
): void {
  const sourceFile = input.config?.sourceFile ?? 'lux.yaml';
  if (input.config && input.config.sourceFile) dependencies.add(input.config.sourceFile);
  for (const configured of input.config?.pageRoots ?? []) {
    const root = confinedRoot(configured);
    if (!root) {
      input.onDiagnostic?.({
        code: 'inertia-page-root-invalid',
        message: `Configured Inertia page root is not repository-confined: ${configured}`,
        location: { filePath: sourceFile, line: 1, column: 0 },
      });
      continue;
    }
    roots.push({ root, declaration: { filePath: sourceFile, line: 1, column: 0 } });
  }
  for (const [rawNamespace, configuredRoots] of Object.entries(input.config?.namespaces ?? {})) {
    const namespace = normalizeNamespace(rawNamespace);
    for (const configured of configuredRoots) {
      const root = confinedRoot(configured);
      if (!root || !namespace) continue;
      roots.push({
        root,
        namespace,
        declaration: { filePath: sourceFile, line: 1, column: 0 },
      });
    }
  }
}

function collectExplicitImports(
  input: InertiaPageRegistryInputV1,
  source: { filePath: string; content: string },
  explicit: Map<string, RootEvidence[]>
): void {
  let match: RegExpExecArray | null;
  STATIC_RESET(EXPLICIT_IMPORT);
  while ((match = EXPLICIT_IMPORT.exec(source.content)) !== null) {
    const resolution = resolveProjectModule(
      { importerFile: source.filePath, specifier: match[2], mode: 'import' },
      input.project
    );
    if (resolution.status !== 'resolved' || !resolution.targetFile.endsWith('.vue')) continue;
    const page = posix.basename(resolution.targetFile, '.vue');
    const evidence: RootEvidence = {
      root: resolution.targetFile,
      declaration: locationAt(source, match.index),
      resolutionEvidence: resolution.evidenceFile,
    };
    const list = explicit.get(page) ?? [];
    list.push(evidence);
    explicit.set(page, list);
  }
}

function collectStaticGlobs(
  input: InertiaPageRegistryInputV1,
  source: { filePath: string; content: string }
): StaticGlob[] {
  const globs: StaticGlob[] = [];
  let match: RegExpExecArray | null;
  STATIC_RESET(STATIC_GLOB);
  while ((match = STATIC_GLOB.exec(source.content)) !== null) {
    const pattern = match[3];
    if (!pattern.endsWith('/**/*.vue') && !pattern.endsWith('/*.vue')) continue;
    const prefix = pattern.replace(/\/\*\*\/\*\.vue$/u, '').replace(/\/\*\.vue$/u, '');
    const resolution = resolveGlobRoot(source.filePath, prefix, input.project);
    if (!resolution) continue;
    const propertyPrefix = source.content.slice(Math.max(0, match.index - 80), match.index);
    const propertyBinding = /([A-Za-z_$][\w$]*)\s*:\s*$/u.exec(propertyPrefix)?.[1];
    globs.push({
      binding: match[1] ?? propertyBinding,
      root: {
        root: resolution.root,
        declaration: locationAt(source, match.index),
        resolutionEvidence: resolution.evidenceFile,
      },
    });
  }
  return globs;
}

function resolveGlobRoot(
  importerFile: string,
  prefix: string,
  project: ProjectResolutionContextV1
): { root: string; evidenceFile?: string } | undefined {
  if (prefix.startsWith('.') || prefix.startsWith('/')) {
    const root = confinedRoot(posix.join(posix.dirname(importerFile), prefix));
    return root ? { root } : undefined;
  }
  const alias = bestAliasPrefix(importerFile, prefix, project.aliases);
  if (!alias) return undefined;
  const capture = alias.rule.pattern.endsWith('/*')
    ? prefix.slice(alias.rule.pattern.slice(0, -1).length)
    : prefix.slice(alias.matched.length).replace(/^\//u, '');
  const target = alias.rule.targets[0];
  if (!target) return undefined;
  const resolved = target.includes('*')
    ? target.replace('*', capture)
    : posix.join(target, capture);
  const root = confinedRoot(resolved);
  return root ? { root, evidenceFile: alias.rule.configFile } : undefined;
}

function bestAliasPrefix(
  importerFile: string,
  specifier: string,
  aliases: readonly AliasRuleV1[]
): { rule: AliasRuleV1; matched: string } | undefined {
  return aliases
    .flatMap((rule) => {
      const star = rule.pattern.indexOf('*');
      const matched = star < 0 ? rule.pattern : rule.pattern.slice(0, star);
      const base = matched.replace(/\/$/u, '');
      return specifier === matched || specifier === base || specifier.startsWith(matched)
        ? [{ rule, matched }]
        : [];
    })
    .filter(({ rule }) => configApplies(importerFile, rule.configFile))
    .sort(
      (left, right) =>
        right.matched.length - left.matched.length ||
        left.rule.precedence - right.rule.precedence ||
        left.rule.configFile.localeCompare(right.rule.configFile)
    )[0];
}

function configApplies(importerFile: string, configFile: string): boolean {
  const directory = posix.dirname(configFile);
  return directory === '.' || importerFile.startsWith(`${directory}/`);
}

function collectStaticNamespaceMaps(
  source: { filePath: string; content: string },
  globsByBinding: ReadonlyMap<string, RootEvidence>,
  namespaces: Map<string, string>
): void {
  // This intentionally recognizes only static object entries. It never invokes
  // module maps, resolver functions, Object.keys(), or imported code.
  const direct = /(['"])(@[A-Za-z0-9_-]+)\1\s*:\s*([A-Za-z_$][\w$]*)\b/gu;
  const indirect = /(['"])(@[A-Za-z0-9_-]+)\1\s*:\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/gu;
  let match: RegExpExecArray | null;
  while ((match = indirect.exec(source.content)) !== null) {
    const binding = match[4];
    if (globsByBinding.has(binding)) namespaces.set(normalizeNamespace(match[2]), binding);
  }
  while ((match = direct.exec(source.content)) !== null) {
    const binding = match[3];
    if (globsByBinding.has(binding)) namespaces.set(normalizeNamespace(match[2]), binding);
  }
}

function materializeRegistrations(
  sourceFiles: ReadonlySet<string>,
  roots: readonly RootEvidence[],
  explicit: ReadonlyMap<string, RootEvidence[]>,
  configFile?: string
): InertiaPageRegistrationV1[] {
  const registrations: InertiaPageRegistrationV1[] = [];
  for (const [page, entries] of explicit) {
    for (const evidence of entries) {
      registrations.push(registration(page, evidence.root, evidence, configFile));
    }
  }
  for (const root of roots) {
    for (const componentFile of sourceFiles) {
      if (!componentFile.endsWith('.vue') || !componentFile.startsWith(`${root.root}/`)) continue;
      const relative = componentFile.slice(root.root.length + 1, -'.vue'.length);
      const pageName = root.namespace ? `${root.namespace}::${relative}` : relative;
      registrations.push(registration(pageName, componentFile, root, configFile));
      if (root.namespace === '@acmecore') {
        registrations.push(registration(`@AcmeCore::${relative}`, componentFile, root, configFile));
      }
    }
  }
  return [
    ...new Map(
      registrations.map((item) => [`${item.pageName}\0${item.componentFile}`, item])
    ).values(),
  ].sort(
    (left, right) =>
      left.pageName.localeCompare(right.pageName) ||
      left.componentFile.localeCompare(right.componentFile)
  );
}

function registration(
  pageName: string,
  componentFile: string,
  root: RootEvidence,
  configFile?: string
): InertiaPageRegistrationV1 {
  const evidenceLocations = [root.declaration];
  for (const filePath of [root.resolutionEvidence, configFile]) {
    if (filePath && !evidenceLocations.some((location) => location.filePath === filePath)) {
      evidenceLocations.push({ filePath, line: 1, column: 0 });
    }
  }
  return {
    pageName: canonicalPageName(pageName),
    componentFile,
    componentId: vueComponentId(componentFile),
    evidenceLocations,
  };
}

function canonicalPageName(pageName: string): string {
  const separator = pageName.indexOf('::');
  if (separator < 0) return pageName.replace(/\.vue$/u, '');
  return `${normalizeNamespace(pageName.slice(0, separator))}::${pageName
    .slice(separator + 2)
    .replace(/\.vue$/u, '')}`;
}

function normalizeNamespace(namespace: string): string {
  const normalized = namespace.startsWith('@') ? namespace : `@${namespace}`;
  return normalized.toLowerCase();
}

function confinedRoot(value: string): string | undefined {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    return undefined;
  }
  const normalized = normalizeRepositoryPath(value);
  return normalized?.replace(/\/$/u, '') || undefined;
}

function isSafePageName(pageName: string): boolean {
  if (!pageName || pageName.includes('\0') || pageName.includes('\\')) return false;
  const path = pageName.includes('::') ? pageName.slice(pageName.indexOf('::') + 2) : pageName;
  return !path.startsWith('/') && !path.split('/').includes('..');
}

function locationAt(
  source: { filePath: string; content: string },
  index: number
): SourceLocationV1 {
  const before = source.content.slice(0, index);
  const lines = before.split('\n');
  return { filePath: source.filePath, line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function STATIC_RESET(expression: RegExp): void {
  expression.lastIndex = 0;
}
