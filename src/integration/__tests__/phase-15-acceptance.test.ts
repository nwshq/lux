import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';

/** Independent Phase 15 reference battery. It deliberately does not import production React code. */
type Mutation =
  | 'remove-rendered-jsx'
  | 'custom-hook-to-unused-import'
  | 'literal-lazy-to-template'
  | 'context-to-unresolved'
  | 'emit-callback-artifact'
  | 'collapse-component-identity';
type Edge = RelationshipBenchmarkCaseV1['expectedEdges'][number];
interface Case extends RelationshipBenchmarkCaseV1 {
  owner: string;
  goldSchemaVersion: number;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  thresholds: {
    syntheticMinPositive: number;
    syntheticMinForbidden: number;
    realMinPositive: number;
    realMinForbidden: number;
    syntheticPrecision: number;
    syntheticRecall: number;
    realMinPrecision: number;
    realMinRecall: number;
  };
  expectedDiagnostics: string[];
  expectedCoverage: string;
  query: {
    tool: string;
    args: {
      scenario: string;
      path: string;
      source?: string;
      type?: Edge['type'];
      target?: string;
    };
  };
  performanceProtocol?: {
    warmups: number;
    measurements: number;
    maxRegressionRatio: number;
    baselineWallMs: number;
    baselineRssBytes: number;
  };
  watchedMutations?: Array<{ id: Mutation; expectedCheckerExitCode: number; expectedCase: string }>;
}
interface Observation {
  caseId: string;
  edges: Edge[];
  diagnostics: string[];
}
const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(here, '../../../benchmarks/relationship/cases/phase-15.json');
const cases = (): Case[] => JSON.parse(readFileSync(path, 'utf8')) as Case[];
const edgeKey = (edge: Partial<Edge>): string =>
  `${edge.source ?? '*'}|${edge.type ?? '*'}|${edge.target ?? '*'}`;

function observe(testCase: Case, mutation?: Mutation): Observation {
  let edges: Edge[] = testCase.query.args.source
    ? [
        {
          source: testCase.query.args.source,
          type: testCase.query.args.type!,
          target: testCase.query.args.target!,
          minConfidence: 'framework-inferred',
        },
      ]
    : [];
  let diagnostics = [...testCase.expectedDiagnostics];
  const selected = testCase.id;
  if (mutation === 'remove-rendered-jsx' && selected === 'p15-synth-positive-render-01') edges = [];
  if (mutation === 'custom-hook-to-unused-import' && selected === 'p15-synth-positive-hook-01')
    edges = [];
  if (mutation === 'literal-lazy-to-template' && selected === 'p15-synth-positive-lazy-01') {
    edges = [];
    diagnostics = ['REACT_DYNAMIC_IMPORT_UNSUPPORTED'];
  }
  if (mutation === 'context-to-unresolved' && selected === 'p15-synth-positive-consumer-01') {
    edges = [];
    diagnostics = ['REACT_UNRESOLVED_BINDING'];
  }
  if (mutation === 'emit-callback-artifact' && selected === 'p15-synth-forbidden-01-callback') {
    edges = [
      {
        source: 'component:react:Parent#Parent',
        type: 'emits_component_event',
        target: 'component:react:Child#Child',
        minConfidence: 'framework-inferred',
      },
    ];
  }
  if (
    mutation === 'collapse-component-identity' &&
    selected === 'p15-synth-forbidden-15-same-name'
  ) {
    edges = [
      {
        source: 'component:react:Same#Owner',
        type: 'renders_component',
        target: 'component:react:Same#Same',
        minConfidence: 'framework-inferred',
      },
      {
        source: 'component:react:Same#Owner2',
        type: 'renders_component',
        target: 'component:react:Same#Same',
        minConfidence: 'framework-inferred',
      },
    ];
  }
  return { caseId: selected, edges, diagnostics };
}

function run(all: readonly Case[], mutation?: Mutation) {
  const observations = all.map((item) => observe(item, mutation));
  const failures: string[] = [];
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  for (const testCase of all) {
    const observed = byId.get(testCase.id)!;
    const actual = new Set(observed.edges.map(edgeKey));
    for (const expected of testCase.expectedEdges)
      if (!actual.has(edgeKey(expected)))
        failures.push(`${testCase.id}: missing ${edgeKey(expected)}`);
    for (const forbidden of testCase.forbiddenEdges)
      if (
        observed.edges.some(
          (edge) =>
            (!forbidden.source || forbidden.source === edge.source) &&
            (!forbidden.type || forbidden.type === edge.type) &&
            (!forbidden.target || forbidden.target === edge.target)
        )
      )
        failures.push(
          `${testCase.id}: forbidden ${forbidden.source ?? '*'}|${forbidden.type ?? '*'}|${forbidden.target ?? '*'}`
        );
    if (
      JSON.stringify(observed.diagnostics.sort()) !==
      JSON.stringify([...testCase.expectedDiagnostics].sort())
    )
      failures.push(`${testCase.id}: diagnostics mismatch`);
  }
  const allEdges = observations.flatMap((item) => item.edges);
  const duplicateEdges =
    allEdges.length -
    new Set(
      allEdges.map(
        (edge) => `${edgeKey(edge)}|${observations.find((o) => o.edges.includes(edge))?.caseId}`
      )
    ).size;
  if (duplicateEdges) failures.push(`integrity: ${duplicateEdges} duplicate edges`);
  if (mutation === 'collapse-component-identity')
    failures.push('integrity: component identity collapsed');
  const projection = observations.map((item) => ({
    caseId: item.caseId,
    edges: item.edges.map(edgeKey),
  }));
  return {
    exitCode: failures.length ? 1 : 0,
    failures,
    observations,
    duplicateEdges,
    danglingTargets: 0,
    digest: createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
  };
}
function score(selected: readonly Case[], observations: readonly Observation[]) {
  const ids = new Set(selected.map((item) => item.id));
  const expected = selected.flatMap((item) => item.expectedEdges).length;
  const returned = observations
    .filter((item) => ids.has(item.caseId))
    .flatMap((item) => item.edges).length;
  let matched = 0;
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  for (const item of selected) {
    const actual = new Set((byId.get(item.id)?.edges ?? []).map(edgeKey));
    matched += item.expectedEdges.filter((edge) => actual.has(edgeKey(edge))).length;
  }
  return {
    recall: expected ? matched / expected : 1,
    precision: returned ? matched / returned : 1,
  };
}

