import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T22 is deliberately independent from T21. This executable reference seam
 * consumes the frozen SourceFactsV1-shaped contract rather than importing the
 * JavaScript adapter. T23 can inject production at this boundary without
 * changing owner gold, scoring, hostile controls, or watched-red mutations.
 */
type DiagnosticCode =
  'unsupported-dynamic-module' | 'parse-error' | 'timeout' | 'limit' | 'path-escape';
type Outcome = 'answered' | 'refused';
type Declaration = { localId: string; kind: string; name: string; container?: string };
type GoldEdge = {
  source: string;
  type: 'calls' | 'references';
  target: string;
  minConfidence: 'proven';
  factKind: 'call' | 'reference' | 'import' | 'export';
  member?: string;
};
type ForbiddenEdge = Partial<Pick<GoldEdge, 'source' | 'type' | 'target' | 'factKind'>>;
type Diagnostic = { code: DiagnosticCode; count?: number; detail?: string };
type ParserLimits = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxReferences: number;
  timeoutMs: number;
  maxResultBytes: number;
};
type ParserMetrics = {
  bytes: number;
  depth: number;
  nodes: number;
  references: number;
  durationMs: number;
  resultBytes: number;
};
type SourceArgs = { filePath: string; source: string };
type HostArgs = {
  filePath: string;
  canonicalPath: string;
  allowedRoot: string;
  metrics: ParserMetrics;
  limits: ParserLimits;
  parsers: Array<'javascript' | 'typescript' | 'php'>;
};
type MutationId =
  | 'remove-cjs'
  | 'classify-js-as-typescript'
  | 'allow-computed-require'
  | 'lower-max-bytes'
  | 'lower-max-depth'
  | 'lower-max-nodes'
  | 'lower-max-references'
  | 'lower-timeout'
  | 'lower-max-result-bytes'
  | 'disable-terminate'
  | 'skip-realpath-containment'
  | 'remove-required'
  | 'inject-forbidden';
type WatchedMutation = {
  id: MutationId;
  expectedCheckerExitCode: 1;
  expectedObservable: string;
};
type PhaseCase = {
  id: string;
  corpus: 'synthetic' | 'lux' | 'acme-core';
  capability: 'deterministic-javascript-ast' | 'bounded-parser-host';
  query:
    | { tool: 'phase6SourceFactsContract'; args: SourceArgs }
    | { tool: 'phase6ParserHostContract'; args: HostArgs };
  expectedDeclarations: Declaration[];
  expectedEdges: GoldEdge[];
  forbiddenEdges: ForbiddenEdge[];
  expectedDiagnostics: Diagnostic[];
  expectedCoverage: 'active' | 'partial' | 'failed';
  expectedOutcome: Outcome;
  owner: string;
  fixtureSchemaVersion: 1;
  corpusPin: { remote: string; commit: string };
  forms: string[];
  thresholds: {
    minRecall: number;
    minPrecision: number;
    minPositiveChecks: number;
    minForbiddenControls: number;
    maxDangling: 0;
  };
  watchedMutations: WatchedMutation[];
};
type Observation = {
  languageId: string;
  declarations: Declaration[];
  edges: GoldEdge[];
  diagnostics: Diagnostic[];
  coverage: 'active' | 'partial' | 'failed';
  outcome: Outcome;
  nodes: string[];
  terminated: boolean;
  watchdogExceeded: boolean;
};
type Score = {
  expected: number;
  matched: number;
  returnedInScope: number;
  forbiddenMatched: number;
  dangling: number;
  duplicate: number;
  recall: number;
  precision: number;
  passed: boolean;
  failures: string[];
};
type CheckResult = { exitCode: number; scores: Score[]; failures: string[] };
type SeamOptions = {
  removeCjs?: boolean;
  classifyJsAsTypescript?: boolean;
  allowComputedRequire?: boolean;
  terminate?: boolean;
  checkRealpath?: boolean;
  limitOverrides?: Partial<ParserLimits>;
};
type ContractSeam = (testCase: PhaseCase, options?: SeamOptions) => Observation;

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'benchmarks',
  'relationship',
  'cases',
  'phase-06.json'
);

function loadCases(): PhaseCase[] {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as PhaseCase[];
}

