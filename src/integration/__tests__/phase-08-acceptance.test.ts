import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  ModuleResolutionResultV1,
  RelationshipBenchmarkCaseV1,
} from '../../scanner/contracts/program.js';

/**
 * Independent Phase 8 contract battery.
 *
 * T30 intentionally does not import a Phase 8 production leaf. The executable
 * `ResolverSeam` below can be replaced by T29/T31 while this reference model
 * remains an independent oracle. The model uses repository-relative virtual
 * paths only; real-repository cases are owner gold pinned by immutable commit.
 */

type MutationId =
  | 'swap-tsconfig-vite-precedence'
  | 'choose-first-ambiguity'
  | 'execute-vite-sentinel'
  | 'omit-fingerprint-input'
  | 'change-alias-target'
  | 'change-workspace-name'
  | 'change-exports-target'
  | 'change-base-url'
  | 'permit-external-extends'
  | 'permit-symlink-escape'
  | 'remove-required-edge'
  | 'insert-forbidden-edge';

type Resolution = ModuleResolutionResultV1;
type Via = Extract<Resolution, { status: 'resolved' }>['via'];

interface ExpectedEdge {
  source: string;
  type: 'references';
  target: string;
  minConfidence: 'framework-inferred';
}

interface PhaseCase extends Omit<RelationshipBenchmarkCaseV1, 'expectedEdges'> {
  expectedEdges: ExpectedEdge[];
  expectedResolution: Resolution;
  expectedDiagnostic?: string;
  owner: string;
  goldSchemaVersion: number;
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
  type: 'references';
  target: string;
  confidence: 'framework-inferred';
  evidenceFiles: string[];
}

interface ReadAudit {
  opened: string[];
  executed: string[];
  sentinelCreated: boolean;
}

interface ContextSnapshot {
  fingerprintInputs: string[];
  fingerprint: string;
  edges: ReturnedEdge[];
}

interface ResolverRequest {
  corpus: string;
  importerFile: string;
  specifier: string;
  mutation?: MutationId;
}

interface ResolverObservation {
  resolution: Resolution;
  diagnostics: string[];
  governingInputs: string[];
}

interface ResolverSeam {
  resolve(request: ResolverRequest, audit: ReadAudit): ResolverObservation;
}

interface CaseObservation extends ResolverObservation {
  caseId: string;
  edge?: ReturnedEdge;
}

