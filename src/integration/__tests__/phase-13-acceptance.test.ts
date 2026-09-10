import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';
import { bladeTemplateId, programEdgeId } from '../../scanner/identity/program-identity.js';

/**
 * Independent Phase 13 contract battery (T50).
 *
 * The reference seam intentionally imports no Phase 13 production leaf. T49/T51
 * may replace it while owner gold, fail-closed negatives, Acme applicability,
 * invalidation checks, integrity controls, and watched-red mutants stay fixed.
 */

type Coverage = 'active' | 'partial' | 'failed' | 'not_applicable';
type MutationId =
  | 'accept-missing-view'
  | 'reverse-edge'
  | 'global-basename-resolution'
  | 'parse-commented-mount'
  | 'classify-volt-supported'
  | 'omit-namespace-evidence'
  | 'remove-required-edge'
  | 'inject-forbidden-edge';
type GoldEdge = RelationshipBenchmarkCaseV1['expectedEdges'][number];
type ForbiddenEdge = RelationshipBenchmarkCaseV1['forbiddenEdges'][number];

interface Location {
  filePath: string;
  line: number;
  column: number;
}

interface Thresholds {
  minRecall: number;
  minPrecision: number;
  minPositiveCases: number;
  minForbiddenCases: number;
}

interface QueryArgs {
  files?: Record<string, string>;
  classRoots?: string[];
  viewRoots?: string[];
  viewNamespaces?: Record<string, string[]>;
  configFile?: string;
  manifestCorpus?: string;
  resolvedRemote?: string;
  resolvedCommit?: string;
  candidateFiles?: string[];
}

interface PhaseCase extends RelationshipBenchmarkCaseV1 {
  owner: string;
  goldSchemaVersion: number;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  thresholds?: Thresholds;
  expectedCoverage: Coverage;
  expectedDiagnostics: string[];
  expectedCandidateCount?: number;
  expectedEvidenceFiles?: string[];
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
  type: 'renders_template' | 'hydrates_component';
  target: string;
  confidence: 'framework-inferred';
  evidence: Location[];
  evidenceFiles: string[];
}

interface Observation {
  caseId: string;
  outcome: 'answered' | 'unsupported';
  coverage: Coverage;
  candidateCount: number;
  diagnostics: string[];
  nodes: string[];
  edges: ReturnedEdge[];
  fingerprint: string;
}

interface BatteryResult {
  exitCode: 0 | 1;
  failures: string[];
  observations: Observation[];
  score: {
    expected: number;
    returned: number;
    matched: number;
    positiveCases: number;
    forbiddenCases: number;
    recall: number;
    precision: number;
  };
  duplicateEdgeIds: number;
  danglingEndpoints: number;
  digest: string;
}

interface PhpClass {
  filePath: string;
  namespace: string;
  name: string;
  qualified: string;
  parent?: string;
  body: string;
  offset: number;
  imports: Map<string, string>;
  root?: string;
  convention?: string;
  location: Location;
}

interface ViewNamespace {
  name: string;
  roots: string[];
  evidence: Location;
}

const here = dirname(fileURLToPath(import.meta.url));
const benchmarkPath = resolve(here, '../../../benchmarks/relationship/cases/phase-13.json');
const LUX_PIN = 'adbb7c141c700c13a1a54c71893fb9303cc65ba2';
const ACME_PIN = '3afee6c0a42808c905c6830e5073eb83386c8409';
const ACME_REMOTE = 'https://github.com/acme-software/acme-core.git';
const PRODUCER = 'laravel-livewire';

