import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  ExportTargetV1,
  ModuleResolutionResultV1,
  RelationshipBenchmarkCaseV1,
} from '../../scanner/contracts/program.js';

/**
 * Independent Phase 7 contract battery.
 *
 * The production leaves are deliberately not imported here: T26 must remain an
 * independent oracle that is executable at the frozen-contract commit. The
 * central integration test can inject the production resolver into the same
 * two consumer seams once T25 lands. Virtual files represent the exact §6.2
 * fixture layout without adding files outside T26 ownership.
 */

type MutationId =
  | 'reverse-ts-js-candidate-order'
  | 'bypass-export-index-ast'
  | 'bypass-shared-dependency-resolver'
  | 'remove-barrel-visited-set'
  | 'allow-root-traversal'
  | 'insert-forbidden-edge'
  | 'remove-required-edge';

type Resolution = ModuleResolutionResultV1 | null;
type DiagnosticCode =
  | 'module.ambiguous'
  | 'module.external'
  | 'module.missing'
  | 'path-traversal'
  | 'barrel-cycle'
  | 'dynamic-computed'
  | 'export-conflict'
  | 'export-missing'
  | 'resolver-overflow';

interface ExpectedEdge {
  source: string;
  type: 'calls' | 'references';
  target: string;
  minConfidence: 'framework-inferred';
}

interface ForbiddenEdge {
  source?: string;
  type?: string;
  target?: string;
}

interface PhaseCase extends Omit<RelationshipBenchmarkCaseV1, 'expectedEdges' | 'forbiddenEdges'> {
  expectedEdges: ExpectedEdge[];
  forbiddenEdges: ForbiddenEdge[];
  expectedResolution: Resolution;
  expectedDiagnostic?: DiagnosticCode;
  owner: string;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  thresholds: {
    minRecall: number;
    minPrecision: number;
    minPositiveCases: number;
    minForbiddenCases: number;
  };
  fixture?: { rootPath: string; layout: string[] };
  watchedMutations?: Array<{
    id: MutationId;
    expectedCheckerExitCode: number;
    expectedCase: string;
  }>;
}

interface ReturnedEdge {
  id: string;
  source: string;
  type: 'calls' | 'references';
  target: string;
  confidence: 'framework-inferred';
}

interface Observation {
  caseId: string;
  astResolution: Resolution;
  dependencyResolution: Resolution;
  diagnostics: DiagnosticCode[];
  edges: ReturnedEdge[];
}

interface ExportIndex {
  default?: ExportTargetV1[];
  named: Record<string, ExportTargetV1[]>;
  reexports: Array<{ exported: string; imported: string; specifier: string }>;
}

type ExportResolution =
  | { status: 'resolved'; target: ExportTargetV1 }
  | { status: 'missing' | 'cycle' }
  | { status: 'ambiguous'; candidates: ExportTargetV1[] };

interface SeamStats {
  astSharedResolverCalls: number;
  dependencySharedResolverCalls: number;
  astExportIndexCalls: number;
}

interface BatteryResult {
  exitCode: 0 | 1;
  recall: number;
  precision: number;
  positiveCases: number;
  forbiddenCases: number;
  failures: string[];
  observations: Observation[];
  edgeIds: string[];
  digest: string;
  stats: SeamStats;
}

const here = dirname(fileURLToPath(import.meta.url));
const benchmarkFile = resolve(here, '../../../benchmarks/relationship/cases/phase-07.json');
const FROZEN_CONTRACT = '89876761aa3d02fd6594735aa0e35a9fd93bb1de';
const EXPECTED_LAYOUT = [
  'src/caller.ts',
  'src/exact.js',
  'src/extension.ts',
  'src/extension.js',
  'src/jsx.jsx',
  'src/folder/index.ts',
  'src/default.ts',
  'src/named.ts',
  'src/cjs-default.cjs',
  'src/cjs-named.cjs',
  'src/barrel/index.ts',
  'src/barrel/a.ts',
  'src/barrel/b.ts',
  'src/cycle/a.ts',
  'src/cycle/b.ts',
  'outside.ts',
] as const;

