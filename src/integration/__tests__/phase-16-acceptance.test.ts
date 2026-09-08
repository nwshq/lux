import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';

/**
 * Independent Phase 16/T62 Expo Router reference seam.
 *
 * It intentionally imports no production scanner or identity helper. The small parser below owns
 * the frozen literal-only grammar and destination normalization laws exercised by this battery.
 */
type Mutation =
  | 'preserve-route-groups'
  | 'retain-query-string'
  | 'reverse-navigation-edge'
  | 'accept-external-url'
  | 'resolve-dynamic-variable';
type ForbiddenEdge = RelationshipBenchmarkCaseV1['forbiddenEdges'][number];

interface Args extends Record<string, unknown> {
  scenario: string;
  path: string;
  exported: string;
  sourceText: string;
  routeFiles: string[];
}
interface PhaseCase extends RelationshipBenchmarkCaseV1 {
  owner: string;
  goldSchemaVersion: 1;
  fixtureSchemaVersion: 1;
  corpusPin: { remote: string; commit: string };
  sourceFamily: string;
  expectedDiagnostics: string[];
  thresholds: { minPrecision: number; minRecall: number };
  query: { tool: string; args: Args };
  performanceProtocol?: {
    warmups: number;
    measurements: number;
    maxRegressionRatio: number;
    baselineWallMs: number;
    baselineRssBytes: number;
  };
  watchedMutations?: Array<{
    id: Mutation;
    expectedCheckerExitCode: 1;
    expectedCase: string;
  }>;
}
interface Edge {
  source: string;
  type: 'navigates_to';
  target: string;
  confidence: 'framework-inferred';
}
interface Observation {
  caseId: string;
  nodes: string[];
  edges: Edge[];
  diagnostics: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../benchmarks/relationship/cases/phase-16.json');
const LUX_PIN = '241685c091e71f744c38e89d87635708f04a565a';
const AUCTIC_PIN = '609ac51c752448b6fba368da656a8c6f4e0842d7';
const loadCases = (): PhaseCase[] => JSON.parse(readFileSync(fixturePath, 'utf8')) as PhaseCase[];

function encode(value: string): string {
  return encodeURIComponent(value);
}
function componentId(path: string, exported: string): string {
  const normalized = posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//u, '');
  return `component:react:${encode(normalized)}#${encode(exported)}`;
}
function routeId(route: string): string {
  return `surface:route:expo:${encode(route)}`;
}
function withoutGroups(path: string): string {
  return path
    .split('/')
    .filter((part) => !/^\([^/]+\)$/u.test(part))
    .join('/');
}
function routeForFile(file: string, mutation?: Mutation): string | undefined {
  if (!file.startsWith('app/') || /(?:^|\/)_(?:layout|sitemap)\.[cm]?[jt]sx?$/u.test(file))
    return undefined;
  if (/(?:^|\/)\+(?:html|not-found|middleware|native-intent)\.[cm]?[jt]sx?$/u.test(file))
    return undefined;
  let value = file.replace(/^app\//u, '').replace(/\.[cm]?[jt]sx?$/u, '');
  if (mutation !== 'preserve-route-groups') value = withoutGroups(value);
  value = value.replace(/(?:^|\/)index$/u, '');
  return posix.normalize(`/${value}`).replace(/\/$/u, '') || '/';
}

interface Destination {
  value: string;
  hasInterpolation: boolean;
}
function destination(expression: string): Destination | undefined {
  const trimmed = expression.trim();
  const literal = /^(['"])(.*?)\1/su.exec(trimmed);
  if (literal) return { value: literal[2], hasInterpolation: false };
  const braced = /^\{\s*(`[^`]*`)\s*\}/su.exec(trimmed);
  if (braced) return destination(braced[1]);
  const template = /^`([^`]*)`/su.exec(trimmed);
  if (template)
    return { value: template[1].replace(/\$\{[^}]+\}/gu, ':dynamic'), hasInterpolation: true };
  const pathname = /\bpathname\s*:\s*(['"])(.*?)\1/su.exec(trimmed);
  if (pathname) return { value: pathname[2], hasInterpolation: false };
  return undefined;
}
function imported(source: string, name: string): boolean {
  return new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]expo-router['"]`,
    'su'
  ).test(source);
}
function destinations(source: string, mutation?: Mutation): Destination[] {
  const found: Destination[] = [];
  if (
    imported(source, 'useRouter') &&
    /\b(?:const|let)\s+router\s*=\s*useRouter\s*\(\s*\)/u.test(source)
  ) {
    for (const match of source.matchAll(
      /\brouter\s*\.\s*(?:push|replace|navigate)\s*\(\s*([^;\n]+)/gu
    )) {
      const parsed = destination(match[1]);
      if (parsed) found.push(parsed);
      else if (mutation === 'resolve-dynamic-variable')
        found.push({ value: '/__dynamic__', hasInterpolation: false });
    }
  }
  for (const tag of ['Link', 'Redirect'] as const) {
    if (!imported(source, tag)) continue;
    const pattern = new RegExp(
      `<${tag}\\b[^>]*\\bhref\\s*=\\s*(?:\\{([^}]+)\\}|(['"])(.*?)\\2)`,
      'gsu'
    );
    for (const match of source.matchAll(pattern)) {
      const parsed = destination(match[1] ?? `'${match[3]}'`);
      if (parsed) found.push(parsed);
      else if (mutation === 'resolve-dynamic-variable')
        found.push({ value: '/__dynamic__', hasInterpolation: false });
    }
  }
  return found;
}
function segmentsMatch(destinationPath: string, route: string): boolean {
  const actual = destinationPath.split('/').filter(Boolean);
  const declared = route.split('/').filter(Boolean);
  let left = 0;
  for (let right = 0; right < declared.length; right += 1, left += 1) {
    const segment = declared[right];
    if (/^\[\.\.\..+\]$/u.test(segment)) return left < actual.length;
    if (left >= actual.length) return false;
    if (/^\[.+\]$/u.test(segment) || actual[left] === ':dynamic') continue;
    if (segment !== actual[left]) return false;
  }
  return left === actual.length;
}
function resolveDestination(
  raw: Destination,
  routeFiles: readonly string[],
  mutation?: Mutation
): string | undefined {
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(raw.value) || raw.value.startsWith('//')) {
    return mutation === 'accept-external-url' ? raw.value : undefined;
  }
  let value = raw.value;
  if (mutation !== 'retain-query-string') value = value.split(/[?#]/u, 1)[0];
  if (mutation !== 'preserve-route-groups') value = withoutGroups(value);
  if (!value.startsWith('/')) return undefined;
  value = posix.normalize(value).replace(/\/$/u, '') || '/';
  const routes = routeFiles
    .map((file) => routeForFile(file, mutation))
    .filter((route): route is string => route !== undefined);
  if (routes.includes(value)) return value;
  const candidates = routes.filter((route) => segmentsMatch(value, route));
  return candidates.length === 1 ? candidates[0] : undefined;
}
function observe(testCase: PhaseCase, mutation?: Mutation): Observation {
  const args = testCase.query.args;
  const source = componentId(args.path, args.exported);
  const declaredRoutes = args.routeFiles
    .map((file) => routeForFile(file, mutation))
    .filter((route): route is string => route !== undefined);
  const edges = destinations(args.sourceText, mutation).flatMap((raw): Edge[] => {
    const route = resolveDestination(raw, args.routeFiles, mutation);
    if (!route) return [];
    const edge = {
      source,
      type: 'navigates_to' as const,
      target: routeId(route),
      confidence: 'framework-inferred' as const,
    };
    return mutation === 'reverse-navigation-edge'
      ? [{ ...edge, source: edge.target, target: edge.source }]
      : [edge];
  });
  const unique = [
    ...new Map(edges.map((edge) => [`${edge.source}|${edge.target}`, edge])).values(),
  ];
  return {
    caseId: testCase.id,
    nodes: [source, ...declaredRoutes.map(routeId)],
    edges: unique,
    diagnostics: [...testCase.expectedDiagnostics],
  };
}
function edgeKey(edge: { source: string; type: string; target: string }): string {
  return `${edge.source}|${edge.type}|${edge.target}`;
}
function forbiddenMatch(edge: Edge, forbidden: ForbiddenEdge): boolean {
  return (
    (!forbidden.source || forbidden.source === edge.source) &&
    (!forbidden.type || forbidden.type === edge.type) &&
    (!forbidden.target || forbidden.target === edge.target)
  );
}
function score(cases: readonly PhaseCase[], observations: readonly Observation[]) {
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  const expected = cases.flatMap((item) => item.expectedEdges).length;
  const returned = observations.flatMap((item) => item.edges).length;
  let matched = 0;
  for (const item of cases) {
    const actual = new Set((byId.get(item.id)?.edges ?? []).map(edgeKey));
    matched += item.expectedEdges.filter((edge) => actual.has(edgeKey(edge))).length;
  }
  return {
    precision: returned ? matched / returned : 1,
    recall: expected ? matched / expected : 1,
  };
}
function run(cases: readonly PhaseCase[], mutation?: Mutation) {
  const observations = cases.map((item) => observe(item, mutation));
  const failures: string[] = [];
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  for (const item of cases) {
    const observed = byId.get(item.id)!;
    const actual = new Set(observed.edges.map(edgeKey));
    for (const expected of item.expectedEdges)
      if (!actual.has(edgeKey(expected))) failures.push(`${item.id}: missing expected edge`);
    for (const forbidden of item.forbiddenEdges)
      if (observed.edges.some((edge) => forbiddenMatch(edge, forbidden)))
        failures.push(`${item.id}: emitted forbidden edge`);
  }
  const edges = observations.flatMap((item) => item.edges);
  const nodes = new Set(observations.flatMap((item) => item.nodes));
  const danglingTargets = edges.filter((edge) => !nodes.has(edge.target)).length;
  const duplicateEdges =
    edges.length -
    new Set(
      observations.flatMap((item) => item.edges.map((edge) => `${item.caseId}|${edgeKey(edge)}`))
    ).size;
  if (danglingTargets) failures.push(`integrity: ${danglingTargets} dangling targets`);
  if (duplicateEdges) failures.push(`integrity: ${duplicateEdges} duplicate edges`);
  const measured = score(cases, observations);
  if (measured.precision < 1 || measured.recall < 1) failures.push('score: below owner gold');
  const projection = observations.map((item) => ({
    caseId: item.caseId,
    edges: item.edges.map(edgeKey).sort(),
  }));
  return {
    exitCode: failures.length ? 1 : 0,
    failures,
    observations,
    score: measured,
    danglingTargets,
    duplicateEdges,
    digest: createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
  };
}

describe('Phase 16/T62 independent Expo Router acceptance', () => {
  it('pins portable schema-v1 Lux and acme Mobile owner gold', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(40);
    expect(cases.every((item) => item.owner === 'Example Maintainer')).toBe(true);
    expect(cases.every((item) => item.goldSchemaVersion === 1)).toBe(true);
    expect(cases.every((item) => item.fixtureSchemaVersion === 1)).toBe(true);
    expect(
      new Set(
        cases
          .filter((item) => item.corpus === 'phase-16-expo-synthetic')
          .map((item) => item.corpusPin.commit)
      )
    ).toEqual(new Set([LUX_PIN]));
    expect(
      new Set(
        cases.filter((item) => item.corpus === 'auctic-mobile').map((item) => item.corpusPin.commit)
      )
    ).toEqual(new Set([AUCTIC_PIN]));
    expect(JSON.stringify(cases)).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\|\/home\/)/u);
  });

  it('executes exactly 25 positive and 15 forbidden cases at perfect score', () => {
    const cases = loadCases();
    const result = run(cases);
    expect(cases.filter((item) => item.expectedEdges.length > 0)).toHaveLength(25);
    expect(cases.filter((item) => item.forbiddenEdges.length > 0)).toHaveLength(15);
    expect(result.exitCode, result.failures.join(', ')).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.score).toEqual({ precision: 1, recall: 1 });
  });

  it('uses only actual listed acme paths and scores each exact-pin cohort', () => {
    const cases = loadCases();
    const aucticPaths = cases
      .filter((item) => item.corpus === 'auctic-mobile')
      .map((item) => item.sourceFamily);
    expect(new Set(aucticPaths)).toEqual(
      new Set([
        'app/(authenticated)/_layout.tsx',
        'app/(authenticated)/catalog/index.tsx',
        'app/(authenticated)/catalog/listing/[id]/index.tsx',
        'app/(authenticated)/catalog/qr-scanner.tsx',
        'app/(authenticated)/modal.tsx',
        'app/(authenticated)/settings/about.tsx',
        'app/+not-found.tsx',
        'app/auth/index.tsx',
        'app/auth/login-qr-scanner.tsx',
        'app/auth/verify.tsx',
        'app/components/ListingCard.tsx',
        'app/oauth.tsx',
        'components/EditLink.tsx',
        'components/EventCard.tsx',
        'components/ImageWithFallback.tsx',
        'components/SettingsIcon.tsx',
      ])
    );
    const result = run(cases);
    for (const corpus of ['phase-16-expo-synthetic', 'auctic-mobile']) {
      const selected = cases.filter((item) => item.corpus === corpus);
      const ids = new Set(selected.map((item) => item.id));
      expect(
        score(
          selected,
          result.observations.filter((item) => ids.has(item.caseId))
        )
      ).toEqual({ precision: 1, recall: 1 });
    }
  });

  it('freezes grouping, index, query, dynamic-segment, Link, Redirect, push, replace, and object destination laws', () => {
    const scenarios = new Set(loadCases().map((item) => item.query.args.scenario));
    for (const law of [
      'group',
      'index',
      'query',
      'dynamic-segment',
      'link',
      'redirect',
      'push',
      'replace',
      'object',
    ])
      expect(scenarios.has(law), law).toBe(true);
  });

  it('is stable, deduplicated, and has no dangling targets', () => {
    const first = run(loadCases());
    const second = run(loadCases());
    expect(first.duplicateEdges).toBe(0);
    expect(first.danglingTargets).toBe(0);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.digest).toBe(second.digest);
  });

  it('records and executes the VAL-06 3+5 bounded performance protocol', () => {
    const protocol = loadCases()[0].performanceProtocol;
    expect(protocol).toEqual({
      warmups: 3,
      measurements: 5,
      maxRegressionRatio: 1.2,
      baselineWallMs: 250,
      baselineRssBytes: 134217728,
    });
    for (let index = 0; index < protocol!.warmups; index += 1) run(loadCases());
    const elapsed: number[] = [];
    for (let index = 0; index < protocol!.measurements; index += 1) {
      const start = performance.now();
      run(loadCases());
      elapsed.push(performance.now() - start);
    }
    expect(Math.max(...elapsed)).toBeLessThan(
      protocol!.baselineWallMs * protocol!.maxRegressionRatio
    );
  });

  it('executes all five watched normalization/destination mutations red', () => {
    const cases = loadCases();
    const controls = cases.flatMap((item) => item.watchedMutations ?? []);
    expect(controls.map((item) => item.id)).toEqual([
      'preserve-route-groups',
      'retain-query-string',
      'reverse-navigation-edge',
      'accept-external-url',
      'resolve-dynamic-variable',
    ]);
    for (const control of controls) {
      const result = run(cases, control.id);
      expect(result.exitCode, control.id).toBe(control.expectedCheckerExitCode);
      expect(
        result.failures.some(
          (failure) =>
            failure.startsWith(control.expectedCase) ||
            failure.startsWith('integrity:') ||
            failure.startsWith('score:')
        ),
        `${control.id}: ${result.failures.join(', ')}`
      ).toBe(true);
    }
  });
});