function loadCases(): PhaseCase[] {
  return JSON.parse(readFileSync(benchmarkPath, 'utf8')) as PhaseCase[];
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function location(source: string, offset: number, filePath: string): Location {
  const lines = source.slice(0, offset).split('\n');
  return { filePath, line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function phpSymbol(qualified: string): string {
  return `symbol:php:${qualified}`;
}

function safePath(value: string): string | undefined {
  if (!value || value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.includes('\\')) return;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) return;
  return value.replace(/\/$/u, '');
}

function vendorPath(value: string): boolean {
  const parts = value.split('/');
  const index = parts.indexOf('vendor');
  return parts.includes('node_modules') || (index >= 0 && index !== 2);
}

function bladePath(value: string): boolean {
  return value.endsWith('.blade.php') && Boolean(safePath(value)) && !vendorPath(value);
}

function maskComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/gu, (value) => value.replace(/[^\r\n]/gu, ' '))
    .replace(/\/\/[^\n]*|#[^\n]*/gu, (value) => ' '.repeat(value.length));
}

function maskBladeComments(source: string): string {
  let result = source.replace(/\{\{--[\s\S]*?(?:--\}\}|$)/gu, (value) =>
    value.replace(/[^\r\n]/gu, ' ')
  );
  result = result.replace(
    /(?:<\?(?:php|=)?[\s\S]*?(?:\?>|$)|@php\b[\s\S]*?(?:@endphp\b|$))/giu,
    (region) => maskComments(region)
  );
  return result;
}

function importsOf(code: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of maskComments(code).matchAll(/(?:^|;)\s*use\s+([^;]+);/gmu)) {
    const statement = match[1].trim();
    if (/^(?:function|const)\s/u.test(statement)) continue;
    for (const member of statement.split(',')) {
      const parts = member.trim().split(/\s+as\s+/iu);
      const qualified = parts[0].replace(/^\\/u, '');
      const alias = parts[1] ?? qualified.split('\\').at(-1);
      if (alias) imports.set(alias, qualified);
    }
  }
  return imports;
}

function resolvePhpName(
  raw: string,
  namespace: string,
  imports: ReadonlyMap<string, string>
): string {
  const clean = raw.replace(/^\\/u, '');
  const head = clean.split('\\')[0];
  const imported = imports.get(head);
  if (imported) return `${imported}${clean.slice(head.length)}`;
  if (raw.startsWith('\\') || clean.includes('\\')) return clean;
  return namespace ? `${namespace}\\${clean}` : clean;
}

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/_/gu, '-')
    .toLowerCase();
}

function discoverClasses(args: QueryArgs, diagnostics: string[]): PhpClass[] {
  const files = args.files ?? {};
  const roots = (args.classRoots ?? []).flatMap((root) =>
    safePath(root) ? [root.replace(/\/$/u, '')] : []
  );
  const parsed: PhpClass[] = [];
  for (const [filePath, source] of Object.entries(files).sort()) {
    if (
      !filePath.endsWith('.php') ||
      !safePath(filePath) ||
      vendorPath(filePath) ||
      filePath.endsWith('.blade.php')
    )
      continue;
    const code = maskComments(source);
    if (/new\s+class\s+extends\s+(?:\\?Livewire\\Component|Component)\b/u.test(code)) {
      diagnostics.push('livewire-anonymous-unsupported');
    }
    const namespace = /\bnamespace\s+([A-Za-z_\\][\w\\]*)\s*;/u.exec(code)?.[1] ?? '';
    const imports = importsOf(source);
    const classRe =
      /\b(?:abstract\s+|final\s+|readonly\s+)*class\s+([A-Za-z_][\w]*)\s*(?:extends\s+([A-Za-z_\\][\w\\]*))?[^{};]*\{/gu;
    for (const match of code.matchAll(classRe)) {
      if (code.slice(Math.max(0, match.index - 8), match.index).includes('new ')) continue;
      const open = match.index + match[0].lastIndexOf('{');
      let depth = 0;
      let close = source.length - 1;
      for (let index = open; index < source.length; index++) {
        if (source[index] === '{') depth++;
        else if (source[index] === '}' && --depth === 0) {
          close = index;
          break;
        }
      }
      const root = roots
        .filter((candidate) => filePath.startsWith(`${candidate}/`))
        .sort((a, b) => b.length - a.length)[0];
      const relative = root ? filePath.slice(root.length + 1).replace(/\.php$/u, '') : undefined;
      parsed.push({
        filePath,
        namespace,
        name: match[1],
        qualified: namespace ? `${namespace}\\${match[1]}` : match[1],
        parent: match[2] ? resolvePhpName(match[2], namespace, imports) : undefined,
        body: source.slice(open + 1, close),
        offset: open + 1,
        imports,
        root,
        convention: relative?.split('/').map(kebab).join('.'),
        location: location(source, match.index, filePath),
      });
    }
  }
  const livewire = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of parsed) {
      if (
        item.parent &&
        (item.parent === 'Livewire\\Component' || livewire.has(item.parent)) &&
        !livewire.has(item.qualified)
      ) {
        livewire.add(item.qualified);
        changed = true;
      }
    }
  }
  return parsed.filter((item) => livewire.has(item.qualified));
}

