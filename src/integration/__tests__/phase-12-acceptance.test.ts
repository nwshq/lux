import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';
import { programEdgeId, vueComponentId } from '../../scanner/identity/program-identity.js';

/**
 * Independent Phase 12 contract battery (T46).
 *
 * This executable seam intentionally imports no Phase 12 production leaf. T45/T47
 * can replace it while the owner gold, safety negatives, invalidation behavior,
 * page-response regression guard, scoring, and watched-red controls stay fixed.
 */

type Coverage = 'active' | 'partial' | 'failed';
type MutationId =
  | 'repository-wide-suffix-search'
  | 'execute-page-resolver-code'
  | 'emit-from-file'
  | 'destroy-page-response'
  | 'permit-dynamic-page'
  | 'omit-registry-files-from-fingerprint'
  | 'remove-required-edge'
  | 'inject-forbidden-edge';

type GoldEdge = RelationshipBenchmarkCaseV1['expectedEdges'][number];
type ForbiddenEdge = RelationshipBenchmarkCaseV1['forbiddenEdges'][number];

interface Location {
  filePath: string;
  line: number;
  column: number;
}

interface RegistrySource {
  filePath: string;
  source: string;
}

interface QueryArgs {
  parentPath: string;
  source: string;
  files: Record<string, string>;
  pageRoots: string[];
  namespaces: Record<string, string[]>;
  configFile: string;
  registrySources: RegistrySource[];
  aliases: Record<string, { root: string; configFile: string }>;
  pageResponseContracts: Array<{ source: string; contractKind: 'page-response' }>;
}

interface Thresholds {
  minRecall: number;
  minPrecision: number;
  minPositiveCases: number;
  minForbiddenCases: number;
}

interface PhaseCase extends RelationshipBenchmarkCaseV1 {
  owner: string;
  goldSchemaVersion: number;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  thresholds: Thresholds;
  expectedCoverage: Coverage;
  expectedDiagnostics: string[];
  fixture?: { rootPath: string; subtrees: string[] };
  performanceProtocol?: {
    warmups: number;
    measurements: number;
    maxRegressionRatio: number;
    baselineWallMs: number;
    baselineRssBytes: number;
  };
  watchedMutations?: Array<{
    id: MutationId;
    expectedCheckerExitCode: number;
    expectedCase: string;
  }>;
}

interface ReturnedEdge {
  id: string;
  source: string;
  type: 'hydrates_component';
  target: string;
  confidence: 'framework-inferred';
  evidence: Location[];
  evidenceFiles: string[];
}

interface Observation {
  caseId: string;
  coverage: Coverage;
  diagnostics: string[];
  nodes: string[];
  edges: ReturnedEdge[];
  pageResponseBefore: QueryArgs['pageResponseContracts'];
  pageResponseAfter: QueryArgs['pageResponseContracts'];
  fingerprint: string;
  resolverExecuted: boolean;
}

interface Score {
  expected: number;
  returned: number;
  matched: number;
  positiveCases: number;
  forbiddenCases: number;
  recall: number;
  precision: number;
}

interface BatteryResult {
  exitCode: 0 | 1;
  failures: string[];
  observations: Observation[];
  score: Score;
  duplicateEdgeIds: number;
  danglingTargets: number;
  digest: string;
}

interface Root {
  path: string;
  namespace?: string;
  evidence: Location[];
}