const SOURCE_FILES: ReadonlySet<string> = new Set(EXPECTED_LAYOUT);
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

function target(filePath: string, localName: string): ExportTargetV1 {
  return { filePath, localName, declarationId: localName };
}

/** Independent expected export index, including barrel and CommonJS semantics. */
const EXPORTS = new Map<string, ExportIndex>([
  ['src/exact.js', { default: [target('src/exact.js', 'Exact')], named: {}, reexports: [] }],
  ['src/extension.ts', { named: { ExtTs: [target('src/extension.ts', 'ExtTs')] }, reexports: [] }],
  ['src/extension.js', { named: { ExtJs: [target('src/extension.js', 'ExtJs')] }, reexports: [] }],
  ['src/jsx.jsx', { default: [target('src/jsx.jsx', 'JsxView')], named: {}, reexports: [] }],
  [
    'src/folder/index.ts',
    { named: { Folder: [target('src/folder/index.ts', 'Folder')] }, reexports: [] },
  ],
  [
    'src/default.ts',
    { default: [target('src/default.ts', 'DefaultThing')], named: {}, reexports: [] },
  ],
  [
    'src/named.ts',
    {
      named: {
        Named: [target('src/named.ts', 'Named')],
        Aliased: [target('src/named.ts', 'localBar')],
        Extra: [target('src/named.ts', 'Extra')],
        // ESM and CommonJS facts for one exported name are retained, not overwritten.
        Conflict: [target('src/named.ts', 'ConflictEsm'), target('src/named.ts', 'ConflictCjs')],
      },
      reexports: [],
    },
  ],
  [
    'src/cjs-default.cjs',
    { default: [target('src/cjs-default.cjs', 'LegacyDefault')], named: {}, reexports: [] },
  ],
  [
    'src/cjs-named.cjs',
    {
      named: {
        Foo: [target('src/cjs-named.cjs', 'Foo')],
        bar: [target('src/cjs-named.cjs', 'localBar')],
        Direct: [target('src/cjs-named.cjs', 'Direct')],
        Shortcut: [target('src/cjs-named.cjs', 'Shortcut')],
      },
      reexports: [],
    },
  ],
  [
    'src/barrel/index.ts',
    {
      named: {},
      reexports: [
        { exported: 'BarrelDefault', imported: 'default', specifier: '../default' },
        { exported: 'Renamed', imported: 'Named', specifier: '../named' },
        { exported: '*', imported: '*', specifier: './a' },
        { exported: '*', imported: '*', specifier: './b' },
      ],
    },
  ],
  [
    'src/barrel/a.ts',
    {
      named: {
        Alpha: [target('src/barrel/a.ts', 'Alpha')],
        AOnly: [target('src/barrel/a.ts', 'AOnly')],
      },
      reexports: [],
    },
  ],
  [
    'src/barrel/b.ts',
    {
      named: {
        Beta: [target('src/barrel/b.ts', 'Beta')],
        BOnly: [target('src/barrel/b.ts', 'BOnly')],
      },
      reexports: [],
    },
  ],
  [
    'src/cycle/a.ts',
    { named: {}, reexports: [{ exported: '*', imported: '*', specifier: './b' }] },
  ],
  [
    'src/cycle/b.ts',
    { named: {}, reexports: [{ exported: '*', imported: '*', specifier: './a' }] },
  ],
  ['outside.ts', { named: { Outside: [target('outside.ts', 'Outside')] }, reexports: [] }],
]);

function loadCases(): PhaseCase[] {
  return JSON.parse(readFileSync(benchmarkFile, 'utf8')) as PhaseCase[];
}

function bytes(value: unknown): string {
  return JSON.stringify(value);
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(bytes(value)).digest('hex');
}

function normalizeRepositoryPath(value: string): string | undefined {
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.includes('\0')
  ) {
    return undefined;
  }
  return normalized === '.' ? '' : normalized.replace(/^\.\//u, '');
}