function discoveredNamespaces(args: QueryArgs, diagnostics: string[]): ViewNamespace[] {
  const result: ViewNamespace[] = [];
  const configFile = args.configFile ?? 'lux.yaml';
  for (const [name, roots] of Object.entries(args.viewNamespaces ?? {})) {
    const confined = roots.flatMap((root) => (safePath(root) ? [root] : []));
    if (name && confined.length)
      result.push({
        name,
        roots: confined,
        evidence: { filePath: configFile, line: 1, column: 0 },
      });
  }
  for (const [filePath, source] of Object.entries(args.files ?? {})) {
    if (!filePath.endsWith('.php') || vendorPath(filePath)) continue;
    const code = maskComments(source);
    for (const match of code.matchAll(/\bloadViewsFrom\s*\(([^,]+),\s*([^)]+)\)/gu)) {
      const namespace = /^\s*(['"])([A-Za-z0-9_-]+)\1\s*$/u.exec(match[2])?.[2];
      const direct = /^\s*(['"])([^'"]+)\1\s*$/u.exec(match[1])?.[2];
      const resource = /^\s*resource_path\s*\(\s*(['"])([^'"]+)\1\s*\)\s*$/u.exec(match[1])?.[2];
      const root = direct ?? (resource ? posix.join('resources', resource) : undefined);
      if (namespace && root && safePath(root)) {
        result.push({
          name: namespace,
          roots: [root],
          evidence: location(source, match.index, filePath),
        });
      } else diagnostics.push('livewire-dynamic-namespace');
    }
  }
  return result;
}

function viewCandidates(
  name: string,
  args: QueryArgs,
  namespaces: readonly ViewNamespace[]
): Array<{ path: string; evidence?: Location }> {
  const separator = name.indexOf('::');
  const namespace = separator < 0 ? undefined : name.slice(0, separator);
  const local = separator < 0 ? name : name.slice(separator + 2);
  const roots: Array<{ root: string; evidence?: Location }> = namespace
    ? namespaces
        .filter((item) => item.name === namespace)
        .flatMap((item) => item.roots.map((root) => ({ root, evidence: item.evidence })))
    : (args.viewRoots ?? []).map((root) => ({ root }));
  const files = args.files ?? {};
  return roots.flatMap(({ root, evidence }) => {
    const path = `${root}/${local.replaceAll('.', '/')}.blade.php`;
    return safePath(path) && !vendorPath(path) && files[path] !== undefined
      ? [{ path, evidence }]
      : [];
  });
}

function edge(
  source: string,
  type: ReturnedEdge['type'],
  target: string,
  evidence: Location[]
): ReturnedEdge {
  return {
    id: programEdgeId(type, source, target, PRODUCER),
    source,
    type,
    target,
    confidence: 'framework-inferred',
    evidence,
    evidenceFiles: [...new Set(evidence.map((item) => item.filePath))],
  };
}

function extractViews(
  item: PhpClass,
  args: QueryArgs,
  namespaces: readonly ViewNamespace[],
  diagnostics: string[]
): ReturnedEdge[] {
  const result: ReturnedEdge[] = [];
  const method = /\bfunction\s+render\s*\([^)]*\)[^{;]*\{([\s\S]*)\}\s*$/u.exec(
    maskComments(item.body)
  )?.[1];
  if (!method) return conventionalView(item, args);
  let renderLiteral = false;
  const literal = /(?:\breturn\s+view|->layout)\s*\(\s*(['"])(.*?)\1\s*(?:,|\))/gsu;
  for (const match of method.matchAll(literal)) {
    const name = match[2];
    const isRender = match[0].includes('return');
    if (
      (match[1] === '"' && /\$|\{/u.test(name)) ||
      !name ||
      name.includes('..') ||
      name.includes('\\')
    ) {
      diagnostics.push(isRender ? 'livewire-dynamic-view' : 'livewire-dynamic-layout');
      continue;
    }
    if (isRender) renderLiteral = true;
    const candidates = viewCandidates(name, args, namespaces);
    if (candidates.length !== 1) {
      diagnostics.push(candidates.length ? 'livewire-view-ambiguous' : 'livewire-view-missing');
      continue;
    }
    const hit = candidates[0];
    result.push(
      edge(phpSymbol(item.qualified), 'renders_template', bladeTemplateId(hit.path), [
        item.location,
        location(item.body, match.index, item.filePath),
        ...(hit.evidence ? [hit.evidence] : []),
      ])
    );
  }
  const hasRenderCall = /\breturn\s+view\s*\(/u.test(method);
  if (hasRenderCall && !renderLiteral) diagnostics.push('livewire-dynamic-view');
  return result.length || renderLiteral || hasRenderCall ? result : conventionalView(item, args);
}

function conventionalView(item: PhpClass, args: QueryArgs): ReturnedEdge[] {
  if (!item.convention) return [];
  const candidates = viewCandidates(item.convention, args, []);
  return candidates.length === 1
    ? [
        edge(phpSymbol(item.qualified), 'renders_template', bladeTemplateId(candidates[0].path), [
          item.location,
          { filePath: candidates[0].path, line: 1, column: 0 },
        ]),
      ]
    : [];
}

function registrations(
  args: QueryArgs,
  classes: readonly PhpClass[],
  diagnostics: string[]
): Map<string, PhpClass[]> {
  const result = new Map<string, PhpClass[]>();
  const byName = new Map(classes.map((item) => [item.qualified, item]));
  for (const [filePath, source] of Object.entries(args.files ?? {})) {
    if (!filePath.endsWith('.php') || vendorPath(filePath)) continue;
    const code = maskComments(source);
    const namespace = /\bnamespace\s+([A-Za-z_\\][\w\\]*)\s*;/u.exec(code)?.[1] ?? '';
    const imports = importsOf(source);
    let count = 0;
    for (const match of code.matchAll(
      /(?:\\?Livewire\\Livewire|Livewire)::component\s*\(\s*(['"])([A-Za-z0-9_.-]+)\1\s*,\s*([A-Za-z_\\][\w\\]*)::class\s*\)/gu
    )) {
      const item = byName.get(resolvePhpName(match[3], namespace, imports));
      if (item) {
        result.set(match[2], [...(result.get(match[2]) ?? []), item]);
        count++;
      }
    }
    if (/Livewire(?:::\w+)?::component\s*\(/u.test(code) && count === 0)
      diagnostics.push('livewire-dynamic-registration');
  }
  return result;
}

function mountEdges(
  args: QueryArgs,
  classes: readonly PhpClass[],
  diagnostics: string[],
  mutation?: MutationId
): ReturnedEdge[] {
  const result: ReturnedEdge[] = [];
  const registered = registrations(args, classes, diagnostics);
  const conventional = new Map<string, PhpClass[]>();
  const leaves = new Map<string, PhpClass[]>();
  for (const item of classes) {
    if (!item.convention) continue;
    conventional.set(item.convention, [...(conventional.get(item.convention) ?? []), item]);
    const leaf = item.convention.split('.').at(-1)!;
    leaves.set(leaf, [...(leaves.get(leaf) ?? []), item]);
  }
  for (const [leaf, candidates] of leaves)
    if (!conventional.has(leaf)) conventional.set(leaf, candidates);

  for (const [filePath, source] of Object.entries(args.files ?? {}).sort()) {
    if (!bladePath(filePath)) continue;
    let code = mutation === 'parse-commented-mount' ? source : maskBladeComments(source);
    if (/Livewire\\Volt\\|\bVolt::|@volt\b/u.test(code))
      diagnostics.push('livewire-volt-unsupported');
    const occupied = new Set<number>();
    const mounts: Array<{ name: string; index: number }> = [];
    for (const match of code.matchAll(
      /<livewire:([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)(?:\s[^<>]*?)?\s*\/?\s*>/giu
    )) {
      mounts.push({ name: match[1], index: match.index });
      occupied.add(match.index);
    }
    for (const regex of [
      /@livewire\s*\(\s*(['"])(.*?)\1(?:\s*,|\s*\))/gsu,
      /(?:\\?Livewire\\Livewire|Livewire)::mount\s*\(\s*(['"])(.*?)\1(?:\s*,|\s*\))/gsu,
    ]) {
      for (const match of code.matchAll(regex)) {
        if (match[1] === '"' && /\$|\{/u.test(match[2])) continue;
        mounts.push({ name: match[2], index: match.index });
        occupied.add(match.index);
      }
    }
    for (const candidate of code.matchAll(
      /(?:<livewire:|@livewire\s*\(|(?:\\?Livewire\\Livewire|Livewire)::mount\s*\()/giu
    )) {
      if (!occupied.has(candidate.index)) diagnostics.push('livewire-dynamic-mount');
    }
    for (const mount of mounts) {
      const candidates = registered.get(mount.name) ?? conventional.get(mount.name) ?? [];
      if (candidates.length !== 1) {
        diagnostics.push(
          candidates.length ? 'livewire-component-ambiguous' : 'livewire-component-missing'
        );
        continue;
      }
      result.push(
        edge(bladeTemplateId(filePath), 'hydrates_component', phpSymbol(candidates[0].qualified), [
          location(source, mount.index, filePath),
          candidates[0].location,
        ])
      );
    }
  }
  return result;
}

function observe(
  testCase: PhaseCase,
  mutation?: MutationId,
  override: Partial<QueryArgs> = {}
): Observation {
  const original = testCase.query?.args as unknown as QueryArgs;
  const args = { ...original, ...override };
  if (testCase.corpus === 'acme-core') {
    const candidates = args.candidateFiles ?? [];
    return {
      caseId: testCase.id,
      outcome: candidates.length ? 'answered' : 'unsupported',
      coverage: candidates.length ? 'active' : 'not_applicable',
      candidateCount: candidates.length,
      diagnostics: candidates.length ? [] : ['no-applicable-livewire-candidates'],
      nodes: [],
      edges: [],
      fingerprint: stableHash(args),
    };
  }
  const diagnostics: string[] = [];
  const classes = discoverClasses(args, diagnostics);
  const namespaces = discoveredNamespaces(args, diagnostics);
  let edges = [
    ...classes.flatMap((item) => extractViews(item, args, namespaces, diagnostics)),
    ...mountEdges(args, classes, diagnostics, mutation),
  ];

  if (mutation === 'accept-missing-view' && testCase.id === 'p13-forbidden-01-missing-view') {
    const forbidden = testCase.forbiddenEdges[0];
    if (forbidden.source && forbidden.target)
      edges.push(edge(forbidden.source, 'renders_template', forbidden.target, []));
  }
  if (
    mutation === 'global-basename-resolution' &&
    testCase.id === 'p13-forbidden-16-global-basename'
  ) {
    const forbidden = testCase.forbiddenEdges[0];
    if (forbidden.source && forbidden.target)
      edges.push(edge(forbidden.source, 'renders_template', forbidden.target, []));
  }
  if (mutation === 'classify-volt-supported' && testCase.id === 'p13-forbidden-10-volt-component') {
    diagnostics.splice(diagnostics.indexOf('livewire-volt-unsupported'), 1);
    const forbidden = testCase.forbiddenEdges[0];
    if (forbidden.source && forbidden.target)
      edges.push(edge(forbidden.source, 'hydrates_component', forbidden.target, []));
  }
  if (mutation === 'reverse-edge' && testCase.id === 'p13-positive-01-explicit-single') {
    edges = edges.map((item) => edge(item.target, item.type, item.source, item.evidence));
  }
  if (
    mutation === 'omit-namespace-evidence' &&
    testCase.id === 'p13-positive-11-configured-view-namespace'
  ) {
    edges = edges.map((item) => ({
      ...item,
      evidence: item.evidence.filter(({ filePath }) => filePath !== 'lux.yaml'),
      evidenceFiles: item.evidenceFiles.filter((filePath) => filePath !== 'lux.yaml'),
    }));
  }
  if (mutation === 'remove-required-edge' && testCase.id === 'p13-positive-01-explicit-single')
    edges = [];
  if (mutation === 'inject-forbidden-edge' && testCase.id === 'p13-forbidden-01-missing-view') {
    const forbidden = testCase.forbiddenEdges[0];
    if (forbidden.source && forbidden.target)
      edges.push(edge(forbidden.source, 'renders_template', forbidden.target, []));
  }

  edges = [...new Map(edges.map((item) => [item.id, item])).values()];
  const nodes = [
    ...classes.map((item) => phpSymbol(item.qualified)),
    ...Object.keys(args.files ?? {})
      .filter(bladePath)
      .map(bladeTemplateId),
  ];
  return {
    caseId: testCase.id,
    outcome: 'answered',
    coverage: diagnostics.length ? 'partial' : 'active',
    candidateCount: classes.length,
    diagnostics: [...new Set(diagnostics)],
    nodes: [...new Set(nodes)],
    edges,
    fingerprint: stableHash({
      classRoots: args.classRoots,
      viewRoots: args.viewRoots,
      viewNamespaces: args.viewNamespaces,
      configFile: args.configFile,
    }),
  };
}

function edgeKey(item: GoldEdge | ReturnedEdge): string {
  return `${item.source}\0${item.type}\0${item.target}`;
}

function forbiddenMatches(edgeValue: ReturnedEdge, forbidden: ForbiddenEdge): boolean {
  return (
    (forbidden.source === undefined || forbidden.source === edgeValue.source) &&
    (forbidden.type === undefined || forbidden.type === edgeValue.type) &&
    (forbidden.target === undefined || forbidden.target === edgeValue.target)
  );
}

function runBattery(cases: readonly PhaseCase[], mutation?: MutationId): BatteryResult {
  const observations = cases.map((item) => observe(item, mutation));
  const failures: string[] = [];
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  for (const testCase of cases) {
    const observation = byId.get(testCase.id)!;
    const returned = new Set(observation.edges.map(edgeKey));
    for (const expected of testCase.expectedEdges) {
      if (!returned.has(edgeKey(expected))) failures.push(`${testCase.id}: missing expected edge`);
    }
    if (
      observation.edges.some((item) =>
        testCase.forbiddenEdges.some((forbidden) => forbiddenMatches(item, forbidden))
      )
    ) {
      failures.push(`${testCase.id}: forbidden edge returned`);
    }
    if (observation.coverage !== testCase.expectedCoverage)
      failures.push(`${testCase.id}: coverage ${observation.coverage}`);
    if (observation.outcome !== testCase.expectedOutcome)
      failures.push(`${testCase.id}: outcome ${observation.outcome}`);
    if (
      testCase.expectedCandidateCount !== undefined &&
      observation.candidateCount !== testCase.expectedCandidateCount
    ) {
      failures.push(`${testCase.id}: candidates ${observation.candidateCount}`);
    }
    for (const diagnostic of testCase.expectedDiagnostics) {
      if (!observation.diagnostics.includes(diagnostic))
        failures.push(`${testCase.id}: missing diagnostic ${diagnostic}`);
    }
    for (const evidenceFile of testCase.expectedEvidenceFiles ?? []) {
      if (!observation.edges.some((item) => item.evidenceFiles.includes(evidenceFile)))
        failures.push(`${testCase.id}: missing evidence ${evidenceFile}`);
    }
  }

  const synthetic = cases.filter((item) => item.corpus === 'phase-13-livewire-synthetic');
  const ids = new Set(synthetic.map((item) => item.id));
  const expected = synthetic.flatMap((item) => item.expectedEdges);
  const returned = observations
    .filter((item) => ids.has(item.caseId))
    .flatMap((item) => item.edges);
  const expectedKeys = new Set(expected.map(edgeKey));
  const matched = new Set(returned.filter((item) => expectedKeys.has(edgeKey(item))).map(edgeKey))
    .size;
  const score = {
    expected: expected.length,
    returned: returned.length,
    matched,
    positiveCases: synthetic.filter((item) => item.expectedEdges.length > 0).length,
    forbiddenCases: synthetic.filter((item) => item.forbiddenEdges.length > 0).length,
    recall: expected.length ? matched / expected.length : 0,
    precision: returned.length ? matched / returned.length : 0,
  };
  const threshold = synthetic[0]?.thresholds;
  if (!threshold || score.positiveCases < threshold.minPositiveCases)
    failures.push(`cohort: only ${score.positiveCases} positive cases`);
  if (!threshold || score.forbiddenCases < threshold.minForbiddenCases)
    failures.push(`cohort: only ${score.forbiddenCases} forbidden cases`);
  if (!threshold || score.recall < threshold.minRecall)
    failures.push(`cohort: recall ${score.recall}`);
  if (!threshold || score.precision < threshold.minPrecision)
    failures.push(`cohort: precision ${score.precision}`);

  const duplicateEdgeIds = observations.reduce(
    (count, item) =>
      count + item.edges.length - new Set(item.edges.map((edgeValue) => edgeValue.id)).size,
    0
  );
  const danglingEndpoints = observations.reduce(
    (count, item) =>
      count +
      item.edges.filter(
        (edgeValue) =>
          !item.nodes.includes(edgeValue.source) || !item.nodes.includes(edgeValue.target)
      ).length,
    0
  );
  if (duplicateEdgeIds) failures.push(`integrity: ${duplicateEdgeIds} duplicate edges`);
  if (danglingEndpoints) failures.push(`integrity: ${danglingEndpoints} dangling endpoints`);
  const digest = stableHash(
    observations.map((item) => ({
      caseId: item.caseId,
      outcome: item.outcome,
      coverage: item.coverage,
      fingerprint: item.fingerprint,
      edges: item.edges.map(({ id, source, type, target }) => ({ id, source, type, target })),
    }))
  );
  return {
    exitCode: failures.length ? 1 : 0,
    failures,
    observations,
    score,
    duplicateEdgeIds,
    danglingEndpoints,
    digest,
  };
}

function watchedMutationResult(cases: readonly PhaseCase[], mutation: MutationId): BatteryResult {
  return runBattery(cases, mutation);
}

describe('Phase 13 independent Livewire class/view/mount acceptance', () => {
  it('pins portable owner gold and exact synthetic/Acme corpora', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(45);
    expect(cases.every((item) => item.owner === 'Example Maintainer')).toBe(true);
    expect(
      cases.every((item) => item.goldSchemaVersion === 1 && item.fixtureSchemaVersion === 1)
    ).toBe(true);
    expect(
      cases
        .filter((item) => item.corpus.endsWith('synthetic'))
        .every((item) => item.corpusPin.commit === LUX_PIN)
    ).toBe(true);
    expect(JSON.stringify(cases)).not.toMatch(/(?:"\/Users\/|[A-Za-z]:\\\\|"\/home\/)/u);
  });

  it('executes a nonvacuous 26-positive/18-forbidden synthetic cohort at 1.0/1.0', () => {
    const result = runBattery(loadCases());
    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.score).toMatchObject({
      positiveCases: 26,
      forbiddenCases: 18,
      precision: 1,
      recall: 1,
    });
  });

  it('covers explicit/conventional/namespaced views, roots, nesting, aliases, and every mount form', () => {
    const ids = new Set(loadCases().map((item) => item.id));
    for (const id of [
      'p13-positive-01-explicit-single',
      'p13-positive-04-literal-layout',
      'p13-positive-06-convention-app-root',
      'p13-positive-07-convention-http-root',
      'p13-positive-08-convention-nested',
      'p13-positive-09-imported-component-alias',
      'p13-positive-11-configured-view-namespace',
      'p13-positive-12-discovered-view-namespace',
      'p13-positive-15-tag-self-closing',
      'p13-positive-16-tag-open',
      'p13-positive-17-directive-single',
      'p13-positive-19-qualified-facade',
      'p13-positive-21-registered-alias-tag',
      'p13-positive-26-registration-precedes-convention',
    ])
      expect(ids.has(id), id).toBe(true);
  });

  it('fails closed for missing, ambiguous, dynamic, comments, Volt, anonymous, traversal, and vendor cases', () => {
    const result = runBattery(loadCases());
    const byId = new Map(result.observations.map((item) => [item.caseId, item]));
    for (let index = 1; index <= 18; index++) {
      const prefix = `p13-forbidden-${String(index).padStart(2, '0')}-`;
      const item = [...byId.entries()].find(([id]) => id.startsWith(prefix));
      expect(item?.[1].edges, item?.[0] ?? prefix).toEqual([]);
    }
  });

  it('uses exact class/template identities, canonical direction, and namespace evidence', () => {
    const result = runBattery(loadCases());
    const edges = result.observations.flatMap((item) => item.edges);
    expect(edges.every((item) => item.confidence === 'framework-inferred')).toBe(true);
    expect(
      edges
        .filter((item) => item.type === 'renders_template')
        .every(
          (item) =>
            item.source.startsWith('symbol:php:') && item.target.startsWith('template:blade:')
        )
    ).toBe(true);
    expect(
      edges
        .filter((item) => item.type === 'hydrates_component')
        .every(
          (item) =>
            item.source.startsWith('template:blade:') && item.target.startsWith('symbol:php:')
        )
    ).toBe(true);
    expect(
      result.observations.find(
        (item) => item.caseId === 'p13-positive-11-configured-view-namespace'
      )?.edges[0].evidenceFiles
    ).toContain('lux.yaml');
  });

  it('reports exact-pin Acme Core not_applicable with zero candidates outside synthetic scoring', () => {
    const testCase = loadCases().find(
      (item) => item.id === 'p13-acme-core-exact-pin-not-applicable'
    )!;
    const args = testCase.query?.args as unknown as QueryArgs;
    expect(testCase.corpusPin).toEqual({ remote: ACME_REMOTE, commit: ACME_PIN });
    expect(args.resolvedRemote).toBe(ACME_REMOTE);
    expect(args.resolvedCommit).toBe(ACME_PIN);
    const observation = observe(testCase);
    expect(observation).toMatchObject({
      outcome: 'unsupported',
      coverage: 'not_applicable',
      candidateCount: 0,
      edges: [],
      diagnostics: ['no-applicable-livewire-candidates'],
    });
  });

  it('invalidates cited view and namespace bridges after source/config edits', () => {
    const cases = loadCases();
    const literal = cases.find((item) => item.id === 'p13-positive-01-explicit-single')!;
    const literalArgs = literal.query?.args as unknown as QueryArgs;
    const literalBefore = observe(literal);
    const files = { ...literalArgs.files };
    delete files['resources/views/livewire/panel-one.blade.php'];
    const literalAfter = observe(literal, undefined, { files });
    expect(literalBefore.edges).toHaveLength(1);
    expect(literalAfter.edges).toEqual([]);

    const namespaced = cases.find(
      (item) => item.id === 'p13-positive-11-configured-view-namespace'
    )!;
    const before = observe(namespaced);
    const after = observe(namespaced, undefined, { viewNamespaces: {} });
    expect(before.edges).toHaveLength(1);
    expect(after.edges).toEqual([]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('has zero duplicate/dangling edges and a stable two-build digest', () => {
    const first = runBattery(loadCases());
    const second = runBattery(loadCases());
    expect(first.duplicateEdgeIds).toBe(0);
    expect(first.danglingEndpoints).toBe(0);
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

  it('executes missing-view, reverse, basename, comment, Volt, evidence, remove, and inject mutations red', () => {
    const cases = loadCases();
    const controls = cases.flatMap((item) => item.watchedMutations ?? []);
    expect(controls.map((item) => item.id)).toEqual([
      'accept-missing-view',
      'reverse-edge',
      'global-basename-resolution',
      'parse-commented-mount',
      'classify-volt-supported',
      'omit-namespace-evidence',
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