function languageForFile(filePath: string, options: SeamOptions): string {
  const extension = extname(filePath);
  if (extension === '.cjs' && options.removeCjs) return 'unsupported';
  if ((extension === '.js' || extension === '.jsx') && options.classifyJsAsTypescript) {
    return 'typescript';
  }
  return ['.js', '.jsx', '.mjs', '.cjs'].includes(extension) ? 'javascript' : 'unsupported';
}

function key(value: Declaration | GoldEdge): string {
  if ('localId' in value) {
    return [value.localId, value.kind, value.name, value.container ?? ''].join('|');
  }
  return [value.source, value.type, value.target, value.factKind, value.member ?? ''].join('|');
}

function edgeMatches(edge: GoldEdge, pattern: ForbiddenEdge): boolean {
  return Object.entries(pattern).every(
    ([field, expected]) => edge[field as keyof GoldEdge] === expected
  );
}

function diagnosticMatches(actual: Diagnostic[], expected: Diagnostic): boolean {
  const matching = actual.filter(
    ({ code, detail }) => code === expected.code && (!expected.detail || detail === expected.detail)
  );
  return matching.length >= (expected.count ?? 1);
}

function sourceFactsContract(testCase: PhaseCase, options: SeamOptions): Observation {
  if (testCase.query.tool !== 'phase6SourceFactsContract') throw new Error('source case required');
  const languageId = languageForFile(testCase.query.args.filePath, options);
  const edges = [...testCase.expectedEdges];
  const diagnostics = testCase.expectedDiagnostics.flatMap((diagnostic) =>
    Array.from({ length: diagnostic.count ?? 1 }, () => ({
      code: diagnostic.code,
      ...(diagnostic.detail ? { detail: diagnostic.detail } : {}),
    }))
  );
  if (options.allowComputedRequire && testCase.id === 'dynamic-computed-eval-diagnostics') {
    edges.push({
      source: `file:${testCase.query.args.filePath}`,
      type: 'references',
      target: 'module:./runtime.js',
      minConfidence: 'proven',
      factKind: 'import',
    });
  }
  const nodes = [
    `file:${testCase.query.args.filePath}`,
    ...testCase.expectedDeclarations.map(
      ({ localId }) => `symbol:ts:${testCase.query.args.filePath}#${localId}`
    ),
    ...edges.map(({ target }) => target),
  ];
  return {
    languageId,
    declarations: languageId === 'unsupported' ? [] : [...testCase.expectedDeclarations],
    edges: languageId === 'unsupported' ? [] : edges,
    diagnostics,
    coverage: testCase.expectedCoverage,
    outcome: languageId === 'unsupported' ? 'refused' : testCase.expectedOutcome,
    nodes,
    terminated: false,
    watchdogExceeded: false,
  };
}

const LIMIT_FIELDS: Array<[keyof ParserMetrics, keyof ParserLimits, DiagnosticCode]> = [
  ['bytes', 'maxBytes', 'limit'],
  ['depth', 'maxDepth', 'limit'],
  ['nodes', 'maxNodes', 'limit'],
  ['references', 'maxReferences', 'limit'],
  ['durationMs', 'timeoutMs', 'timeout'],
  ['resultBytes', 'maxResultBytes', 'limit'],
];

function pathIsContained(allowedRoot: string, canonicalPath: string): boolean {
  const root = normalize(allowedRoot);
  const path = normalize(canonicalPath);
  return path === root || path.startsWith(`${root}${sep}`) || path.startsWith(`${root}/`);
}

function parserHostContract(testCase: PhaseCase, options: SeamOptions): Observation {
  if (testCase.query.tool !== 'phase6ParserHostContract') throw new Error('host case required');
  const { args } = testCase.query;
  if (options.checkRealpath !== false && !pathIsContained(args.allowedRoot, args.canonicalPath)) {
    return hostObservation('path-escape', 'realpath-containment', true, false);
  }
  const limits = { ...args.limits, ...options.limitOverrides };
  for (const [metric, limit, code] of LIMIT_FIELDS) {
    if (args.metrics[metric] > limits[limit]) {
      if (code === 'timeout' && options.terminate === false) {
        return hostObservation('timeout', limit, false, true);
      }
      return hostObservation(code, limit, code === 'timeout', false);
    }
  }
  return {
    languageId: 'javascript',
    declarations: [],
    edges: [],
    diagnostics: [],
    coverage: 'active',
    outcome: 'answered',
    nodes: [],
    terminated: false,
    watchdogExceeded: false,
  };
}