function isTraversal(importerFile: string, specifier: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return false;
  const importer = normalizeRepositoryPath(importerFile);
  if (!importer) return true;
  const rawBase = specifier.startsWith('/')
    ? specifier.slice(1)
    : posix.join(posix.dirname(importer), specifier);
  return normalizeRepositoryPath(rawBase) === undefined;
}

function existingCandidates(base: string, mutation?: MutationId): string[] {
  const extensionOrder = [...EXTENSIONS];
  if (mutation === 'reverse-ts-js-candidate-order') {
    const ts = extensionOrder.indexOf('.ts');
    const js = extensionOrder.indexOf('.js');
    [extensionOrder[ts], extensionOrder[js]] = [extensionOrder[js], extensionOrder[ts]];
  }
  const candidates = [
    ...extensionOrder.map((extension) => `${base}${extension}`),
    ...extensionOrder.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.filter((candidate) => SOURCE_FILES.has(candidate));
}

/** Frozen §6.1 local-module contract used as an independent injectable seam. */
function resolveLocalModule(
  importerFile: string,
  specifier: string,
  mutation?: MutationId
): ModuleResolutionResultV1 | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return { status: 'external', specifier };
  }

  if (mutation === 'allow-root-traversal' && isTraversal(importerFile, specifier)) {
    return { status: 'resolved', targetFile: 'outside.ts', via: 'relative' };
  }

  const importer = normalizeRepositoryPath(importerFile);
  if (!importer) return { status: 'missing', specifier };
  const rawBase = specifier.startsWith('/')
    ? specifier.slice(1)
    : posix.join(posix.dirname(importer), specifier);
  const base = normalizeRepositoryPath(rawBase);
  if (base === undefined) return { status: 'missing', specifier };

  if (SOURCE_FILES.has(base)) return { status: 'resolved', targetFile: base, via: 'relative' };

  const emittedSuffix = base.match(/\.(?:mjs|cjs|js|jsx)$/u);
  const candidateBase = emittedSuffix ? base.slice(0, -emittedSuffix[0].length) : base;
  const candidates = existingCandidates(candidateBase, mutation);
  if (candidates.length === 1) {
    return { status: 'resolved', targetFile: candidates[0], via: 'relative' };
  }
  if (candidates.length > 1) return { status: 'ambiguous', candidates, governingConfigs: [] };
  return { status: 'missing', specifier };
}

function uniqueTargets(targets: readonly ExportTargetV1[]): ExportTargetV1[] {
  const unique = new Map<string, ExportTargetV1>();
  for (const candidate of targets) {
    unique.set(
      `${candidate.filePath}\0${candidate.declarationId ?? candidate.localName}`,
      candidate
    );
  }
  return [...unique.values()].sort((left, right) =>
    `${left.filePath}\0${left.localName}`.localeCompare(`${right.filePath}\0${right.localName}`)
  );
}

function resolveExport(
  filePath: string,
  exportedName: string,
  resolveModule: (fromFile: string, specifier: string) => string | undefined,
  mutation: MutationId | undefined,
  visited: ReadonlySet<string> = new Set(),
  depth = 0
): ExportResolution {
  if (depth > 16) throw new Error('barrel recursion overflow');
  const visitKey = `${filePath}\0${exportedName}`;
  if (mutation !== 'remove-barrel-visited-set' && visited.has(visitKey)) {
    return { status: 'cycle' };
  }
  const nextVisited = new Set(visited).add(visitKey);
  const index = EXPORTS.get(filePath);
  if (!index) return { status: 'missing' };

  const direct = exportedName === 'default' ? index.default : index.named[exportedName];
  const targets = direct ? [...direct] : [];
  let sawCycle = false;

  for (const reexport of index.reexports) {
    if (reexport.exported !== '*' && reexport.exported !== exportedName) continue;
    if (reexport.exported === '*' && exportedName === 'default') continue;
    const targetFile = resolveModule(filePath, reexport.specifier);
    if (!targetFile) continue;
    const importedName = reexport.exported === '*' ? exportedName : reexport.imported;
    const nested = resolveExport(
      targetFile,
      importedName,
      resolveModule,
      mutation,
      nextVisited,
      depth + 1
    );
    if (nested.status === 'resolved') targets.push(nested.target);
    if (nested.status === 'ambiguous') targets.push(...nested.candidates);
    if (nested.status === 'cycle') sawCycle = true;
  }

  const unique = uniqueTargets(targets);
  if (unique.length === 0) return { status: sawCycle ? 'cycle' : 'missing' };
  if (unique.length > 1) return { status: 'ambiguous', candidates: unique };
  return { status: 'resolved', target: unique[0] };
}