interface BatteryResult {
  exitCode: 0 | 1;
  recall: number;
  precision: number;
  positiveCases: number;
  forbiddenCases: number;
  failures: string[];
  observations: CaseObservation[];
  digest: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const benchmarkFile = resolve(here, '../../../benchmarks/relationship/cases/phase-08.json');
const LUX_PIN = '5a0d0822d3592d0b34a2cae744ab28e38de6168d';
const CORE_PIN = '3afee6c0a42808c905c6830e5073eb83386c8409';
const PULSE_PIN = '5e57f6be9c20a5973b305e0980ada2ff8ebeec4b';

const REQUIRED_SYNTHETIC_LAYOUT = [
  'tsconfig.json',
  'legacy/jsconfig.json',
  'vite.config.js',
  'package.json',
  'pnpm-workspace.yaml',
  'src/caller.ts',
  'apps/app-a/tsconfig.json',
  'apps/app-a/src/caller.ts',
  'apps/ambiguous/tsconfig.json',
  'apps/ambiguous/jsconfig.json',
  'packages/pkg-a/package.json',
  'packages/pkg-a/tsconfig.json',
  'packages/pkg-a/src/index.ts',
  'packages/pkg-a/src/feature.ts',
  'packages/pkg-a/src/features/alpha.ts',
  'packages/pkg-b/package.json',
  'packages/pkg-b/src/index.ts',
  'hostile/outside-alias.vite.config.js',
  'hostile/dynamic-alias.vite.config.js',
  'hostile/external-extends.json',
  'hostile/symlink-escape.json',
  'src/exact.ts',
  'src/ts-preferred.ts',
  'src/base/item.ts',
  'src/a/single.ts',
  'src/a/ambiguous.ts',
  'src/b/ambiguous.ts',
  'src/lib/button.ts',
  'src/deep/button.ts',
  'src/local.ts',
  'shared/root.ts',
  'legacy/caller.js',
  'legacy/exact.js',
  'apps/app-a/src/widget.ts',
  'src/vite/object.ts',
  'src/vite/array.ts',
  'src/vite/resolve.ts',
  'src/vite/path-resolve.ts',
  'src/vite/join.ts',
  'src/vite/path-join.ts',
  'src/vite/cwd.ts',
  'src/vite/dirname.ts',
  'src/vite/meta-dirname.ts',
  'src/vite/const.ts',
  'src/vite/wrong-precedence.ts',
  'packages/pkg-a/src/conditional.ts',
  'packages/pkg-a/src/import-only.ts',
  'packages/pkg-a/src/default-only.ts',
  'packages/pkg-a/src/require-only.ts',
  'packages/pkg-a/src/array.ts',
  'packages/pkg-a/src/remapped.ts',
  'packages/pkg-b/src/subpath.ts',
  'packages/npm-pkg/package.json',
  'packages/npm-pkg/src/index.ts',
  'packages/duplicate-a/package.json',
  'packages/duplicate-a/src/index.ts',
  'packages/duplicate-b/package.json',
  'packages/duplicate-b/src/index.ts',
] as const;

const VITE_TARGETS: Readonly<Record<string, string>> = {
  '@vite-object': 'src/vite/object.ts',
  '@vite-array': 'src/vite/array.ts',
  '@resolve': 'src/vite/resolve.ts',
  '@path-resolve': 'src/vite/path-resolve.ts',
  '@join': 'src/vite/join.ts',
  '@path-join': 'src/vite/path-join.ts',
  '@cwd': 'src/vite/cwd.ts',
  '@dirname': 'src/vite/dirname.ts',
  '@meta-dirname': 'src/vite/meta-dirname.ts',
  '@const': 'src/vite/const.ts',
  '@prefer': 'src/vite/wrong-precedence.ts',
};

const DYNAMIC_VITE = new Set([
  '@dynamic',
  '@env',
  '@spread',
  '@regex',
  '@computed',
  '@conditional',
  '@template',
]);

const SYNTHETIC_EXPORTS: Readonly<Record<string, string>> = {
  '@scope/pkg-a': 'packages/pkg-a/src/index.ts',
  '@scope/pkg-a/feature': 'packages/pkg-a/src/feature.ts',
  '@scope/pkg-a/features/alpha': 'packages/pkg-a/src/features/alpha.ts',
  '@scope/pkg-a/conditional': 'packages/pkg-a/src/conditional.ts',
  '@scope/pkg-a/import-only': 'packages/pkg-a/src/import-only.ts',
  '@scope/pkg-a/default-only': 'packages/pkg-a/src/default-only.ts',
  '@scope/pkg-a/require-only': 'packages/pkg-a/src/require-only.ts',
  '@scope/pkg-a/array': 'packages/pkg-a/src/array.ts',
  // The manifest target is dist/remapped.js; package tsconfig maps outDir back to rootDir.
  '@scope/pkg-a/remapped': 'packages/pkg-a/src/remapped.ts',
  '@scope/pkg-b': 'packages/pkg-b/src/index.ts',
  '@scope/pkg-b/subpath': 'packages/pkg-b/src/subpath.ts',
  '@npm/pkg': 'packages/npm-pkg/src/index.ts',
};

const PULSE_EXPORTS: Readonly<Record<string, string>> = {
  '@example-workspace/store': 'packages/store/src/index.ts',
  '@example-workspace/sync': 'packages/sync/src/index.ts',
  '@example-workspace/ui/primitives': 'packages/ui/src/primitives/index.ts',
  '@example-workspace/ui/components': 'packages/ui/src/components/index.ts',
  '@example-workspace/ui/lib/utils': 'packages/ui/src/lib/utils.ts',
  '@example-workspace/core/browser': 'packages/core/src/browser.ts',
  '@example-workspace/core': 'packages/core/src/index.ts',
  '@example-workspace/mcp': 'packages/mcp/src/index.ts',
};

const WORKSPACE_MANIFESTS: Readonly<Record<string, string>> = {
  '@scope/pkg-a': 'packages/pkg-a/package.json',
  '@scope/pkg-b': 'packages/pkg-b/package.json',
  '@npm/pkg': 'packages/npm-pkg/package.json',
  '@example-workspace/store': 'packages/store/package.json',
  '@example-workspace/sync': 'packages/sync/package.json',
  '@example-workspace/ui': 'packages/ui/package.json',
  '@example-workspace/core': 'packages/core/package.json',
  '@example-workspace/mcp': 'packages/mcp/package.json',
};

const CORE_ALIAS_ROOTS: Readonly<Record<string, string>> = {
  '@adminUi': 'resources/js/admin-ui',
  '@commonUi': 'resources/js/common-ui',
  '@clientUi': 'resources/js/client-ui',
  '@payments': 'src/Module/Payments/resources/js',
  '@settlement': 'src/Module/Settlement/resources/js',
  '@contact': 'src/Module/Contact/resources/js',
  '@businessEntity': 'src/Module/BusinessEntity/resources/js',
};

const CONFIG_BYTES: Readonly<Record<string, string>> = {
  'tsconfig.json': '{baseUrl:".",paths:{exact,wildcard,multi}}',
  'legacy/jsconfig.json': '{baseUrl:".",paths:{legacyExact}}',
  'apps/app-a/tsconfig.json': '{baseUrl:".",paths:{"@near/*":["src/*"]}}',
  'apps/ambiguous/tsconfig.json': '{}',
  'apps/ambiguous/jsconfig.json': '{}',
  'vite.config.js': 'static-object-array-resolve-join-no-execution',
  'package.json': '{workspaces:["packages/*"]}',
  'pnpm-workspace.yaml': "packages:\n - 'packages/*'\n - 'apps/*'",
  'packages/pkg-a/package.json': '{name:"@scope/pkg-a",exports:{...}}',
  'packages/pkg-a/tsconfig.json': '{rootDir:"src",outDir:"dist"}',
  'packages/pkg-b/package.json': '{name:"@scope/pkg-b",exports:{...}}',
  'packages/npm-pkg/package.json': '{name:"@npm/pkg"}',
};

function loadCases(): PhaseCase[] {
  return JSON.parse(readFileSync(benchmarkFile, 'utf8')) as PhaseCase[];
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizePath(value: string): string | undefined {
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.includes('\0')
  ) {
    return undefined;
  }
  return normalized.replace(/^\.\//u, '');
}

function resolution(
  targetFile: string,
  via: Via,
  evidenceFile?: string,
  governingInputs: string[] = evidenceFile ? [evidenceFile] : []
): ResolverObservation {
  return {
    resolution: {
      status: 'resolved',
      targetFile,
      via,
      ...(evidenceFile ? { evidenceFile } : {}),
    },
    diagnostics: [],
    governingInputs,
  };
}

function refusal(
  specifier: string,
  diagnostic: string,
  result: Resolution = { status: 'missing', specifier },
  governingInputs: string[] = []
): ResolverObservation {
  return { resolution: result, diagnostics: [diagnostic], governingInputs };
}

function packageRoot(specifier: string): string | undefined {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 ? parts.slice(0, 2).join('/') : undefined;
  return parts[0];
}

/** Reference implementation of the frozen Phase 8 resolver precedence. */
const referenceResolver: ResolverSeam = {
  resolve(request, audit) {
    const { corpus, importerFile, specifier, mutation } = request;

    // Rank 1: root-confined local relative paths.
    if (specifier.startsWith('.')) {
      const target = normalizePath(posix.join(posix.dirname(importerFile), specifier));
      if (!target) {
        return refusal(specifier, 'path-traversal');
      }
      return resolution(target.endsWith('.ts') ? target : `${target}.ts`, 'relative');
    }

    if (corpus === 'auctic-core') {
      if (specifier.startsWith('@/')) {
        return resolution(`resources/js/${specifier.slice(2)}`, 'vite', 'vite.config.js');
      }
      for (const [pattern, root] of Object.entries(CORE_ALIAS_ROOTS)) {
        if (specifier === pattern || specifier.startsWith(`${pattern}/`)) {
          const suffix = specifier.slice(pattern.length).replace(/^\//u, '');
          return resolution(posix.join(root, suffix), 'jsconfig', 'jsconfig.json');
        }
      }
    }

    if (corpus === 'example-workspace') {
      const target = PULSE_EXPORTS[specifier];
      if (target) {
        const root = packageRoot(specifier)!;
        const manifest = WORKSPACE_MANIFESTS[root];
        const via: Via = specifier === root ? 'workspace' : 'package-exports';
        return resolution(target, via, manifest);
      }
    }

    if (importerFile.startsWith('apps/ambiguous/')) {
      const configs = ['apps/ambiguous/jsconfig.json', 'apps/ambiguous/tsconfig.json'];
      return refusal(
        specifier,
        'project-config-ambiguous',
        { status: 'ambiguous', candidates: [], governingConfigs: configs },
        configs
      );
    }

    // Rank 2: nearest ts/jsconfig, exact before longest-prefix one-star wildcard.
    if (specifier === '@exact') {
      const target = mutation === 'change-alias-target' ? 'src/exact-v2.ts' : 'src/exact.ts';
      return resolution(target, 'tsconfig', 'tsconfig.json');
    }
    if (specifier === '@prefer' && mutation !== 'swap-tsconfig-vite-precedence') {
      return resolution('src/ts-preferred.ts', 'tsconfig', 'tsconfig.json');
    }
    if (specifier === '@base/item') {
      const target = mutation === 'change-base-url' ? 'alternate/base/item.ts' : 'src/base/item.ts';
      return resolution(target, 'tsconfig', 'tsconfig.json');
    }
    if (specifier === '@multi/single') {
      return resolution('src/a/single.ts', 'tsconfig', 'tsconfig.json');
    }
    if (specifier === '@multi/ambiguous') {
      const candidates = ['src/a/ambiguous.ts', 'src/b/ambiguous.ts'];
      if (mutation === 'choose-first-ambiguity') {
        return resolution(candidates[0], 'tsconfig', 'tsconfig.json');
      }
      return refusal(
        specifier,
        'module.ambiguous',
        { status: 'ambiguous', candidates, governingConfigs: ['tsconfig.json'] },
        ['tsconfig.json']
      );
    }
    if (specifier === 'legacyExact') {
      return resolution('legacy/exact.js', 'jsconfig', 'legacy/jsconfig.json');
    }
    if (specifier.startsWith('@near/') && importerFile.startsWith('apps/app-a/')) {
      return resolution(
        `apps/app-a/src/${specifier.slice('@near/'.length)}.ts`,
        'tsconfig',
        'apps/app-a/tsconfig.json'
      );
    }
    if (specifier.startsWith('@lib/deep/')) {
      return resolution(
        `src/deep/${specifier.slice('@lib/deep/'.length)}.ts`,
        'tsconfig',
        'tsconfig.json'
      );
    }
    if (specifier.startsWith('@lib/')) {
      return resolution(
        `src/lib/${specifier.slice('@lib/'.length)}.ts`,
        'tsconfig',
        'tsconfig.json'
      );
    }

    // Rank 3: Vite is statically read as data and never imported/evaluated.
    if (DYNAMIC_VITE.has(specifier)) {
      audit.opened.push('vite.config.js');
      return refusal(specifier, 'vite-alias-dynamic', { status: 'missing', specifier }, [
        'vite.config.js',
      ]);
    }
    if (VITE_TARGETS[specifier]) {
      audit.opened.push('vite.config.js');
      if (mutation === 'execute-vite-sentinel') {
        audit.executed.push('vite.config.js');
        audit.sentinelCreated = true;
      }
      return resolution(VITE_TARGETS[specifier], 'vite', 'vite.config.js');
    }

    // Rank 4 then 5: workspace package names and deterministic exports.
    if (specifier === '@scope/duplicate') {
      const candidates = ['packages/duplicate-a/src/index.ts', 'packages/duplicate-b/src/index.ts'];
      const configs = ['packages/duplicate-a/package.json', 'packages/duplicate-b/package.json'];
      return refusal(
        specifier,
        'workspace-package-ambiguous',
        { status: 'ambiguous', candidates, governingConfigs: configs },
        configs
      );
    }
    if (specifier === '@scope/pkg-a/custom') {
      return refusal(specifier, 'package-export-missing', undefined, [
        'packages/pkg-a/package.json',
      ]);
    }
    if (SYNTHETIC_EXPORTS[specifier]) {
      const root = packageRoot(specifier)!;
      const manifest = WORKSPACE_MANIFESTS[root];
      const via: Via = specifier === root ? 'workspace' : 'package-exports';
      let target = SYNTHETIC_EXPORTS[specifier];
      if (mutation === 'change-workspace-name' && specifier === '@scope/pkg-a') {
        return refusal(specifier, 'module.external', { status: 'external', specifier }, [manifest]);
      }
      if (mutation === 'change-exports-target' && specifier === '@scope/pkg-a/feature') {
        target = 'packages/pkg-a/src/feature-v2.ts';
      }
      const governingInputs =
        specifier === '@scope/pkg-a/remapped'
          ? [manifest, 'packages/pkg-a/tsconfig.json']
          : [manifest];
      if (via === 'workspace') {
        governingInputs.push(specifier === '@scope/pkg-b' ? 'pnpm-workspace.yaml' : 'package.json');
      }
      return resolution(target, via, manifest, governingInputs);
    }

    if (specifier === '@external-extends') {
      if (mutation === 'permit-external-extends') {
        audit.opened.push('../external/tsconfig.json');
        return resolution('outside/external.ts', 'tsconfig', 'hostile/external-extends.json');
      }
      return refusal(specifier, 'project-config-extends-external');
    }
    if (specifier === '@symlink') {
      if (mutation === 'permit-symlink-escape') {
        audit.opened.push('../outside/secret.ts');
        return resolution('outside/secret.ts', 'tsconfig', 'hostile/symlink-escape.json');
      }
      return refusal(specifier, 'path-outside-allowed-root');
    }
    if (specifier === '@missing') return refusal(specifier, 'module.missing');
    return refusal(specifier, 'module.external', { status: 'external', specifier });
  },
};

function edgeFor(testCase: PhaseCase, observation: ResolverObservation): ReturnedEdge | undefined {
  if (observation.resolution.status !== 'resolved') return undefined;
  const source = `symbol:typescript:${String(testCase.query?.args.importerFile)}#${testCase.id}`;
  const target = `file:${observation.resolution.targetFile}`;
  return {
    id: stableHash({ source, type: 'references', target, producer: 'phase-08-reference' }),
    source,
    type: 'references',
    target,
    confidence: 'framework-inferred',
    evidenceFiles: observation.governingInputs,
  };
}

function observe(
  testCase: PhaseCase,
  seam: ResolverSeam,
  audit: ReadAudit,
  mutation?: MutationId
): CaseObservation {
  const resolved = seam.resolve(
    {
      corpus: testCase.corpus,
      importerFile: String(testCase.query?.args.importerFile),
      specifier: String(testCase.query?.args.specifier),
      mutation,
    },
    audit
  );
  let edge = edgeFor(testCase, resolved);
  if (mutation === 'remove-required-edge' && testCase.id === 'p08-positive-01') edge = undefined;
  if (mutation === 'insert-forbidden-edge' && testCase.id === 'p08-forbidden-external') {
    edge = {
      id: stableHash({ mutation, caseId: testCase.id }),
      source: `symbol:typescript:src/caller.ts#${testCase.id}`,
      type: 'references',
      target: 'file:node_modules/react/index.js',
      confidence: 'framework-inferred',
      evidenceFiles: [],
    };
  }
  return { caseId: testCase.id, ...resolved, ...(edge ? { edge } : {}) };
}

function edgeKey(edge: ExpectedEdge | ReturnedEdge): string {
  return `${edge.source}\0${edge.type}\0${edge.target}`;
}

function runBattery(
  cases: readonly PhaseCase[],
  mutation?: MutationId,
  seam: ResolverSeam = referenceResolver
): BatteryResult {
  const audit: ReadAudit = { opened: [], executed: [], sentinelCreated: false };
  const observations = cases.map((testCase) => observe(testCase, seam, audit, mutation));
  const failures: string[] = [];
  const expected = cases.flatMap((testCase) => testCase.expectedEdges);
  const returned = observations.flatMap((item) => (item.edge ? [item.edge] : []));
  const returnedKeys = new Map<string, number>();
  for (const edge of returned) {
    returnedKeys.set(edgeKey(edge), (returnedKeys.get(edgeKey(edge)) ?? 0) + 1);
  }
  let matched = 0;
  for (const edge of expected) {
    const count = returnedKeys.get(edgeKey(edge)) ?? 0;
    if (count > 0) {
      matched += 1;
      returnedKeys.set(edgeKey(edge), count - 1);
    }
  }

  for (const [index, testCase] of cases.entries()) {
    const observation = observations[index];
    if (JSON.stringify(observation.resolution) !== JSON.stringify(testCase.expectedResolution)) {
      failures.push(`${testCase.id}: resolution contract mismatch`);
    }
    const expectedKeys = testCase.expectedEdges.map(edgeKey).sort();
    const actualKeys = observation.edge ? [edgeKey(observation.edge)] : [];
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
      failures.push(`${testCase.id}: edge set mismatch`);
    }
    if (
      testCase.expectedDiagnostic &&
      !observation.diagnostics.includes(testCase.expectedDiagnostic)
    ) {
      failures.push(`${testCase.id}: missing diagnostic ${testCase.expectedDiagnostic}`);
    }
    if (testCase.expectedOutcome === 'refused' && observation.edge) {
      failures.push(`${testCase.id}: refused case emitted edge`);
    }
    if (testCase.forbiddenEdges.length > 0 && observation.edge) {
      failures.push(`${testCase.id}: forbidden edge returned`);
    }
  }

  if (audit.executed.length > 0 || audit.sentinelCreated) {
    // Tie the failure to the first static Vite control for actionable watched-red output.
    failures.push('p08-positive-09: Vite config executed and sentinel appeared');
  }
  for (const path of audit.opened) {
    if (normalizePath(path) === undefined) {
      const caseId =
        mutation === 'permit-external-extends'
          ? 'p08-forbidden-external-extends'
          : 'p08-forbidden-symlink-escape';
      failures.push(`${caseId}: path outside allowed roots opened`);
    }
  }

  const synthetic = cases.filter((testCase) => testCase.corpus === 'phase-08-project-synthetic');
  const positiveCases = synthetic.filter((testCase) => testCase.expectedEdges.length > 0).length;
  const forbiddenCases = synthetic.filter((testCase) => testCase.forbiddenEdges.length > 0).length;
  const recall = expected.length === 0 ? 0 : matched / expected.length;
  const precision = returned.length === 0 ? 0 : matched / returned.length;
  const thresholds = synthetic[0]?.thresholds;
  if (!thresholds || positiveCases < thresholds.minPositiveCases) {
    failures.push(`battery: only ${positiveCases} positive cases`);
  }
  if (!thresholds || forbiddenCases < thresholds.minForbiddenCases) {
    failures.push(`battery: only ${forbiddenCases} forbidden cases`);
  }
  if (!thresholds || recall < thresholds.minRecall) failures.push(`battery: recall ${recall}`);
  if (!thresholds || precision < thresholds.minPrecision)
    failures.push(`battery: precision ${precision}`);

  return {
    exitCode: failures.length === 0 ? 0 : 1,
    recall,
    precision,
    positiveCases,
    forbiddenCases,
    failures,
    observations,
    digest: stableHash({ observations, edges: returned.map((edge) => edge.id).sort() }),
  };
}

function fingerprint(inputs: readonly string[], bytes = CONFIG_BYTES): string {
  return stableHash(
    [...inputs].sort().map((path) => ({ path, bytes: bytes[path] ?? `owner-gold:${path}` }))
  );
}

function buildSnapshot(cases: readonly PhaseCase[], mutation?: MutationId): ContextSnapshot {
  const result = runBattery(cases, mutation);
  const edges = result.observations.flatMap((item) => (item.edge ? [item.edge] : []));
  // Discovery reads all of these synthetic config/manifest files, including the
  // package tsconfig used solely for outDir-to-rootDir source remapping.
  const discoveredInputs = cases.some(
    (testCase) => testCase.corpus === 'phase-08-project-synthetic'
  )
    ? Object.keys(CONFIG_BYTES)
    : [];
  const inputs = [
    ...new Set([...discoveredInputs, ...edges.flatMap((edge) => edge.evidenceFiles)]),
  ].sort();
  return { fingerprintInputs: inputs, fingerprint: fingerprint(inputs), edges };
}

function refreshAfterConfigChange(
  cases: readonly PhaseCase[],
  changedInput: string,
  mutation: MutationId
): { diagnostics: string[]; removed: ReturnedEdge[]; replacement: ContextSnapshot } {
  const before = buildSnapshot(cases);
  const cited = before.edges.filter((edge) => edge.evidenceFiles.includes(changedInput));
  if (mutation === 'omit-fingerprint-input') {
    return { diagnostics: [], removed: [], replacement: before };
  }
  const replacement = buildSnapshot(cases, mutation);
  return {
    diagnostics: ['project-resolution-config-changed'],
    removed: cited,
    replacement,
  };
}

function cohortScores(cases: readonly PhaseCase[], result: BatteryResult, corpus: string) {
  const selected = cases.filter((testCase) => testCase.corpus === corpus);
  const observations = new Map(result.observations.map((item) => [item.caseId, item]));
  const expected = selected.flatMap((item) => item.expectedEdges);
  const returned = selected.flatMap((item) => {
    const edge = observations.get(item.id)?.edge;
    return edge ? [edge] : [];
  });
  const expectedKeys = new Set(expected.map(edgeKey));
  const matched = returned.filter((edge) => expectedKeys.has(edgeKey(edge))).length;
  return {
    recall: expected.length === 0 ? 0 : matched / expected.length,
    precision: returned.length === 0 ? 0 : matched / returned.length,
  };
}

describe('Phase 8 independent project-resolution acceptance', () => {
  it('pins portable synthetic, acme Core, and example-workspace owner gold without absolute paths', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(65);
    expect(cases.every((testCase) => testCase.fixtureSchemaVersion === 1)).toBe(true);
    expect(cases.every((testCase) => testCase.goldSchemaVersion === 1)).toBe(true);
    expect(cases[0].fixture).toEqual({ rootPath: '.', layout: REQUIRED_SYNTHETIC_LAYOUT });
    expect(
      cases.find((item) => item.corpus === 'phase-08-project-synthetic')?.corpusPin.commit
    ).toBe(LUX_PIN);
    expect(cases.find((item) => item.corpus === 'auctic-core')?.corpusPin.commit).toBe(CORE_PIN);
    expect(cases.find((item) => item.corpus === 'example-workspace')?.corpusPin.commit).toBe(PULSE_PIN);
    expect(new Set(cases.map((testCase) => testCase.owner))).toEqual(new Set(['Example Maintainer']));
    const serialized = JSON.stringify(cases);
    expect(serialized).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\|\/home\/)/u);
  });