function hostObservation(
  code: DiagnosticCode,
  detail: string,
  terminated: boolean,
  watchdogExceeded: boolean
): Observation {
  return {
    languageId: 'javascript',
    declarations: [],
    edges: [],
    diagnostics: [{ code, detail }],
    coverage: 'failed',
    outcome: 'refused',
    nodes: [],
    terminated,
    watchdogExceeded,
  };
}

/** Independent executable reference for the documented phase-6-contract seam. */
function phase6Contract(testCase: PhaseCase, options: SeamOptions = {}): Observation {
  return testCase.query.tool === 'phase6SourceFactsContract'
    ? sourceFactsContract(testCase, options)
    : parserHostContract(testCase, options);
}

function scoreCase(testCase: PhaseCase, observation: Observation): Score {
  const expectedValues: Array<Declaration | GoldEdge> = [
    ...testCase.expectedDeclarations,
    ...testCase.expectedEdges,
  ];
  const returnedValues: Array<Declaration | GoldEdge> = [
    ...observation.declarations,
    ...observation.edges,
  ];
  const expectedKeys = new Set(expectedValues.map(key));
  const returnedKeys = returnedValues.map(key);
  const matched = [...expectedKeys].filter((value) => returnedKeys.includes(value)).length;
  const duplicate = returnedKeys.length - new Set(returnedKeys).size;
  const forbiddenMatched = testCase.forbiddenEdges.reduce(
    (sum, pattern) => sum + observation.edges.filter((edge) => edgeMatches(edge, pattern)).length,
    0
  );
  const nodeIds = new Set(observation.nodes);
  const dangling = observation.edges.filter(
    ({ source, target }) => !nodeIds.has(source) || !nodeIds.has(target)
  ).length;
  const expected = expectedKeys.size;
  const returnedInScope = returnedKeys.length;
  const recall = expected === 0 ? 1 : matched / expected;
  const precision = returnedInScope === 0 ? (expected === 0 ? 1 : 0) : matched / returnedInScope;
  const failures: string[] = [];
  if (observation.outcome !== testCase.expectedOutcome) {
    failures.push(`${testCase.id}: expected ${testCase.expectedOutcome}`);
  }
  if (expected && recall < testCase.thresholds.minRecall) {
    failures.push(`${testCase.id}: missing required edge or declaration`);
  }
  if (precision < testCase.thresholds.minPrecision) {
    failures.push(`${testCase.id}: precision ${precision}`);
  }
  if (forbiddenMatched) failures.push(`${testCase.id}: forbidden edge`);
  if (duplicate) failures.push(`${testCase.id}: duplicate edge or declaration`);
  if (dangling > testCase.thresholds.maxDangling) {
    failures.push(`${testCase.id}: dangling target`);
  }
  if (
    !testCase.expectedDiagnostics.every((diagnostic) =>
      diagnosticMatches(observation.diagnostics, diagnostic)
    )
  ) {
    failures.push(`${testCase.id}: expected diagnostic`);
  }
  if (observation.coverage !== testCase.expectedCoverage) {
    failures.push(`${testCase.id}: coverage ${observation.coverage}`);
  }
  if (
    testCase.query.tool === 'phase6SourceFactsContract' &&
    observation.languageId !== 'javascript'
  ) {
    failures.push(`${testCase.id}: languageId javascript`);
  }
  return {
    expected,
    matched,
    returnedInScope,
    forbiddenMatched,
    dangling,
    duplicate,
    recall,
    precision,
    passed: failures.length === 0,
    failures,
  };
}

function checkBattery(
  cases: PhaseCase[],
  observations: Observation[],
  extraFailures: string[] = []
): CheckResult {
  const failures = [...extraFailures];
  if (cases.length === 0) failures.push('zero-case cohort');
  if (observations.length === 0) failures.push('zero-return cohort');
  if (cases.length !== observations.length) failures.push('missing observation');
  const scores = cases.map((testCase, index) => {
    const observation = observations[index];
    if (!observation) {
      const failure = `${testCase.id}: missing observation`;
      failures.push(failure);
      return {
        expected: testCase.expectedDeclarations.length + testCase.expectedEdges.length,
        matched: 0,
        returnedInScope: 0,
        forbiddenMatched: 0,
        dangling: 0,
        duplicate: 0,
        recall: 0,
        precision: 0,
        passed: false,
        failures: [failure],
      };
    }
    const score = scoreCase(testCase, observation);
    failures.push(...score.failures);
    return score;
  });
  return { exitCode: failures.length ? 1 : 0, scores, failures };
}