function queryArgs(testCase: PhaseCase): {
  importerFile: string;
  specifier: string;
  exportedName: string;
  syntax: string;
} {
  const args = testCase.query?.args ?? {};
  return {
    importerFile: String(args.importerFile),
    specifier: String(args.specifier),
    exportedName: String(args.exportedName),
    syntax: String(args.syntax),
  };
}

function diagnosticForModule(
  resolution: Resolution,
  traversal: boolean
): DiagnosticCode | undefined {
  if (traversal) return 'path-traversal';
  if (!resolution) return 'dynamic-computed';
  if (resolution.status === 'ambiguous') return 'module.ambiguous';
  if (resolution.status === 'external') return 'module.external';
  if (resolution.status === 'missing') return 'module.missing';
  return undefined;
}

function edgeTypeForCase(caseId: string): 'calls' | 'references' {
  const ordinal = Number(caseId.slice(-2));
  return ordinal % 5 === 0 ? 'references' : 'calls';
}

function makeEdge(testCase: PhaseCase, exportTarget: ExportTargetV1): ReturnedEdge {
  const source = `symbol:typescript:src/caller.ts#${testCase.id}`;
  const targetId = `symbol:typescript:${exportTarget.filePath}#${exportTarget.localName}`;
  const type = edgeTypeForCase(testCase.id);
  return {
    id: stableHash({ source, type, target: targetId, producer: 'phase-07-contract' }),
    source,
    type,
    target: targetId,
    confidence: 'framework-inferred',
  };
}

function observeCase(
  testCase: PhaseCase,
  mutation: MutationId | undefined,
  stats: SeamStats
): Observation {
  const args = queryArgs(testCase);
  const computed = args.syntax.startsWith('computed-');
  const traversal = isTraversal(args.importerFile, args.specifier);

  const sharedResolve = (): Resolution => {
    if (computed) return null;
    return resolveLocalModule(args.importerFile, args.specifier, mutation) ?? null;
  };

  stats.astSharedResolverCalls += 1;
  const astResolution = sharedResolve();
  let dependencyResolution: Resolution;
  if (mutation === 'bypass-shared-dependency-resolver') {
    dependencyResolution = {
      status: 'missing',
      specifier: args.specifier,
    };
  } else {
    stats.dependencySharedResolverCalls += 1;
    dependencyResolution = sharedResolve();
  }

  const diagnostics: DiagnosticCode[] = [];
  const edges: ReturnedEdge[] = [];
  const moduleDiagnostic = diagnosticForModule(
    astResolution,
    traversal && mutation !== 'allow-root-traversal'
  );
  if (moduleDiagnostic) diagnostics.push(moduleDiagnostic);

  if (astResolution?.status === 'resolved' && !moduleDiagnostic) {
    try {
      let exported: ExportResolution;
      if (mutation === 'bypass-export-index-ast') {
        exported = {
          status: 'resolved',
          target: target(astResolution.targetFile, args.exportedName),
        };
      } else {
        stats.astExportIndexCalls += 1;
        exported = resolveExport(
          astResolution.targetFile,
          args.exportedName,
          (fromFile, specifier) => {
            const result = resolveLocalModule(fromFile, specifier, mutation);
            return result?.status === 'resolved' ? result.targetFile : undefined;
          },
          mutation
        );
      }

      if (exported.status === 'resolved') edges.push(makeEdge(testCase, exported.target));
      if (exported.status === 'cycle') diagnostics.push('barrel-cycle');
      if (exported.status === 'missing') diagnostics.push('export-missing');
      if (exported.status === 'ambiguous') diagnostics.push('export-conflict');
    } catch {
      diagnostics.push('resolver-overflow');
    }
  }

  if (mutation === 'remove-required-edge' && testCase.id === 'p07-positive-01') edges.length = 0;
  if (mutation === 'insert-forbidden-edge' && testCase.id === 'p07-forbidden-external-package') {
    edges.push({
      id: stableHash({ caseId: testCase.id, mutation }),
      source: `symbol:typescript:src/caller.ts#${testCase.id}`,
      type: 'calls',
      target: `symbol:typescript:forbidden#${testCase.id}`,
      confidence: 'framework-inferred',
    });
  }

  return {
    caseId: testCase.id,
    astResolution,
    dependencyResolution,
    diagnostics,
    edges,
  };
}