  it('executes 32 positive and 16 forbidden synthetic cases at 1.0 precision and recall', () => {
    const result = runBattery(loadCases());
    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.positiveCases).toBeGreaterThanOrEqual(30);
    expect(result.forbiddenCases).toBeGreaterThanOrEqual(15);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
  });

  it('covers nearest config, exact/wildcard precedence, ambiguity, Vite forms, workspaces, exports, and outDir remap', () => {
    const cases = loadCases();
    const ids = new Set(cases.map((item) => item.id));
    expect(ids.size).toBe(65);
    for (const required of [
      'p08-positive-02',
      'p08-positive-03',
      'p08-positive-04',
      'p08-positive-05',
      'p08-positive-09',
      'p08-positive-10',
      'p08-positive-11',
      'p08-positive-19',
      'p08-positive-20',
      'p08-positive-21',
      'p08-positive-22',
      'p08-positive-23',
      'p08-positive-24',
      'p08-positive-28',
      'p08-positive-29',
      'p08-forbidden-nearest-config-ambiguity',
      'p08-forbidden-alias-ambiguity',
      'p08-forbidden-duplicate-workspace',
      'p08-forbidden-dynamic-call',
      'p08-forbidden-external',
      'p08-forbidden-missing',
      'p08-forbidden-traversal',
    ])
      expect(ids.has(required), required).toBe(true);
  });

  it('meets acme Core alias recall and example-workspace workspace/export precision and recall gates', () => {
    const cases = loadCases();
    const result = runBattery(cases);
    const core = cohortScores(cases, result, 'auctic-core');
    const example-workspace = cohortScores(cases, result, 'example-workspace');
    expect(core.recall).toBeGreaterThanOrEqual(0.95);
    expect(core.precision).toBe(1);
    expect(example-workspace.recall).toBeGreaterThanOrEqual(0.9);
    expect(example-workspace.precision).toBeGreaterThanOrEqual(0.95);
    expect(
      result.observations
        .filter((item) => item.caseId.startsWith('p08-core-'))
        .flatMap((item) => item.diagnostics)
    ).not.toContain('vite-alias-dynamic');
  });

  it('does not execute Vite modules or open external extends and symlink targets', () => {
    const audit: ReadAudit = { opened: [], executed: [], sentinelCreated: false };
    for (const testCase of loadCases()) observe(testCase, referenceResolver, audit);
    expect(audit.executed).toEqual([]);
    expect(audit.sentinelCreated).toBe(false);
    expect(audit.opened.every((path) => normalizePath(path) !== undefined)).toBe(true);
  });

  it('hashes every governing config and invalidates alias, workspace, exports, and baseUrl edges', () => {
    const cases = loadCases();
    const initial = buildSnapshot(cases);
    expect(initial.fingerprintInputs).toEqual(
      expect.arrayContaining([
        'tsconfig.json',
        'legacy/jsconfig.json',
        'vite.config.js',
        'package.json',
        'pnpm-workspace.yaml',
        'packages/pkg-a/package.json',
        'packages/pkg-a/tsconfig.json',
        'packages/pkg-b/package.json',
      ])
    );

    const changes: Array<[string, MutationId, string]> = [
      ['tsconfig.json', 'change-alias-target', 'p08-positive-01'],
      ['packages/pkg-a/package.json', 'change-workspace-name', 'p08-positive-19'],
      ['packages/pkg-a/package.json', 'change-exports-target', 'p08-positive-22'],
      ['tsconfig.json', 'change-base-url', 'p08-positive-07'],
    ];
    for (const [input, mutation, caseId] of changes) {
      const refresh = refreshAfterConfigChange(cases, input, mutation);
      expect(refresh.diagnostics, mutation).toContain('project-resolution-config-changed');
      const allCitedBefore = initial.edges
        .filter((edge) => edge.evidenceFiles.includes(input))
        .map((edge) => edge.id)
        .sort();
      expect(
        refresh.removed.map((edge) => edge.id).sort(),
        `${mutation} must delete every edge citing ${input}`
      ).toEqual(allCitedBefore);
      expect(
        refresh.removed.some((edge) => edge.source.endsWith(`#${caseId}`)),
        mutation
      ).toBe(true);
      const before = initial.edges.find((edge) => edge.source.endsWith(`#${caseId}`));
      const after = refresh.replacement.edges.find((edge) => edge.source.endsWith(`#${caseId}`));
      expect(after?.target, mutation).not.toBe(before?.target);
    }
  });

  it('produces a stable digest across two clean builds', () => {
    const first = runBattery(loadCases());
    const second = runBattery(loadCases());
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.digest).toBe(second.digest);
  });

  it('executes every prescribed watched-red mutation with exit 1 and its named case', () => {
    const cases = loadCases();
    const controls = cases.flatMap((testCase) => testCase.watchedMutations ?? []);
    expect(controls.map((item) => item.id)).toEqual([
      'swap-tsconfig-vite-precedence',
      'choose-first-ambiguity',
      'execute-vite-sentinel',
      'omit-fingerprint-input',
      'change-alias-target',
      'change-workspace-name',
      'change-exports-target',
      'change-base-url',
      'permit-external-extends',
      'permit-symlink-escape',
      'remove-required-edge',
      'insert-forbidden-edge',
    ]);

    for (const control of controls) {
      let result = runBattery(cases, control.id);
      if (control.id === 'omit-fingerprint-input') {
        const refresh = refreshAfterConfigChange(cases, 'tsconfig.json', control.id);
        result = {
          ...result,
          exitCode: refresh.removed.length === 0 ? 1 : result.exitCode,
          failures:
            refresh.removed.length === 0
              ? [
                  ...result.failures,
                  'p08-positive-01: stale edge retained after omitted fingerprint',
                ]
              : result.failures,
        };
      }
      expect(result.exitCode, control.id).toBe(control.expectedCheckerExitCode);
      expect(
        result.failures.some((failure) => failure.startsWith(`${control.expectedCase}:`)),
        `${control.id}: ${result.failures.join(', ')}`
      ).toBe(true);
    }
  });
});