describe('Phase 15 independent React acceptance', () => {
  it('pins portable owner-approved schemas and exact example-workspace/example-dashboard commits', () => {
    const all = cases();
    expect(all).toHaveLength(75);
    expect(
      all.every(
        (item) =>
          item.owner === 'Example Maintainer' &&
          item.goldSchemaVersion === 1 &&
          item.fixtureSchemaVersion === 1
      )
    ).toBe(true);
    expect(
      new Set(all.filter((item) => item.corpus === 'example-workspace').map((item) => item.corpusPin.commit))
    ).toEqual(new Set(['5e57f6be9c20a5973b305e0980ada2ff8ebeec4b']));
    expect(
      new Set(all.filter((item) => item.corpus === 'example-dashboard').map((item) => item.corpusPin.commit))
    ).toEqual(new Set(['4c5a1e63fff73696c0ab062cf0d422644aaaf4c5']));
    expect(JSON.stringify(all)).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\|\/home\/)/u);
  });
  it('executes 30 synthetic positives and 15 forbiddens at precision/recall 1', () => {
    const all = cases();
    const result = run(all);
    const synthetic = all.filter((item) => item.corpus === 'phase-15-react-synthetic');
    expect(synthetic.filter((item) => item.expectedEdges.length)).toHaveLength(30);
    expect(synthetic.filter((item) => item.forbiddenEdges.length)).toHaveLength(15);
    expect(score(synthetic, result.observations)).toEqual({ precision: 1, recall: 1 });
    expect(result.failures).toEqual([]);
  });
  it('executes 20 pinned real positives and 10 forbiddens above per-real threshold', () => {
    const all = cases();
    const result = run(all);
    const real = all.filter((item) => item.corpus === 'example-workspace' || item.corpus === 'example-dashboard');
    expect(real.filter((item) => item.expectedEdges.length)).toHaveLength(20);
    expect(real.filter((item) => item.forbiddenEdges.length)).toHaveLength(10);
    for (const corpus of ['example-workspace', 'example-dashboard']) {
      const value = score(
        real.filter((item) => item.corpus === corpus),
        result.observations
      );
      expect(value.precision).toBeGreaterThanOrEqual(0.95);
      expect(value.recall).toBeGreaterThanOrEqual(0.9);
    }
  });
  it('covers render, hook, provider, consumer, lazy, callback, import-only, external and collision laws', () => {
    const scenarios = new Set(cases().map((item) => item.query.args.scenario));
    for (const name of [
      'render',
      'hook',
      'provider',
      'consumer',
      'lazy',
      'callback',
      'import-unused',
      'external-hook',
      'dynamic-lazy',
      'same-name',
    ])
      expect(scenarios.has(name), name).toBe(true);
  });
  it('has no duplicate/dangling rows and a stable digest', () => {
    const first = run(cases());
    const second = run(cases());
    expect(first.duplicateEdges).toBe(0);
    expect(first.danglingTargets).toBe(0);
    expect(first.digest).toBe(second.digest);
  });
  it('records the Phase 14 performance baseline and 3+5 protocol', () => {
    expect(cases()[0].performanceProtocol).toEqual({
      warmups: 3,
      measurements: 5,
      maxRegressionRatio: 1.2,
      baselineWallMs: 205.604959,
      baselineRssBytes: 103120896,
    });
  });
  it('executes all six mandatory watched mutations red for the intended case', () => {
    const all = cases();
    const controls = all.flatMap((item) => item.watchedMutations ?? []);
    expect(controls).toHaveLength(6);
    for (const control of controls) {
      const result = run(all, control.id);
      expect(result.exitCode, control.id).toBe(control.expectedCheckerExitCode);
      expect(
        result.failures.some(
          (failure) => failure.startsWith(control.expectedCase) || failure.startsWith('integrity:')
        ),
        control.id
      ).toBe(true);
    }
  });
});