function edgeKey(edge: ExpectedEdge | ReturnedEdge): string {
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
  const stats: SeamStats = {
    astSharedResolverCalls: 0,
    dependencySharedResolverCalls: 0,
    astExportIndexCalls: 0,
  };
  const observations = cases.map((testCase) => observeCase(testCase, mutation, stats));
  const failures: string[] = [];
  const expected = cases.flatMap((testCase) => testCase.expectedEdges);
  const returned = observations.flatMap((observation) => observation.edges);
  const available = new Map<string, number>();
  for (const edge of returned)
    available.set(edgeKey(edge), (available.get(edgeKey(edge)) ?? 0) + 1);

  let matched = 0;
  for (const edge of expected) {
    const key = edgeKey(edge);
    const count = available.get(key) ?? 0;
    if (count > 0) {
      matched += 1;
      available.set(key, count - 1);
    }
  }

  const positiveCases = cases.filter((testCase) => testCase.expectedEdges.length > 0).length;
  const forbiddenCases = cases.filter((testCase) => testCase.forbiddenEdges.length > 0).length;
  const recall = expected.length === 0 ? 0 : matched / expected.length;
  const precision = returned.length === 0 ? 0 : matched / returned.length;

  for (const [index, testCase] of cases.entries()) {
    const observation = observations[index];
    if (bytes(observation.astResolution) !== bytes(observation.dependencyResolution)) {
      failures.push(`${testCase.id}: AST/dependency resolution byte mismatch`);
    }
    if (bytes(observation.astResolution) !== bytes(testCase.expectedResolution)) {
      failures.push(`${testCase.id}: resolution contract mismatch`);
    }
    if (testCase.expectedOutcome === 'answered' && observation.edges.length === 0) {
      failures.push(`${testCase.id}: required edge missing`);
    }
    const expectedKeys = testCase.expectedEdges.map(edgeKey).sort();
    const returnedKeys = observation.edges.map(edgeKey).sort();
    if (bytes(expectedKeys) !== bytes(returnedKeys)) {
      failures.push(`${testCase.id}: returned edge set mismatch`);
    }
    if (testCase.expectedOutcome === 'refused' && observation.edges.length > 0) {
      failures.push(`${testCase.id}: refused case emitted edge`);
    }
    if (
      testCase.expectedDiagnostic &&
      !observation.diagnostics.includes(testCase.expectedDiagnostic)
    ) {
      failures.push(`${testCase.id}: missing diagnostic ${testCase.expectedDiagnostic}`);
    }
    for (const forbidden of testCase.forbiddenEdges) {
      if (observation.edges.some((edge) => forbiddenMatches(edge, forbidden))) {
        failures.push(`${testCase.id}: forbidden edge returned`);
      }
    }
  }

  const thresholds = cases[0]?.thresholds;
  if (!thresholds || positiveCases < thresholds.minPositiveCases) {
    failures.push(`battery: positive cases ${positiveCases} below minimum`);
  }
  if (!thresholds || forbiddenCases < thresholds.minForbiddenCases) {
    failures.push(`battery: forbidden cases ${forbiddenCases} below minimum`);
  }
  if (!thresholds || recall < thresholds.minRecall) failures.push(`battery: recall ${recall}`);
  if (!thresholds || precision < thresholds.minPrecision)
    failures.push(`battery: precision ${precision}`);

  const edgeIds = returned.map((edge) => edge.id).sort();
  const digest = stableHash({ observations, edgeIds });
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    recall,
    precision,
    positiveCases,
    forbiddenCases,
    failures,
    observations,
    edgeIds,
    digest,
    stats,
  };
}