interface PageFact {
  pageName?: string;
  sourceId: string;
  location: Location;
  dynamic: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const benchmarkPath = resolve(here, '../../../benchmarks/relationship/cases/phase-12.json');
const LUX_PIN = 'adbb7c141c700c13a1a54c71893fb9303cc65ba2';
const PRODUCER = 'laravel-inertia';
const STATIC_GLOB = /import\.meta\.glob\s*\(\s*(['"])([^'"\r\n]+)\1/gu;

function loadCases(): PhaseCase[] {
  return JSON.parse(readFileSync(benchmarkPath, 'utf8')) as PhaseCase[];
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function location(source: string, offset: number, filePath: string): Location {
  const prefix = source.slice(0, offset);
  const lines = prefix.split('\n');
  return { filePath, line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function phpSymbol(namespace: string, className: string, method: string): string {
  return `symbol:php:${namespace}\\${className}::${method}`;
}

function extractPageFact(args: QueryArgs): PageFact | undefined {
  const namespace = /\bnamespace\s+([^;]+);/u.exec(args.source)?.[1]?.trim() ?? '';
  const className = /\bclass\s+([A-Za-z_][\w]*)/u.exec(args.source)?.[1];
  const method = /\bfunction\s+([A-Za-z_][\w]*)\s*\(/u.exec(args.source)?.[1];
  if (!className || !method) return undefined;
  const sourceId = phpSymbol(namespace, className, method);
  const supported = /(?:\\Inertia\\Inertia|\bInertia)\s*::\s*render\s*\(|\binertia\s*\(/gu;
  const found = supported.exec(args.source);
  if (!found) {
    const alias = /\bpage\s*\(/u.exec(args.source);
    return alias
      ? {
          sourceId,
          location: location(args.source, alias.index, args.parentPath),
          dynamic: true,
        }
      : undefined;
  }
  const after = args.source.slice(found.index + found[0].length);
  const literal = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?(['"])([^'"\r\n]*)\1\s*(?:[,)]|$)/u.exec(after);
  return {
    pageName: literal && !(literal[1] === '"' && literal[2].includes('$')) ? literal[2] : undefined,
    sourceId,
    location: location(args.source, found.index, args.parentPath),
    dynamic: !literal || (literal[1] === '"' && literal[2].includes('$')),
  };
}

function safeRoot(value: string): string | undefined {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return;
  const normalized = posix.normalize(value).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (normalized === '..' || normalized.startsWith('../')) return;
  return normalized;
}

function canonicalNamespace(value: string): string {
  return (value.startsWith('@') ? value : `@${value}`).toLowerCase();
}

function safePage(page: string): boolean {
  const path = page.includes('::') ? page.slice(page.indexOf('::') + 2) : page;
  return (
    Boolean(path) &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').includes('..')
  );
}

function globRoot(
  registry: RegistrySource,
  pattern: string,
  aliases: QueryArgs['aliases']
): { root: string; aliasEvidence?: string } | undefined {
  const prefix = pattern.replace(/\/\*\*\/\*\.vue$/u, '').replace(/\/\*\.vue$/u, '');
  if (prefix === pattern) return;
  if (prefix.startsWith('.')) {
    const root = safeRoot(posix.join(posix.dirname(registry.filePath), prefix));
    return root ? { root } : undefined;
  }
  const alias = Object.entries(aliases)
    .filter(([key]) => prefix === key || prefix.startsWith(`${key}/`))
    .sort(([left], [right]) => right.length - left.length)[0];
  if (!alias) return;
  const [key, value] = alias;
  const suffix = prefix.slice(key.length).replace(/^\//u, '');
  const root = safeRoot(posix.join(value.root, suffix));
  return root ? { root, aliasEvidence: value.configFile } : undefined;
}

function registryRoots(args: QueryArgs, diagnostics: string[]): Root[] {
  const roots: Root[] = [];
  for (const configured of args.pageRoots) {
    const path = safeRoot(configured);
    if (!path) diagnostics.push('inertia-page-root-invalid');
    else roots.push({ path, evidence: [{ filePath: args.configFile, line: 1, column: 0 }] });
  }
  for (const [namespace, configuredRoots] of Object.entries(args.namespaces)) {
    for (const configured of configuredRoots) {
      const path = safeRoot(configured);
      if (!path) diagnostics.push('inertia-page-root-invalid');
      else {
        roots.push({
          path,
          namespace: canonicalNamespace(namespace),
          evidence: [{ filePath: args.configFile, line: 1, column: 0 }],
        });
      }
    }
  }

  for (const registry of args.registrySources) {
    const bindings = new Map<string, Root>();
    for (const match of registry.source.matchAll(STATIC_GLOB)) {
      const resolved = globRoot(registry, match[2], args.aliases);
      if (!resolved) continue;
      const before = registry.source.slice(Math.max(0, match.index - 100), match.index);
      const binding =
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(before)?.[1] ??
        /([A-Za-z_$][\w$]*)\s*:\s*$/u.exec(before)?.[1];
      const evidence = [location(registry.source, match.index, registry.filePath)];
      if (resolved.aliasEvidence) {
        evidence.push({ filePath: resolved.aliasEvidence, line: 1, column: 0 });
      }
      const root = { path: resolved.root, evidence };
      roots.push(root);
      if (binding) bindings.set(binding, root);
    }
    const direct = /(['"])(@[A-Za-z0-9_-]+)\1\s*:\s*([A-Za-z_$][\w$]*)\b/gu;
    const indirect = /(['"])(@[A-Za-z0-9_-]+)\1\s*:\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/gu;
    for (const match of registry.source.matchAll(indirect)) {
      const root = bindings.get(match[4]);
      if (root) roots.push({ ...root, namespace: canonicalNamespace(match[2]) });
    }
    for (const match of registry.source.matchAll(direct)) {
      const root = bindings.get(match[3]);
      if (root) roots.push({ ...root, namespace: canonicalNamespace(match[2]) });
    }
  }
  return roots;
}

function candidateFiles(
  pageName: string,
  roots: Root[],
  files: QueryArgs['files']
): Array<{
  file: string;
  root: Root;
}> {
  const separator = pageName.indexOf('::');
  const namespace = separator < 0 ? undefined : canonicalNamespace(pageName.slice(0, separator));
  const path = (separator < 0 ? pageName : pageName.slice(separator + 2)).replace(/\.vue$/u, '');
  return roots.flatMap((root) => {
    if (namespace !== root.namespace || (!namespace && root.namespace)) return [];
    const candidate = `${root.path}/${path}.vue`;
    return files[candidate] === undefined ? [] : [{ file: candidate, root }];
  });
}

function fingerprint(args: QueryArgs, mutation?: MutationId): string {
  return stableHash({
    pageRoots: args.pageRoots,
    namespaces: args.namespaces,
    configFile: args.configFile,
    aliases: args.aliases,
    registrySources:
      mutation === 'omit-registry-files-from-fingerprint'
        ? args.registrySources.map(({ filePath }) => ({ filePath }))
        : args.registrySources,
  });
}

function returnedEdge(source: string, target: string, evidence: Location[]): ReturnedEdge {
  return {
    id: programEdgeId('hydrates_component', source, target, PRODUCER),
    source,
    type: 'hydrates_component',
    target,
    confidence: 'framework-inferred',
    evidence,
    evidenceFiles: [...new Set(evidence.map((item) => item.filePath))],
  };
}

function observe(
  testCase: PhaseCase,
  mutation?: MutationId,
  overrides: Partial<QueryArgs> = {}
): Observation {
  const original = testCase.query?.args as unknown as QueryArgs;
  const args = { ...original, ...overrides };
  const diagnostics: string[] = [];
  const fact = extractPageFact(args);
  const roots = registryRoots(args, diagnostics);
  const pageResponseBefore = args.pageResponseContracts.map((item) => ({ ...item }));
  const pageResponseAfter =
    mutation === 'destroy-page-response'
      ? []
      : args.pageResponseContracts.map((item) => ({ ...item }));
  let resolverExecuted = false;
  if (
    mutation === 'execute-page-resolver-code' &&
    args.registrySources.some(({ source }) => source.includes('phase12ResolverExecuted = true'))
  ) {
    resolverExecuted = true;
  }

  let edge: ReturnedEdge | undefined;
  if (fact?.dynamic) diagnostics.push('inertia-page-dynamic');
  if (fact?.pageName && !safePage(fact.pageName)) diagnostics.push('inertia-page-invalid');
  if (fact?.pageName && safePage(fact.pageName)) {
    let candidates = candidateFiles(fact.pageName, roots, args.files);
    if (mutation === 'repository-wide-suffix-search' && candidates.length === 0) {
      const suffix = `/${fact.pageName.replace(/\.vue$/u, '')}.vue`;
      candidates = Object.keys(args.files)
        .filter((file) => file.endsWith(suffix))
        .map((file) => ({ file, root: { path: posix.dirname(file), evidence: [] } }));
    }
    if (candidates.length > 1) diagnostics.push('inertia-page-ambiguous');
    if (candidates.length === 1) {
      const target = vueComponentId(candidates[0].file);
      const source =
        mutation === 'emit-from-file'
          ? `file:php:${encodeURIComponent(args.parentPath)}`
          : fact.sourceId;
      edge = returnedEdge(source, target, [fact.location, ...candidates[0].root.evidence]);
    }
  }
  if (fact?.dynamic && mutation === 'permit-dynamic-page') {
    const forbidden = testCase.forbiddenEdges[0];
    if (forbidden?.source && forbidden.target) {
      edge = returnedEdge(forbidden.source, forbidden.target, [fact.location]);
    }
  }
  if (mutation === 'remove-required-edge') edge = undefined;
  if (mutation === 'inject-forbidden-edge') {
    const forbidden = testCase.forbiddenEdges[0];
    if (forbidden?.source && forbidden.target) {
      edge = returnedEdge(forbidden.source, forbidden.target, []);
    }
  }

  const nodes = [
    ...(fact ? [fact.sourceId] : []),
    ...Object.keys(args.files)
      .filter((file) => file.endsWith('.vue'))
      .map(vueComponentId),
  ];
  return {
    caseId: testCase.id,
    coverage: diagnostics.length === 0 ? 'active' : 'partial',
    diagnostics: [...new Set(diagnostics)],
    nodes: [...new Set(nodes)],
    edges: edge ? [edge] : [],
    pageResponseBefore,
    pageResponseAfter,
    fingerprint: fingerprint(args, mutation),
    resolverExecuted,
  };
}

function edgeKey(edge: GoldEdge | ReturnedEdge): string {
  return `${edge.source}\0${edge.type}\0${edge.target}`;
}

function forbiddenMatches(edge: ReturnedEdge, forbidden: ForbiddenEdge): boolean {
  return (
    (forbidden.source === undefined || forbidden.source === edge.source) &&
    (forbidden.type === undefined || forbidden.type === edge.type) &&
    (forbidden.target === undefined || forbidden.target === edge.target)
  );
}

function runBattery(cases: readonly PhaseCase[], mutation?: MutationId): BatteryResult {
  const observations = cases.map((testCase) => observe(testCase, mutation));
  const failures: string[] = [];
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  for (const testCase of cases) {
    const observation = byId.get(testCase.id)!;
    const returnedKeys = new Set(observation.edges.map(edgeKey));
    for (const expected of testCase.expectedEdges) {
      if (!returnedKeys.has(edgeKey(expected)))
        failures.push(`${testCase.id}: missing expected edge`);
    }
    if (
      observation.edges.some((edge) =>
        testCase.forbiddenEdges.some((forbidden) => forbiddenMatches(edge, forbidden))
      )
    ) {
      failures.push(`${testCase.id}: forbidden edge returned`);
    }
    if (observation.coverage !== testCase.expectedCoverage) {
      failures.push(`${testCase.id}: coverage ${observation.coverage}`);
    }
    for (const diagnostic of testCase.expectedDiagnostics) {
      if (!observation.diagnostics.includes(diagnostic)) {
        failures.push(`${testCase.id}: missing diagnostic ${diagnostic}`);
      }
    }
    if (stableHash(observation.pageResponseBefore) !== stableHash(observation.pageResponseAfter)) {
      failures.push(`${testCase.id}: page-response contract changed`);
    }
    if (observation.resolverExecuted) failures.push(`${testCase.id}: resolver code executed`);
  }

  const synthetic = cases.filter((item) => item.corpus === 'phase-12-inertia-synthetic');
  const ids = new Set(synthetic.map((item) => item.id));
  const expected = synthetic.flatMap((item) => item.expectedEdges);
  const returned = observations
    .filter((item) => ids.has(item.caseId))
    .flatMap((item) => item.edges);
  const expectedKeys = new Set(expected.map(edgeKey));
  const matched = new Set(returned.filter((edge) => expectedKeys.has(edgeKey(edge))).map(edgeKey))
    .size;
  const score: Score = {
    expected: expected.length,
    returned: returned.length,
    matched,
    positiveCases: synthetic.filter((item) => item.expectedEdges.length > 0).length,
    forbiddenCases: synthetic.filter((item) => item.forbiddenEdges.length > 0).length,
    recall: expected.length === 0 ? 0 : matched / expected.length,
    precision: returned.length === 0 ? 0 : matched / returned.length,
  };
  const threshold = synthetic[0]?.thresholds;
  if (!threshold || score.positiveCases < threshold.minPositiveCases) {
    failures.push(`cohort: only ${score.positiveCases} positive cases`);
  }
  if (!threshold || score.forbiddenCases < threshold.minForbiddenCases) {
    failures.push(`cohort: only ${score.forbiddenCases} forbidden cases`);
  }
  if (!threshold || score.expected === 0 || score.recall < threshold.minRecall) {
    failures.push(`cohort: recall ${score.recall}`);
  }
  if (!threshold || score.returned === 0 || score.precision < threshold.minPrecision) {
    failures.push(`cohort: precision ${score.precision}`);
  }

  const duplicateEdgeIds = observations.reduce(
    (count, item) => count + item.edges.length - new Set(item.edges.map((edge) => edge.id)).size,
    0
  );
  const danglingTargets = observations.reduce(
    (count, item) => count + item.edges.filter((edge) => !item.nodes.includes(edge.target)).length,
    0
  );
  if (duplicateEdgeIds > 0) failures.push(`integrity: ${duplicateEdgeIds} duplicate edges`);
  if (danglingTargets > 0) failures.push(`integrity: ${danglingTargets} dangling targets`);
  const projection = observations.map((item) => ({
    caseId: item.caseId,
    fingerprint: item.fingerprint,
    edges: item.edges.map(({ id, source, type, target }) => ({ id, source, type, target })),
  }));
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    failures,
    observations,
    score,
    duplicateEdgeIds,
    danglingTargets,
    digest: stableHash(projection),
  };
}

function editedRegistryObservation(testCase: PhaseCase, mutation?: MutationId): Observation {
  const args = testCase.query?.args as unknown as QueryArgs;
  const registrySources = args.registrySources.map((item) => ({
    ...item,
    source: item.source.replace(/(['"])([^'"]+\/\*\*\/\*\.vue)\1/u, 'pattern'),
  }));
  return observe(testCase, mutation, { registrySources });
}

function watchedMutationResult(cases: readonly PhaseCase[], mutation: MutationId): BatteryResult {
  const result = runBattery(cases, mutation);
  if (mutation !== 'omit-registry-files-from-fingerprint') return result;
  const testCase = cases.find((item) => item.id === 'p12-positive-13-static-relative-glob')!;
  const before = observe(testCase, mutation);
  const after = editedRegistryObservation(testCase, mutation);
  if (before.fingerprint === after.fingerprint) {
    return {
      ...result,
      exitCode: 1,
      failures: [
        ...result.failures,
        'p12-positive-13-static-relative-glob: registry edit omitted from fingerprint',
      ],
    };
  }
  return result;
}

describe('Phase 12 independent Inertia page-hydration acceptance', () => {
  it('pins portable owner gold and the frozen fixture schema', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(37);
    expect(cases.every((item) => item.owner === 'Example Maintainer')).toBe(true);
    expect(cases.every((item) => item.goldSchemaVersion === 1)).toBe(true);
    expect(cases.every((item) => item.fixtureSchemaVersion === 1)).toBe(true);
    expect(cases.every((item) => item.corpusPin.commit === LUX_PIN)).toBe(true);
    expect(JSON.stringify(cases)).not.toMatch(/(?:"\/Users\/|[A-Za-z]:\\\\|"\/home\/)/u);
  });

  it('executes a nonvacuous 24-positive/13-forbidden cohort above .95/.90', () => {
    const result = runBattery(loadCases());
    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.score).toMatchObject({
      positiveCases: 24,
      forbiddenCases: 13,
      precision: 1,
      recall: 1,
    });
    expect(result.score.precision).toBeGreaterThanOrEqual(0.95);
    expect(result.score.recall).toBeGreaterThanOrEqual(0.9);
  });

  it('covers facade/helper/plain roots, Acme namespaces, legacy names, globs, and module maps', () => {
    const ids = new Set(loadCases().map((item) => item.id));
    for (const required of [
      'p12-positive-01-facade-root',
      'p12-positive-02-helper-root',
      'p12-positive-07-second-root',
      'p12-positive-09-config-namespace',
      'p12-positive-12-legacy-acme-config',
      'p12-positive-13-static-relative-glob',
      'p12-positive-15-module-map-direct',
      'p12-positive-16-acme-module-map',
      'p12-positive-24-legacy-acme-glob',
    ]) {
      expect(ids.has(required), required).toBe(true);
    }
  });

  it('emits no dynamic, missing, ambiguous, suffix-only, dynamic-glob, or traversal edge', () => {
    const result = runBattery(loadCases());
    const byId = new Map(result.observations.map((item) => [item.caseId, item]));
    for (const id of [
      'p12-forbidden-01-dynamic-variable',
      'p12-forbidden-02-concatenation',
      'p12-forbidden-03-conditional',
      'p12-forbidden-04-interpolated',
      'p12-forbidden-05-missing-component',
      'p12-forbidden-06-ambiguous-roots',
      'p12-forbidden-07-repository-suffix',
      'p12-forbidden-08-dynamic-glob',
      'p12-forbidden-09-page-traversal',
      'p12-forbidden-10-namespace-traversal',
      'p12-forbidden-11-root-traversal',
    ]) {
      expect(byId.get(id)?.edges, id).toEqual([]);
    }
  });

  it('uses exact method and Vue IDs with PHP plus registry/config/alias evidence', () => {
    const result = runBattery(loadCases());
    const edges = result.observations.flatMap((item) => item.edges);
    expect(edges).toHaveLength(24);
    expect(edges.every((edge) => edge.source.startsWith('symbol:php:'))).toBe(true);
    expect(edges.every((edge) => edge.target.startsWith('component:vue:'))).toBe(true);
    expect(edges.every((edge) => edge.confidence === 'framework-inferred')).toBe(true);
    expect(edges.every((edge) => edge.evidenceFiles.length >= 2)).toBe(true);
    const aliased = result.observations.find(
      (item) => item.caseId === 'p12-positive-15-module-map-direct'
    )?.edges[0];
    expect(aliased?.evidenceFiles).toEqual([
      'app/Http/Controllers/OfferController.php',
      'resources/js/modules.ts',
      'jsconfig.json',
    ]);
  });

  it('does not execute resolver code and preserves every existing page-response contract', () => {
    const result = runBattery(loadCases());
    expect(result.observations.every((item) => !item.resolverExecuted)).toBe(true);
    expect(
      result.observations.every(
        (item) => stableHash(item.pageResponseBefore) === stableHash(item.pageResponseAfter)
      )
    ).toBe(true);
  });

  it('invalidates cited bridges and changes fingerprints after config or glob edits', () => {
    const cases = loadCases();
    const configured = cases.find((item) => item.id === 'p12-positive-01-facade-root')!;
    const configuredBefore = observe(configured);
    const configuredAfter = observe(configured, undefined, { pageRoots: [] });
    expect(configuredBefore.edges).toHaveLength(1);
    expect(configuredAfter.edges).toEqual([]);
    expect(configuredAfter.fingerprint).not.toBe(configuredBefore.fingerprint);

    const globbed = cases.find((item) => item.id === 'p12-positive-13-static-relative-glob')!;
    const globbedBefore = observe(globbed);
    const globbedAfter = editedRegistryObservation(globbed);
    expect(globbedBefore.edges).toHaveLength(1);
    expect(globbedAfter.edges).toEqual([]);
    expect(globbedAfter.fingerprint).not.toBe(globbedBefore.fingerprint);
  });

  it('has zero duplicate/dangling edges and a stable two-build digest', () => {
    const first = runBattery(loadCases());
    const second = runBattery(loadCases());
    expect(first.duplicateEdgeIds).toBe(0);
    expect(first.danglingTargets).toBe(0);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.digest).toBe(second.digest);
  });

  it('records the VAL-06 performance protocol', () => {
    expect(loadCases()[0].performanceProtocol).toEqual({
      warmups: 3,
      measurements: 5,
      maxRegressionRatio: 1.2,
      baselineWallMs: 1000,
      baselineRssBytes: 268435456,
    });
  });

  it('executes every prescribed repository, resolver, source, response, dynamic, fingerprint, remove, and inject mutation red', () => {
    const cases = loadCases();
    const controls = cases.flatMap((item) => item.watchedMutations ?? []);
    expect(controls.map((item) => item.id)).toEqual([
      'repository-wide-suffix-search',
      'execute-page-resolver-code',
      'emit-from-file',
      'destroy-page-response',
      'permit-dynamic-page',
      'omit-registry-files-from-fingerprint',
      'remove-required-edge',
      'inject-forbidden-edge',
    ]);
    for (const control of controls) {
      const result = watchedMutationResult(cases, control.id);
      expect(result.exitCode, control.id).toBe(control.expectedCheckerExitCode);
      expect(
        result.failures.some((failure) => failure.startsWith(`${control.expectedCase}:`)),
        `${control.id}: ${result.failures.join(', ')}`
      ).toBe(true);
    }
  });
});