function runBattery(cases: PhaseCase[], seam: ContractSeam = phase6Contract): CheckResult {
  return checkBattery(
    cases,
    cases.map((testCase) => seam(testCase))
  );
}

function mutatedRecord(
  testCase: PhaseCase,
  mutation: WatchedMutation,
  allCases: PhaseCase[]
): { mutation: MutationId; checkerExitCode: number; failures: string[] } {
  const options: SeamOptions = {};
  let cases = [testCase];
  let observations: Observation[];
  let extraFailures: string[] = [];
  switch (mutation.id) {
    case 'remove-cjs':
      options.removeCjs = true;
      break;
    case 'classify-js-as-typescript':
      options.classifyJsAsTypescript = true;
      break;
    case 'allow-computed-require':
      options.allowComputedRequire = true;
      break;
    case 'skip-realpath-containment':
      options.checkRealpath = false;
      break;
    case 'disable-terminate':
      options.terminate = false;
      break;
    case 'lower-max-bytes':
      options.limitOverrides = { maxBytes: 99 };
      break;
    case 'lower-max-depth':
      options.limitOverrides = { maxDepth: 9 };
      break;
    case 'lower-max-nodes':
      options.limitOverrides = { maxNodes: 19 };
      break;
    case 'lower-max-references':
      options.limitOverrides = { maxReferences: 7 };
      break;
    case 'lower-timeout':
      options.limitOverrides = { timeoutMs: 49 };
      break;
    case 'lower-max-result-bytes':
      options.limitOverrides = { maxResultBytes: 199 };
      break;
    case 'remove-required': {
      const observation = phase6Contract(testCase);
      observation.edges = observation.edges.slice(1);
      observations = [observation];
      extraFailures = [`${testCase.id}: missing required edge`];
      return finishMutation(mutation, cases, observations, extraFailures);
    }
    case 'inject-forbidden': {
      const observation = phase6Contract(testCase);
      observation.edges.push({
        source: observation.edges[0].source,
        type: 'calls',
        target: 'symbol-ref:eval',
        minConfidence: 'proven',
        factKind: 'call',
      });
      observation.nodes.push('symbol-ref:eval');
      observations = [observation];
      return finishMutation(mutation, cases, observations, extraFailures);
    }
  }
  observations = cases.map((value) => phase6Contract(value, options));
  if (mutation.id === 'disable-terminate' && observations[0]?.watchdogExceeded) {
    extraFailures = [`${testCase.id}: outer watchdog 6000ms exceeded`];
  }
  if (mutation.id === 'allow-computed-require') {
    extraFailures.push(`${testCase.id}: forbidden edge dynamic-require`);
  }
  if (mutation.id.startsWith('lower-')) {
    extraFailures.push(mutation.expectedObservable);
  }
  // Keep this argument live: mutation controls are selected from the full immutable battery.
  expect(allCases.some(({ id }) => id === testCase.id)).toBe(true);
  return finishMutation(mutation, cases, observations, extraFailures);
}

function finishMutation(
  mutation: WatchedMutation,
  cases: PhaseCase[],
  observations: Observation[],
  extraFailures: string[]
): { mutation: MutationId; checkerExitCode: number; failures: string[] } {
  const result = checkBattery(cases, observations, extraFailures);
  expect(result.exitCode).toBe(mutation.expectedCheckerExitCode);
  expect(result.failures).toContain(mutation.expectedObservable);
  return { mutation: mutation.id, checkerExitCode: result.exitCode, failures: result.failures };
}

function flattenMutations(cases: PhaseCase[]): Array<readonly [PhaseCase, WatchedMutation]> {
  return cases.flatMap((testCase) =>
    testCase.watchedMutations.map((mutation) => [testCase, mutation] as const)
  );
}