describe('Phase 7 independent relative/default/barrel resolution acceptance', () => {
  it('pins the frozen contract and carries the exact virtual fixture layout', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(48);
    expect(cases.every((testCase) => testCase.fixtureSchemaVersion === 1)).toBe(true);
    expect(cases.every((testCase) => testCase.corpusPin.commit === FROZEN_CONTRACT)).toBe(true);
    expect(cases[0].fixture?.rootPath).toBe('.');
    expect(cases[0].fixture?.layout).toEqual(EXPECTED_LAYOUT);
    expect(cases.every((testCase) => !bytes(testCase).includes(process.cwd()))).toBe(true);
  });

  it('scores 32 positives and 16 forbidden cases at 1.0 precision and recall', () => {
    const result = runBattery(loadCases());
    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.positiveCases).toBeGreaterThanOrEqual(30);
    expect(result.forbiddenCases).toBeGreaterThanOrEqual(15);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
  });

  it('uses one shared resolver for byte-equal AST and dependency consumer results', () => {
    const cases = loadCases();
    const result = runBattery(cases);
    for (const observation of result.observations) {
      expect(Buffer.from(bytes(observation.astResolution))).toEqual(
        Buffer.from(bytes(observation.dependencyResolution))
      );
    }
    expect(result.stats.astSharedResolverCalls).toBe(cases.length);
    expect(result.stats.dependencySharedResolverCalls).toBe(cases.length);
    expect(result.stats.astExportIndexCalls).toBeGreaterThan(30);
  });

  it('diagnoses every refused ambiguity/external/missing/traversal/cycle/dynamic/conflict case without an edge', () => {
    const cases = loadCases();
    const result = runBattery(cases);
    const refused = new Map(
      result.observations
        .filter((observation) => observation.caseId.includes('forbidden'))
        .map((observation) => [observation.caseId, observation])
    );
    expect([...refused.values()].every((observation) => observation.edges.length === 0)).toBe(true);
    expect([...refused.values()].flatMap((observation) => observation.diagnostics)).toEqual(
      expect.arrayContaining([
        'module.ambiguous',
        'module.external',
        'module.missing',
        'path-traversal',
        'barrel-cycle',
        'dynamic-computed',
        'export-conflict',
      ])
    );
  });

  it('produces byte-identical edge IDs and digests across two clean rebuilds', () => {
    const first = runBattery(loadCases());
    const second = runBattery(loadCases());
    expect(Buffer.from(bytes(first.edgeIds))).toEqual(Buffer.from(bytes(second.edgeIds)));
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.digest).toBe(second.digest);
    expect(new Set(first.edgeIds).size).toBe(first.edgeIds.length);
  });

  it('records every required watched-red control with a nonzero checker exit and named case', () => {
    const cases = loadCases();
    const controls = cases.flatMap((testCase) => testCase.watchedMutations ?? []);
    expect(controls.map((control) => control.id)).toEqual([
      'reverse-ts-js-candidate-order',
      'bypass-export-index-ast',
      'bypass-shared-dependency-resolver',
      'remove-barrel-visited-set',
      'allow-root-traversal',
      'insert-forbidden-edge',
      'remove-required-edge',
    ]);

    for (const control of controls) {
      const result = runBattery(cases, control.id);
      expect(result.exitCode, control.id).toBe(control.expectedCheckerExitCode);
      expect(
        result.failures.some((failure) => failure.startsWith(`${control.expectedCase}:`)),
        `${control.id} must identify ${control.expectedCase}; got ${result.failures.join(', ')}`
      ).toBe(true);
    }
  });
});