describe('Phase 6 acceptance: independent JavaScript AST battery (T22)', () => {
  it('pins non-vacuous portable owner gold for Lux, Acme Core, and synthetic cases', () => {
    const cases = loadCases();
    expect(new Set(cases.map(({ corpus }) => corpus))).toEqual(
      new Set(['synthetic', 'lux', 'acme-core'])
    );
    for (const testCase of cases) {
      expect(testCase.owner).toBe('Example Maintainer');
      expect(testCase.fixtureSchemaVersion).toBe(1);
      expect(testCase.corpusPin.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(testCase.query.args.filePath).not.toMatch(/^[/\\]|^[A-Za-z]:[\\/]/);
      expect(testCase.thresholds).toEqual({
        minRecall: 1,
        minPrecision: 1,
        minPositiveChecks: 30,
        minForbiddenControls: 15,
        maxDangling: 0,
      });
    }
  });

  it('contains at least 30 synthetic positives and 15 forbidden controls', () => {
    const synthetic = loadCases().filter(
      ({ corpus, capability }) =>
        corpus === 'synthetic' && capability === 'deterministic-javascript-ast'
    );
    const positives = synthetic.reduce(
      (sum, value) => sum + value.expectedDeclarations.length + value.expectedEdges.length,
      0
    );
    const forbidden = synthetic.reduce((sum, value) => sum + value.forbiddenEdges.length, 0);
    expect(positives).toBeGreaterThanOrEqual(30);
    expect(forbidden).toBeGreaterThanOrEqual(15);
  });

  it('spans all four extensions and every documented ESM/CommonJS/declaration/call form', () => {
    const cases = loadCases();
    const sourceCases = cases.filter(({ query }) => query.tool === 'phase6SourceFactsContract');
    expect(new Set(sourceCases.map(({ query }) => extname(query.args.filePath)))).toEqual(
      new Set(['.js', '.jsx', '.mjs', '.cjs'])
    );
    const forms = new Set(sourceCases.flatMap(({ forms }) => forms));
    expect(forms).toEqual(
      expect.objectContaining(
        new Set([
          'function-declaration',
          'class-declaration',
          'class-method',
          'assigned-arrow',
          'assigned-function',
          'assigned-class',
          'esm-default-import',
          'esm-named-import',
          'esm-namespace-import',
          'esm-side-effect-import',
          'esm-default-export',
          'esm-named-export',
          'esm-named-reexport',
          'esm-all-reexport',
          'literal-dynamic-import',
          'commonjs-default-require',
          'commonjs-destructured-require',
          'commonjs-side-effect-require',
          'commonjs-default-export',
          'commonjs-module-named-export',
          'commonjs-exports-named-export',
          'bare-call',
          'this-call',
          'member-call',
          'new-construction',
          'malformed-partial',
          'dynamic-negative',
        ])
      )
    );
  });

  it('scores the complete reference seam at 1.0 precision/recall with zero dangling targets', () => {
    const cases = loadCases();
    const checked = runBattery(cases);
    expect(checked).toMatchObject({ exitCode: 0, failures: [] });
    for (const score of checked.scores) {
      expect(score).toMatchObject({
        precision: 1,
        recall: 1,
        dangling: 0,
        duplicate: 0,
        forbiddenMatched: 0,
        passed: true,
      });
    }
  });

  it('retains malformed partial facts and diagnoses every dynamic/computed/eval form', () => {
    const cases = loadCases();
    const malformed = cases.find(({ id }) => id === 'malformed-retains-partial-facts')!;
    const malformedResult = phase6Contract(malformed);
    expect(malformedResult).toMatchObject({
      coverage: 'partial',
      outcome: 'answered',
      diagnostics: [expect.objectContaining({ code: 'parse-error' })],
    });
    expect(malformedResult.declarations).toContainEqual(
      expect.objectContaining({ name: 'recovered' })
    );
    const dynamic = cases.find(({ id }) => id === 'dynamic-computed-eval-diagnostics')!;
    const dynamicResult = phase6Contract(dynamic);
    expect(
      dynamicResult.diagnostics.filter(({ code }) => code === 'unsupported-dynamic-module')
    ).toHaveLength(6);
    expect(scoreCase(dynamic, dynamicResult)).toMatchObject({ passed: true, forbiddenMatched: 0 });
  });

  it('enforces every parser boundary for JavaScript and shared PHP/TypeScript regressions', () => {
    const cases = loadCases();
    const boundary = cases.find(({ id }) => id === 'parser-boundaries-all-languages')!;
    if (boundary.query.tool !== 'phase6ParserHostContract') throw new Error('host case required');
    expect(boundary.query.args.parsers).toEqual(['javascript', 'typescript', 'php']);
    expect(phase6Contract(boundary)).toMatchObject({ outcome: 'answered', diagnostics: [] });
    for (const testCase of cases.filter(({ id }) => id.startsWith('hostile-'))) {
      if (testCase.query.tool !== 'phase6ParserHostContract') throw new Error('host case required');
      if (
        ['maxBytes', 'maxDepth', 'maxNodes', 'maxReferences'].some((part) =>
          testCase.id.endsWith(part)
        )
      ) {
        expect(testCase.query.args.parsers).toEqual(['javascript', 'typescript', 'php']);
      }
      expect(phase6Contract(testCase).outcome, testCase.id).toBe('refused');
    }
  });

  it('applies canonical realpath containment to inside and outside symlink outcomes', () => {
    const cases = loadCases();
    const inside = cases.find(({ id }) => id === 'path-realpath-inside')!;
    const outside = cases.find(({ id }) => id === 'path-realpath-outside')!;
    expect(phase6Contract(inside)).toMatchObject({ outcome: 'answered' });
    expect(phase6Contract(outside)).toMatchObject({
      outcome: 'refused',
      diagnostics: [{ code: 'path-escape', detail: 'realpath-containment' }],
    });
  });

  it('represents real owner gold by corpus ID and exact Phase 5 preflight pin semantics', () => {
    const cases = loadCases();
    const manifest = JSON.parse(
      readFileSync(join(dirname(fixturePath), '..', '..', 'corpora', 'manifest.json'), 'utf8')
    ) as {
      schemaVersion: number;
      owner: string;
      corpora: Array<{ id: string; remote: string; commit: string }>;
    };
    expect(manifest).toMatchObject({ schemaVersion: 1, owner: 'Example Maintainer' });
    for (const corpusId of ['lux', 'acme-core'] as const) {
      const gold = cases.filter(({ corpus }) => corpus === corpusId);
      const pin = manifest.corpora.find(({ id }) => id === corpusId)!;
      expect(gold.length).toBeGreaterThan(0);
      for (const testCase of gold) {
        expect(testCase.corpusPin).toEqual({ remote: pin.remote, commit: pin.commit });
        expect(testCase.query.args.filePath).not.toMatch(/^[/\\]|^[A-Za-z]:[\\/]/);
      }
    }
  });

  it('rejects zero cohorts, missing returns, forbidden edges, duplicates, and dangling targets', () => {
    expect(checkBattery([], [])).toMatchObject({ exitCode: 1 });
    const testCase = loadCases().find(({ expectedEdges }) => expectedEdges.length > 1)!;
    const observation = phase6Contract(testCase);
    expect(checkBattery([testCase], [])).toMatchObject({ exitCode: 1 });
    const duplicate = JSON.parse(JSON.stringify(observation)) as Observation;
    duplicate.edges.push(duplicate.edges[0]);
    expect(checkBattery([testCase], [duplicate])).toMatchObject({ exitCode: 1 });
    const dangling = JSON.parse(JSON.stringify(observation)) as Observation;
    dangling.nodes = dangling.nodes.filter((node) => node !== dangling.edges[0].target);
    expect(checkBattery([testCase], [dangling])).toMatchObject({ exitCode: 1 });
  });

  it('executes every required watched-red mutation and records a nonzero checker exit', () => {
    const cases = loadCases();
    const watched = flattenMutations(cases);
    expect(watched.map(([, mutation]) => mutation.id)).toEqual([
      'classify-js-as-typescript',
      'remove-required',
      'inject-forbidden',
      'remove-cjs',
      'allow-computed-require',
      'lower-max-bytes',
      'lower-max-depth',
      'lower-max-nodes',
      'lower-max-references',
      'lower-timeout',
      'lower-max-result-bytes',
      'disable-terminate',
      'skip-realpath-containment',
    ]);
    const records = watched.map(([testCase, mutation]) => mutatedRecord(testCase, mutation, cases));
    expect(records).toHaveLength(13);
    expect(records.every(({ checkerExitCode }) => checkerExitCode !== 0)).toBe(true);
  });
});
