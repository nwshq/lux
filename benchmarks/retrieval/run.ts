#!/usr/bin/env npx tsx
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isPathSafeCorpusOrCaseId,
  type CorpusManifestEntryV1,
  type CorpusManifestV1,
  type CorpusResolutionV1,
} from '../corpora/preflight.js';
import {
  loadCheckoutOverrides,
  loadRunnerManifest,
  validateFixtureIdentity,
  withBenchmarkCorpora,
} from '../corpora/runtime.js';

interface BenchmarkFixture {
  schemaVersion: 1;
  goldSchemaVersion: 1;
  owner: string;
  repoId: string;
  corpusId: string;
  cases: BenchmarkCase[];
  fixturePath: string;
  rootPath?: string;
  dbPath?: string;
}

type BenchmarkSurface =
  'feature-path' | 'operational' | 'status' | 'spec-evidence' | 'delta' | 'search' | 'anchors';
type BenchmarkMode = 'overlay' | 'status' | 'delta' | 'search' | 'anchors';

interface BenchmarkCase {
  id: string;
  surface: BenchmarkSurface;
  mode: BenchmarkMode;
  question: string;
  json?: boolean;
  target?: string;
  kind?: string;
  export?: 'json' | 'md';
  // delta-surface options (spec 14/16) — mirror the `lux delta` CLI flags.
  base?: string;
  committedOnly?: boolean;
  check?: boolean;
  failOn?: string;
  depth?: number;
  maxNodes?: number;
  // search-surface fields (spec 14). `question` carries the query text.
  /** top-K cutoff for hit@k / MRR (default 10). */
  k?: number;
  /** relative gold paths; a result whose absolute file_path ends-with/contains one is a hit. */
  expectPathsTopK?: string[];
  /** true = characterize a CURRENT miss: measured + tallied, EXCLUDED from CI pass/fail. */
  knownMiss?: boolean;
  /** optional content-scoping / type override for the search command. */
  content?: boolean;
  // anchors-surface fields (spec 12). `question` carries the concept query text; `k`/`knownMiss` are
  // shared with the search surface above.
  /** expected structural node ids; a result whose `nodeId` equals one is a hit. Exact match — the
   *  surface's contract is node ids, deterministic (astSymbolIdentity), so no suffix/contains fuzz. */
  expectNodeIdsTopK?: string[];
  /** the human accountable for this case set's gold (Decision 10 — a named owner per case set). */
  owner?: string;
  expect: BenchmarkExpectation;
}

interface BenchmarkExpectation {
  exitCode: number;
  corpusSource?: string;
  dbSource?: string;
  askSchemaVersion?: number;
  askSurface?: string;
  askMode?: string;
  askQuestion?: string;
  overlayNativeJson?: boolean;
  overlayTrustLevel?: string;
  minEvidenceTrustTier?: number;
  mixedTrust?: boolean;
  evidenceKindIncludes?: string;
  failureClassIncludes?: string;
  failureClassExcludes?: string;
  contextNodeDisjoint?: boolean;
  resolution?: string;
  intent?: string;
  targetId?: string;
  summaryIncludes?: string;
  summaryExcludes?: string;
  failureIncludes?: string;
  minDirectEvidence?: number;
  minContext?: number;
  overlayMode?: string;
  minSurfaceCount?: number;
  minKnowledgeEntries?: number;
  specEvidenceSurface?: 'spec-derivation-evidence';
  specEvidenceSchemaVersion?: 1;
  sufficiencyOverall?: 'sufficient' | 'partial' | 'insufficient' | 'conflicting';
  canSupportSpecDraft?: boolean;
  minStateChanges?: number;
  minDecisionLogic?: number;
  minDataFlow?: number;
  minOperationalEffects?: number;
  minReviewPrompts?: number;
  targetKind?: 'route' | 'handler' | 'job' | 'listener' | 'command';
  coverageIncludes?: Array<'found' | 'missing' | 'unsupported' | 'not_applicable'>;
  coverageSignalKeysInclude?: string[];
  supportIncludes?: Array<'direct' | 'contextual' | 'weak' | 'insufficient' | 'conflicting'>;
  sourceFactIncludes?: string;
  possibleInterpretationIncludes?: string;
  conflictingEvidenceIncludes?: string;
  exportPathExists?: boolean;
  forbiddenTextIncludes?: string[];
  // delta-surface expectations (spec 14/16, SC-9).
  deltaSchemaVersion?: number;
  deltaSurface?: string;
  minTouchedFiles?: number;
  minTouchedSymbols?: number;
  minModulesChanged?: number;
  minEntrySurfaces?: number;
  /** Assert an EMPTY (not errored) projection — the lux-TS PHP-projection contract (SC-9). */
  emptyEntrySurfaces?: boolean;
  emptyOwnershipTransitions?: boolean;
  emptySpecTargets?: boolean;
  deltaTruncated?: boolean;
  deltaGateCategoriesInclude?: string[];
  // search-surface expectations (spec 14, SC-5).
  /** require ≥1 gold path in top-k (non-knownMiss cases). */
  searchHit?: boolean;
  /** require MRR ≥ this (first-gold reciprocal rank). */
  minMrr?: number;
  /** require an exact result count (the content-scoping benchmark case). */
  expectResultCount?: number;
  /** require a refusal of this class (the invalid-query case). */
  searchRefusalReason?: 'invalid-query' | 'fts-unavailable';
  // anchors-surface expectations (spec 12). `minMrr` is shared with the search surface above.
  /** require ≥1 gold node id in top-k (non-knownMiss cases). */
  anchorHit?: boolean;
  /** require a refusal of this class. */
  anchorRefusalReason?:
    'invalid-query' | 'fts-unavailable' | 'overlay-missing' | 'anchor-texts-absent';
  /** require lowConfidence to be exactly this (the confidence-floor guard case). */
  lowConfidence?: boolean;
}

interface ParsedCasePayload {
  corpusSource?: string;
  dbSource?: string;
  askSchemaVersion?: number;
  askSurface?: string;
  askMode?: string;
  askQuestion?: string;
  overlayNativeJson?: boolean;
  overlayTrustLevel?: string;
  evidenceTrustTiers?: number[];
  mixedTrust?: boolean;
  evidenceKinds?: string[];
  failureClasses?: string[];
  directEvidenceNodeIds?: string[];
  contextNodeIds?: string[];
  resolution?: string;
  intent?: string;
  targetId?: string;
  summary?: string;
  failureText?: string;
  directEvidenceCount?: number;
  contextCount?: number;
  overlayMode?: string;
  surfaceCount?: number;
  knowledgeEntries?: number;
  sufficiencyOverall?: string;
  canSupportSpecDraft?: boolean;
  stateChangesCount?: number;
  decisionLogicCount?: number;
  dataFlowCount?: number;
  operationalEffectsCount?: number;
  reviewPromptsCount?: number;
  targetKind?: string;
  coverageStatuses?: string[];
  coverageSignalKeys?: string[];
  supports?: string[];
  sourceFacts?: string[];
  possibleInterpretations?: string[];
  conflictingEvidence?: string[];
  exportPath?: string;
  stdout?: string;
  // delta-surface parse (envelope on stdout; a preflight refusal prints to stderr with empty stdout).
  deltaSchemaVersion?: number;
  deltaSurface?: string;
  touchedFiles?: number;
  touchedSymbols?: number;
  modulesChangedCount?: number;
  entrySurfacesCount?: number;
  ownershipTransitionsCount?: number;
  specTargetsCount?: number;
  deltaTruncated?: boolean;
  gateViolationCategories?: string[];
  // search-surface parse.
  searchResultPaths?: string[];
  /** 1-based rank of the first gold hit in top-k, or 0 if none. */
  searchHitRank?: number;
  searchResultCount?: number;
  searchRefusalReason?: string;
  // anchors-surface parse.
  anchorResultNodeIds?: string[];
  /** 1-based rank of the first gold node id in top-k, or 0 if none. */
  anchorHitRank?: number;
  anchorLowConfidence?: boolean;
  anchorRefusalReason?: string;
}

interface CommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface CaseResult {
  id: string;
  repoId: string;
  surface: BenchmarkSurface;
  mode: BenchmarkMode;
  command: string[];
  exitCode: number;
  expectedExitCode: number;
  passed: boolean;
  failures: string[];
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  parsed: ParsedCasePayload;
  /** true for a knownMiss case — excluded from the CI pass/fail count (D6). */
  knownMiss?: boolean;
  /** for a knownMiss case: true iff a tier now surfaces gold in top-k (promote it). */
  knownMissClosable?: boolean;
}

interface RepoResult {
  repoId: string;
  repoPath: string;
  status: {
    command: string[];
    exitCode: number;
    durationMs: number;
    path: string;
    overlayMode?: string;
    surfaceCount?: number;
    knowledgeEntries?: number;
  };
  cases: CaseResult[];
}

interface RunnerOptions {
  fixtures: string[];
  outDir: string;
  luxBin: string;
  manifestPath?: string;
  checkoutOverrides?: Readonly<Record<string, string>>;
  preflightOnly: boolean;
}

export function parseArgs(argv: string[]): RunnerOptions {
  const root = repoRoot();
  const fixtures: string[] = [];
  let outDir = join(root, 'benchmarks', 'retrieval', 'results', timestampSlug());
  let luxBin = join(root, 'dist', 'cli', 'index.js');
  let manifestPath: string | undefined;
  let checkoutOverrides: Readonly<Record<string, string>> | undefined;
  let preflightOnly = false;

  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--fixture':
        fixtures.push(resolve(valueAfter(i, token)));
        i++;
        break;
      case '--out':
        outDir = resolve(valueAfter(i, token));
        i++;
        break;
      case '--lux-bin':
        luxBin = resolve(valueAfter(i, token));
        i++;
        break;
      case '--manifest':
        manifestPath = resolve(valueAfter(i, token));
        i++;
        break;
      case '--checkout-overrides':
        checkoutOverrides = loadCheckoutOverrides(valueAfter(i, token));
        i++;
        break;
      case '--preflight-only':
        preflightOnly = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  // Default to one canonical, index-independent Lux refusal case. Legacy fixtures remain available
  // as history but are selected only explicitly and then refused unless an owner-approved manifest
  // names their corpus ID.
  if (fixtures.length === 0) {
    fixtures.push(join(root, 'benchmarks', 'retrieval', 'fixtures', 'lux-preflight.json'));
  }

  return { fixtures, outDir, luxBin, manifestPath, checkoutOverrides, preflightOnly };
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function readFixture(
  path: string,
  manifest: CorpusManifestV1,
  entries: ReadonlyMap<string, CorpusManifestEntryV1>
): BenchmarkFixture {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as BenchmarkFixture;
  validateFixtureIdentity(raw, path, manifest, entries);
  if (!isPathSafeCorpusOrCaseId(raw.repoId)) {
    throw new Error(`${path}: repoId must be one path-safe result identity`);
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`${path}: cases must be a non-empty array`);
  }
  const caseIds = new Set<string>();
  for (const testCase of raw.cases) {
    if (!testCase || !isPathSafeCorpusOrCaseId(testCase.id)) {
      throw new Error(`${path}: every case ID must be one path-safe ID`);
    }
    if (caseIds.has(testCase.id)) throw new Error(`${path}: duplicate case ID ${testCase.id}`);
    caseIds.add(testCase.id);
    if (typeof testCase.question !== 'string' || !testCase.expect) {
      throw new Error(`${path}: case ${testCase.id} requires question and expect`);
    }
  }
  return { ...raw, fixturePath: path };
}

function buildCaseCommand(
  luxBin: string,
  fixture: BenchmarkFixture,
  testCase: BenchmarkCase,
  exportPath?: string
): string[] {
  if (!fixture.rootPath || !fixture.dbPath) throw new Error('Corpus runtime was not prepared');
  const command = ['node', luxBin, '--corpus', fixture.rootPath, '--db', fixture.dbPath];

  if (testCase.surface === 'status') {
    command.push('index', 'status', '--json');
    return command;
  }

  if (testCase.surface === 'delta') {
    command.push('delta', '--json');
    if (testCase.base) command.push('--base', testCase.base);
    if (testCase.committedOnly) command.push('--committed-only');
    if (testCase.depth !== undefined) command.push('--depth', String(testCase.depth));
    if (testCase.maxNodes !== undefined) command.push('--max-nodes', String(testCase.maxNodes));
    if (testCase.check) command.push('--check');
    if (testCase.failOn) command.push('--fail-on', testCase.failOn);
    return command;
  }

  if (testCase.surface === 'search') {
    const k = testCase.k ?? 10;
    command.push('search', testCase.question, '--json', '--limit', String(k));
    if (testCase.content) command.push('--content');
    // default --type all; a case may pin --type via `kind` if ever needed (unused in v1 seeds).
    return command;
  }

  if (testCase.surface === 'anchors') {
    const k = testCase.k ?? 10;
    command.push('anchors', testCase.question, '--json', '--limit', String(k));
    return command;
  }

  command.push('overlay', testCase.surface, 'ask');
  if (testCase.json) command.push('--json');
  if (testCase.target) command.push('--target', testCase.target);
  if (testCase.kind) command.push('--kind', testCase.kind);
  if (exportPath) command.push('--out', exportPath);
  command.push(testCase.question);
  return command;
}

function runCommand(command: string[]): CommandResult {
  const start = Date.now();
  const child = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  return {
    command,
    exitCode: child.status ?? 1,
    stdout: child.stdout,
    stderr: child.stderr,
    durationMs: Date.now() - start,
  };
}

function parseJsonOutput(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

function asNumberArray(value: unknown): number[] {
  return asArray(value).filter((item): item is number => typeof item === 'number');
}

function parseCasePayload(testCase: BenchmarkCase, stdout: string): ParsedCasePayload {
  const parsed = parseJsonOutput(stdout);
  if (parsed === undefined) return parseTextPayload(stdout, testCase);

  const root = asRecord(parsed);
  if (testCase.surface === 'status') return parseStatusPayload(root);
  if (testCase.surface === 'spec-evidence') return parseSpecEvidencePayload(root, stdout);
  if (testCase.surface === 'delta') return parseDeltaPayload(root, stdout);
  if (testCase.surface === 'search') return parseSearchPayload(root, testCase);
  if (testCase.surface === 'anchors') return parseAnchorPayload(root, testCase);

  const payload = asRecord(root.payload ?? root);
  const resolution = asRecord(payload.resolution);
  const target = asRecord(payload.target);
  const primaryAnswer = asRecord(payload.primaryAnswer);
  const trust = asRecord(payload.trust);
  const directEvidence = asArray(payload.directEvidence ?? payload.evidence);
  const context = asArray(payload.context);

  return {
    askSchemaVersion: asNumber(root.schemaVersion),
    askSurface: asString(root.surface),
    askMode: asString(root.mode),
    askQuestion: asString(root.question),
    overlayNativeJson: testCase.mode === 'overlay' ? root.payload === undefined : undefined,
    overlayTrustLevel: asString(payload.overlayTrustLevel),
    evidenceTrustTiers: asNumberArray(trust.evidenceTrustTiers),
    mixedTrust: asBoolean(trust.mixedTrust),
    evidenceKinds: extractKinds(directEvidence),
    failureClasses: extractFailureClasses(payload),
    directEvidenceNodeIds: extractNodeIds(directEvidence),
    contextNodeIds: extractNodeIds(context),
    resolution: asString(resolution.status),
    intent: asString(payload.intent),
    targetId: asString(target.id),
    summary: asString(primaryAnswer.summary),
    failureText: extractJsonFailureText(payload),
    directEvidenceCount: directEvidence.length,
    contextCount: context.length,
    stdout,
  };
}

function parseSpecEvidencePayload(
  root: Record<string, unknown>,
  stdout: string
): ParsedCasePayload {
  const target = asRecord(root.target);
  const sufficiency = asRecord(root.sufficiency);
  const coverage = asRecord(root.coverage);
  const stateChanges = asArray(root.stateChanges);
  const decisionLogic = asArray(root.decisionLogic);
  const dataFlow = asArray(root.dataFlow);
  const operationalEffects = asArray(root.operationalEffects);
  const supportingContext = asArray(root.supportingContext);
  const allClaims = [
    ...stateChanges,
    ...decisionLogic,
    ...dataFlow,
    ...operationalEffects,
    ...supportingContext,
  ].map(asRecord);
  const coverageRecords = Object.values(coverage).map(asRecord);

  return {
    askSchemaVersion: asNumber(root.schemaVersion),
    askSurface: asString(root.surface),
    askMode: asString(root.mode),
    askQuestion: asString(root.question),
    resolution: asString(target.resolutionState),
    targetId: asString(target.resolvedNodeId),
    targetKind: asString(target.kind),
    sufficiencyOverall: asString(sufficiency.overall),
    canSupportSpecDraft: asBoolean(sufficiency.canSupportSpecDraft),
    stateChangesCount: stateChanges.length,
    decisionLogicCount: decisionLogic.length,
    dataFlowCount: dataFlow.length,
    operationalEffectsCount: operationalEffects.length,
    reviewPromptsCount: asArray(root.reviewPrompts).length,
    coverageStatuses: coverageRecords
      .flatMap((record) => Object.values(record))
      .filter((value): value is string => typeof value === 'string'),
    coverageSignalKeys: coverageRecords.flatMap((record) => Object.keys(record)),
    supports: allClaims
      .map((claim) => asString(claim.support))
      .filter((value): value is string => Boolean(value)),
    sourceFacts: allClaims
      .map((claim) => asString(claim.sourceFact))
      .filter((value): value is string => Boolean(value)),
    possibleInterpretations: allClaims
      .map((claim) => asString(claim.possibleInterpretation))
      .filter((value): value is string => Boolean(value)),
    conflictingEvidence: asStringArray(sufficiency.conflictingEvidence),
    stdout,
  };
}

function parseTextPayload(stdout: string, testCase: BenchmarkCase): ParsedCasePayload {
  const summary = stdout.split('\n').find((line) => line.trim().length > 0);
  const directEvidenceSection = sectionLineCount(stdout, 'Direct evidence', [
    'Failures',
    'Context',
    'Transport',
  ]);
  const contextSection = sectionLineCount(stdout, 'Context', ['Failures']);
  const resolutionMatch = stdout.match(/Resolution:\s+(\w+)/i);
  const resolutionMatchLine = stdout.match(/^Resolution Match:\s+(.+)$/m);
  const targetMatch = stdout.match(/^Target:\s+(.+)$/m);

  return {
    resolution: resolutionMatch?.[1] ?? (resolutionMatchLine ? 'resolved' : undefined),
    intent: inferTextIntent(testCase),
    targetId: targetMatch?.[1],
    summary,
    failureText: extractTextFailureText(stdout),
    directEvidenceCount: directEvidenceSection,
    contextCount: contextSection,
    stdout,
  };
}

function extractKinds(items: unknown[]): string[] {
  return items
    .map((item) => asString(asRecord(item).kind))
    .filter((kind): kind is string => Boolean(kind));
}

function extractNodeIds(items: unknown[]): string[] {
  return items
    .map((item) => asString(asRecord(item).nodeId))
    .filter((nodeId): nodeId is string => Boolean(nodeId));
}

function extractFailureClasses(payload: Record<string, unknown>): string[] {
  return asArray(payload.failures)
    .map((failure) => asString(asRecord(failure).failureClass))
    .filter((failureClass): failureClass is string => Boolean(failureClass));
}

function extractJsonFailureText(payload: Record<string, unknown>): string {
  return asArray(payload.failures)
    .map((failure) => {
      const record = asRecord(failure);
      return [asString(record.failureClass), asString(record.detail)].filter(Boolean).join(': ');
    })
    .filter(Boolean)
    .join('\n');
}

function extractTextFailureText(stdout: string): string {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === 'failures');
  if (start === -1) return '';
  return lines
    .slice(start + 1)
    .join('\n')
    .trim();
}

function inferTextIntent(testCase: BenchmarkCase): string | undefined {
  if (testCase.surface !== 'operational') return undefined;
  const question = testCase.question.toLowerCase();
  if (question.includes('listener') || question.includes('what handles')) return 'event-listeners';
  if (question.includes('dispatch')) return 'dispatch-sources';
  if (question.includes('schedule')) return 'schedule-sources';
  if (question.includes('neighborhood') || question.includes('can reach')) return 'neighborhood';
  return undefined;
}

function sectionLineCount(stdout: string, heading: string, stopHeadings: string[]): number {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return 0;
  let count = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (stopHeadings.some((stop) => trimmed.toLowerCase() === stop.toLowerCase())) break;
    if (trimmed.startsWith('- ') && !trimmed.includes('none')) count++;
  }
  return count;
}

function parseStatusPayload(root: Record<string, unknown>): ParsedCasePayload {
  const stats = asRecord(root.stats);
  const overlay = asRecord(root.overlay);
  const runtime = asRecord(root.runtime);
  return {
    corpusSource: asString(runtime.corpusSource),
    dbSource: asString(runtime.dbSource),
    overlayMode: asString(overlay.mode),
    surfaceCount: asNumber(overlay.surfaceCount),
    knowledgeEntries: asNumber(stats.knowledge_entries),
  };
}

/**
 * Parse the `lux delta --json` envelope (spec 15). `root` is the schemaVersion:1 report. A `--check`
 * gate violation still prints the report on stdout (with `gate.violations`); a preflight refusal
 * (bad --base, non-git) prints nothing on stdout and is asserted via exitCode.
 */
function parseDeltaPayload(root: Record<string, unknown>, stdout: string): ParsedCasePayload {
  const touched = asRecord(root.touched);
  const downstream = asRecord(root.downstream);
  const budget = asRecord(downstream.budget);
  const modules = asRecord(root.modules);
  const ownership = asRecord(root.ownership);
  const invalidated = asRecord(root.invalidatedEvidence);
  const gate = asRecord(root.gate);
  return {
    deltaSchemaVersion: asNumber(root.schemaVersion),
    deltaSurface: asString(root.surface),
    touchedFiles: asNumber(touched.files),
    touchedSymbols: asNumber(touched.symbols),
    modulesChangedCount: asArray(modules.changed).length,
    entrySurfacesCount: asArray(downstream.entrySurfaces).length,
    ownershipTransitionsCount: asArray(ownership.transitions).length,
    specTargetsCount: asArray(invalidated.specTargets).length,
    deltaTruncated: asBoolean(budget.truncated),
    gateViolationCategories: asArray(gate.violations)
      .map((violation) => asString(asRecord(violation).category))
      .filter((category): category is string => Boolean(category)),
    stdout,
  };
}

/** Parse the SearchReportV1 envelope (spec 12): gold-hit rank, result count, refusal reason. */
function parseSearchPayload(
  root: Record<string, unknown>,
  testCase: BenchmarkCase
): ParsedCasePayload {
  const results = asArray(root.results).map(asRecord);
  const paths = results.map((r) => asString(r.filePath)).filter((p): p is string => Boolean(p));
  const refusal = asRecord(root.refusal);
  const gold = testCase.expectPathsTopK ?? [];
  const k = testCase.k ?? 10;
  const topK = paths.slice(0, k);
  let hitRank = 0;
  for (let i = 0; i < topK.length; i++) {
    if (gold.some((g) => topK[i] === g || topK[i].endsWith(g) || topK[i].includes(g))) {
      hitRank = i + 1;
      break;
    }
  }
  return {
    searchResultPaths: paths,
    searchHitRank: hitRank,
    searchResultCount: paths.length,
    searchRefusalReason: asString(refusal.reason),
    stdout: JSON.stringify(root),
  };
}

/** Parse the AnchorReportV1 envelope (spec 11): gold-hit rank over node ids, lowConfidence, refusal. */
function parseAnchorPayload(
  root: Record<string, unknown>,
  testCase: BenchmarkCase
): ParsedCasePayload {
  const results = asArray(root.results).map(asRecord);
  const nodeIds = results.map((r) => asString(r.nodeId)).filter((n): n is string => Boolean(n));
  const refusal = asRecord(root.refusal);
  const gold = testCase.expectNodeIdsTopK ?? [];
  const k = testCase.k ?? 10;
  const topK = nodeIds.slice(0, k);
  let hitRank = 0;
  for (let i = 0; i < topK.length; i++) {
    if (gold.includes(topK[i])) {
      hitRank = i + 1;
      break;
    }
  }
  return {
    anchorResultNodeIds: nodeIds,
    anchorHitRank: hitRank,
    anchorLowConfidence: root.lowConfidence === true,
    anchorRefusalReason: asString(refusal.reason),
    stdout: JSON.stringify(root),
  };
}

function targetMatches(actual: string | undefined, expected: string): boolean {
  if (actual === expected) return true;
  if (!actual) return false;
  const normalizedActual = actual.split(' (')[0];
  const withoutOperationalPrefix = expected.replace(/^opb:/, '');
  const withoutSurfacePrefix = expected.replace(/^surface:http:[A-Z]+:/, '');
  const expectedMethodPath = expected.replace(/^surface:http:/, '').replace(':', ' ');
  return (
    normalizedActual === withoutOperationalPrefix ||
    normalizedActual === withoutSurfacePrefix ||
    normalizedActual === expectedMethodPath
  );
}

function validateExpectation(
  expect: BenchmarkExpectation,
  actual: ParsedCasePayload,
  exitCode: number,
  testCase: BenchmarkCase
): string[] {
  const failures: string[] = [];
  if (exitCode !== expect.exitCode)
    failures.push(`exitCode expected ${expect.exitCode}, got ${exitCode}`);
  // anchors-surface scoring (spec 12 Part E). runCase returns EARLY for knownMiss anchor cases, so
  // those never reach here and never fail CI (Decision 10); the `!knownMiss` guard is belt-and-braces.
  if (testCase.surface === 'anchors' && !testCase.knownMiss) {
    if (expect.anchorRefusalReason && actual.anchorRefusalReason !== expect.anchorRefusalReason)
      failures.push(
        `anchor refusal expected ${expect.anchorRefusalReason}, got ${actual.anchorRefusalReason ?? 'none'}`
      );
    if (expect.anchorHit && (actual.anchorHitRank ?? 0) === 0)
      failures.push(`expected a gold node id in top-k, got none`);
    if (expect.minMrr !== undefined) {
      const mrr = (actual.anchorHitRank ?? 0) > 0 ? 1 / actual.anchorHitRank! : 0;
      if (mrr < expect.minMrr)
        failures.push(`MRR expected >= ${expect.minMrr}, got ${mrr.toFixed(3)}`);
    }
    if (expect.lowConfidence !== undefined && actual.anchorLowConfidence !== expect.lowConfidence)
      failures.push(
        `lowConfidence expected ${expect.lowConfidence}, got ${actual.anchorLowConfidence}`
      );
  }
  // search-surface scoring (spec 14 Part E). This block runs only for a parsed search payload
  // (parseSearchPayload always sets searchResultPaths); runCase returns EARLY for knownMiss cases,
  // so those never reach here and never fail CI (D6).
  if (actual.searchResultPaths !== undefined) {
    if (expect.searchRefusalReason && actual.searchRefusalReason !== expect.searchRefusalReason)
      failures.push(
        `search refusal expected ${expect.searchRefusalReason}, got ${actual.searchRefusalReason ?? 'none'}`
      );
    if (expect.searchHit && (actual.searchHitRank ?? 0) === 0)
      failures.push(`expected a gold hit in top-k, got none`);
    if (expect.minMrr !== undefined) {
      const mrr = (actual.searchHitRank ?? 0) > 0 ? 1 / actual.searchHitRank! : 0;
      if (mrr < expect.minMrr)
        failures.push(`MRR expected >= ${expect.minMrr}, got ${mrr.toFixed(3)}`);
    }
    if (
      expect.expectResultCount !== undefined &&
      actual.searchResultCount !== expect.expectResultCount
    )
      failures.push(
        `result count expected ${expect.expectResultCount}, got ${actual.searchResultCount ?? 0}`
      );
  }
  if (expect.corpusSource && actual.corpusSource !== expect.corpusSource)
    failures.push(
      `corpusSource expected ${expect.corpusSource}, got ${actual.corpusSource ?? 'missing'}`
    );
  if (expect.dbSource && actual.dbSource !== expect.dbSource)
    failures.push(`dbSource expected ${expect.dbSource}, got ${actual.dbSource ?? 'missing'}`);
  if (expect.askSchemaVersion && actual.askSchemaVersion !== expect.askSchemaVersion)
    failures.push(
      `askSchemaVersion expected ${expect.askSchemaVersion}, got ${actual.askSchemaVersion ?? 'missing'}`
    );
  if (expect.askSurface && actual.askSurface !== expect.askSurface)
    failures.push(
      `askSurface expected ${expect.askSurface}, got ${actual.askSurface ?? 'missing'}`
    );
  if (expect.askMode && actual.askMode !== expect.askMode)
    failures.push(`askMode expected ${expect.askMode}, got ${actual.askMode ?? 'missing'}`);
  if (expect.askQuestion && actual.askQuestion !== expect.askQuestion)
    failures.push(
      `askQuestion expected ${JSON.stringify(expect.askQuestion)}, got ${JSON.stringify(actual.askQuestion ?? 'missing')}`
    );
  if (
    expect.overlayNativeJson !== undefined &&
    actual.overlayNativeJson !== expect.overlayNativeJson
  )
    failures.push(
      `overlayNativeJson expected ${expect.overlayNativeJson}, got ${actual.overlayNativeJson ?? 'missing'}`
    );
  if (expect.overlayTrustLevel && actual.overlayTrustLevel !== expect.overlayTrustLevel)
    failures.push(
      `overlayTrustLevel expected ${expect.overlayTrustLevel}, got ${actual.overlayTrustLevel ?? 'missing'}`
    );
  if (
    expect.minEvidenceTrustTier !== undefined &&
    !actual.evidenceTrustTiers?.some((tier) => tier >= expect.minEvidenceTrustTier!)
  )
    failures.push(
      `evidenceTrustTiers expected at least one >= ${expect.minEvidenceTrustTier}, got ${(actual.evidenceTrustTiers ?? []).join(',') || 'none'}`
    );
  if (expect.mixedTrust !== undefined && actual.mixedTrust !== expect.mixedTrust)
    failures.push(
      `mixedTrust expected ${expect.mixedTrust}, got ${actual.mixedTrust ?? 'missing'}`
    );
  if (expect.evidenceKindIncludes && !actual.evidenceKinds?.includes(expect.evidenceKindIncludes))
    failures.push(`evidence kind missing ${JSON.stringify(expect.evidenceKindIncludes)}`);
  if (expect.failureClassIncludes && !actual.failureClasses?.includes(expect.failureClassIncludes))
    failures.push(`failure class missing ${JSON.stringify(expect.failureClassIncludes)}`);
  if (expect.failureClassExcludes && actual.failureClasses?.includes(expect.failureClassExcludes))
    failures.push(`failure class must not include ${JSON.stringify(expect.failureClassExcludes)}`);
  if (expect.contextNodeDisjoint && hasOverlap(actual.directEvidenceNodeIds, actual.contextNodeIds))
    failures.push('direct evidence and context node ids must be disjoint');
  if (expect.resolution && actual.resolution !== expect.resolution)
    failures.push(
      `resolution expected ${expect.resolution}, got ${actual.resolution ?? 'missing'}`
    );
  if (expect.intent && actual.intent !== expect.intent)
    failures.push(`intent expected ${expect.intent}, got ${actual.intent ?? 'missing'}`);
  if (expect.targetId && !targetMatches(actual.targetId, expect.targetId))
    failures.push(`targetId expected ${expect.targetId}, got ${actual.targetId ?? 'missing'}`);
  if (expect.summaryIncludes && !actual.summary?.includes(expect.summaryIncludes))
    failures.push(`summary missing ${JSON.stringify(expect.summaryIncludes)}`);
  if (expect.summaryExcludes && actual.summary?.includes(expect.summaryExcludes))
    failures.push(`summary must not include ${JSON.stringify(expect.summaryExcludes)}`);
  if (expect.failureIncludes && !actual.failureText?.includes(expect.failureIncludes))
    failures.push(`failure text missing ${JSON.stringify(expect.failureIncludes)}`);
  if (
    expect.minDirectEvidence !== undefined &&
    (actual.directEvidenceCount ?? 0) < expect.minDirectEvidence
  )
    failures.push(
      `direct evidence expected >= ${expect.minDirectEvidence}, got ${actual.directEvidenceCount ?? 0}`
    );
  if (expect.minContext !== undefined && (actual.contextCount ?? 0) < expect.minContext)
    failures.push(`context expected >= ${expect.minContext}, got ${actual.contextCount ?? 0}`);
  if (expect.overlayMode && actual.overlayMode !== expect.overlayMode)
    failures.push(
      `overlayMode expected ${expect.overlayMode}, got ${actual.overlayMode ?? 'missing'}`
    );
  if (expect.minSurfaceCount !== undefined && (actual.surfaceCount ?? 0) < expect.minSurfaceCount)
    failures.push(
      `surfaceCount expected >= ${expect.minSurfaceCount}, got ${actual.surfaceCount ?? 0}`
    );
  if (
    expect.minKnowledgeEntries !== undefined &&
    (actual.knowledgeEntries ?? 0) < expect.minKnowledgeEntries
  )
    failures.push(
      `knowledgeEntries expected >= ${expect.minKnowledgeEntries}, got ${actual.knowledgeEntries ?? 0}`
    );
  if (expect.specEvidenceSurface && actual.askSurface !== expect.specEvidenceSurface)
    failures.push(
      `specEvidenceSurface expected ${expect.specEvidenceSurface}, got ${actual.askSurface ?? 'missing'}`
    );
  if (
    expect.specEvidenceSchemaVersion !== undefined &&
    actual.askSchemaVersion !== expect.specEvidenceSchemaVersion
  )
    failures.push(
      `specEvidenceSchemaVersion expected ${expect.specEvidenceSchemaVersion}, got ${actual.askSchemaVersion ?? 'missing'}`
    );
  if (expect.sufficiencyOverall && actual.sufficiencyOverall !== expect.sufficiencyOverall)
    failures.push(
      `sufficiencyOverall expected ${expect.sufficiencyOverall}, got ${actual.sufficiencyOverall ?? 'missing'}`
    );
  if (
    expect.canSupportSpecDraft !== undefined &&
    actual.canSupportSpecDraft !== expect.canSupportSpecDraft
  )
    failures.push(
      `canSupportSpecDraft expected ${expect.canSupportSpecDraft}, got ${actual.canSupportSpecDraft ?? 'missing'}`
    );
  if (expect.targetKind && actual.targetKind !== expect.targetKind)
    failures.push(
      `targetKind expected ${expect.targetKind}, got ${actual.targetKind ?? 'missing'}`
    );
  if (
    expect.minStateChanges !== undefined &&
    (actual.stateChangesCount ?? 0) < expect.minStateChanges
  )
    failures.push(
      `stateChanges expected >= ${expect.minStateChanges}, got ${actual.stateChangesCount ?? 0}`
    );
  if (
    expect.minDecisionLogic !== undefined &&
    (actual.decisionLogicCount ?? 0) < expect.minDecisionLogic
  )
    failures.push(
      `decisionLogic expected >= ${expect.minDecisionLogic}, got ${actual.decisionLogicCount ?? 0}`
    );
  if (expect.minDataFlow !== undefined && (actual.dataFlowCount ?? 0) < expect.minDataFlow)
    failures.push(`dataFlow expected >= ${expect.minDataFlow}, got ${actual.dataFlowCount ?? 0}`);
  if (
    expect.minOperationalEffects !== undefined &&
    (actual.operationalEffectsCount ?? 0) < expect.minOperationalEffects
  )
    failures.push(
      `operationalEffects expected >= ${expect.minOperationalEffects}, got ${actual.operationalEffectsCount ?? 0}`
    );
  if (
    expect.minReviewPrompts !== undefined &&
    (actual.reviewPromptsCount ?? 0) < expect.minReviewPrompts
  )
    failures.push(
      `reviewPrompts expected >= ${expect.minReviewPrompts}, got ${actual.reviewPromptsCount ?? 0}`
    );
  for (const status of expect.coverageIncludes ?? []) {
    if (!actual.coverageStatuses?.includes(status)) failures.push(`coverage missing ${status}`);
  }
  for (const key of expect.coverageSignalKeysInclude ?? []) {
    if (!actual.coverageSignalKeys?.includes(key)) failures.push(`coverage key missing ${key}`);
  }
  for (const support of expect.supportIncludes ?? []) {
    if (!actual.supports?.includes(support)) failures.push(`support missing ${support}`);
  }
  if (
    expect.sourceFactIncludes &&
    !actual.sourceFacts?.some((fact) => fact.includes(expect.sourceFactIncludes!))
  )
    failures.push(`source facts missing ${JSON.stringify(expect.sourceFactIncludes)}`);
  if (
    expect.possibleInterpretationIncludes &&
    !actual.possibleInterpretations?.some((fact) =>
      fact.includes(expect.possibleInterpretationIncludes!)
    )
  )
    failures.push(
      `possible interpretations missing ${JSON.stringify(expect.possibleInterpretationIncludes)}`
    );
  if (
    expect.conflictingEvidenceIncludes &&
    !actual.conflictingEvidence?.some((fact) => fact.includes(expect.conflictingEvidenceIncludes!))
  )
    failures.push(
      `conflicting evidence missing ${JSON.stringify(expect.conflictingEvidenceIncludes)}`
    );
  if (expect.exportPathExists && (!actual.exportPath || !existsSync(actual.exportPath)))
    failures.push(`export path missing ${actual.exportPath ?? 'missing'}`);
  for (const forbidden of expect.forbiddenTextIncludes ?? []) {
    if (actual.stdout?.includes(forbidden)) {
      failures.push(`stdout must not include ${JSON.stringify(forbidden)}`);
    }
  }
  if (
    expect.deltaSchemaVersion !== undefined &&
    actual.deltaSchemaVersion !== expect.deltaSchemaVersion
  )
    failures.push(
      `deltaSchemaVersion expected ${expect.deltaSchemaVersion}, got ${actual.deltaSchemaVersion ?? 'missing'}`
    );
  if (expect.deltaSurface && actual.deltaSurface !== expect.deltaSurface)
    failures.push(
      `deltaSurface expected ${expect.deltaSurface}, got ${actual.deltaSurface ?? 'missing'}`
    );
  if (expect.minTouchedFiles !== undefined && (actual.touchedFiles ?? 0) < expect.minTouchedFiles)
    failures.push(
      `touchedFiles expected >= ${expect.minTouchedFiles}, got ${actual.touchedFiles ?? 0}`
    );
  if (
    expect.minTouchedSymbols !== undefined &&
    (actual.touchedSymbols ?? 0) < expect.minTouchedSymbols
  )
    failures.push(
      `touchedSymbols expected >= ${expect.minTouchedSymbols}, got ${actual.touchedSymbols ?? 0}`
    );
  if (
    expect.minModulesChanged !== undefined &&
    (actual.modulesChangedCount ?? 0) < expect.minModulesChanged
  )
    failures.push(
      `modulesChanged expected >= ${expect.minModulesChanged}, got ${actual.modulesChangedCount ?? 0}`
    );
  if (
    expect.minEntrySurfaces !== undefined &&
    (actual.entrySurfacesCount ?? 0) < expect.minEntrySurfaces
  )
    failures.push(
      `entrySurfaces expected >= ${expect.minEntrySurfaces}, got ${actual.entrySurfacesCount ?? 0}`
    );
  if (expect.emptyEntrySurfaces && (actual.entrySurfacesCount ?? 0) !== 0)
    failures.push(
      `entrySurfaces expected EMPTY (not errored), got ${actual.entrySurfacesCount ?? 0}`
    );
  if (expect.emptyOwnershipTransitions && (actual.ownershipTransitionsCount ?? 0) !== 0)
    failures.push(
      `ownership transitions expected EMPTY (not errored), got ${actual.ownershipTransitionsCount ?? 0}`
    );
  if (expect.emptySpecTargets && (actual.specTargetsCount ?? 0) !== 0)
    failures.push(`spec targets expected EMPTY (not errored), got ${actual.specTargetsCount ?? 0}`);
  if (expect.deltaTruncated !== undefined && actual.deltaTruncated !== expect.deltaTruncated)
    failures.push(
      `delta truncated expected ${expect.deltaTruncated}, got ${actual.deltaTruncated ?? 'missing'}`
    );
  for (const category of expect.deltaGateCategoriesInclude ?? []) {
    if (!actual.gateViolationCategories?.includes(category))
      failures.push(`gate violation missing category ${category}`);
  }
  return failures;
}

function hasOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return false;
  const set = new Set(a);
  return b.some((item) => set.has(item));
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function runFixture(fixture: BenchmarkFixture, options: RunnerOptions): RepoResult {
  if (!fixture.rootPath || !fixture.dbPath || !existsSync(fixture.rootPath)) {
    throw new Error(`${fixture.repoId}: isolated corpus runtime is unavailable`);
  }

  const repoOut = join(options.outDir, fixture.repoId);
  mkdirSync(repoOut, { recursive: true });

  const statusCommand = [
    'node',
    options.luxBin,
    '--corpus',
    fixture.rootPath,
    '--db',
    fixture.dbPath,
    'index',
    'status',
    '--json',
  ];
  const statusResult = runCommand(statusCommand);
  const statusPath = join(repoOut, 'status.json');
  writeText(statusPath, statusResult.stdout);
  writeText(join(repoOut, 'status.stderr.txt'), statusResult.stderr);
  const statusPayload = parseStatusPayload(asRecord(parseJsonOutput(statusResult.stdout)));

  const cases = fixture.cases.map((testCase) => runCase(fixture, testCase, options, repoOut));
  return {
    repoId: fixture.repoId,
    repoPath: fixture.rootPath,
    status: {
      command: statusCommand,
      exitCode: statusResult.exitCode,
      durationMs: statusResult.durationMs,
      path: statusPath,
      overlayMode: statusPayload.overlayMode,
      surfaceCount: statusPayload.surfaceCount,
      knowledgeEntries: statusPayload.knowledgeEntries,
    },
    cases,
  };
}

function runCase(
  fixture: BenchmarkFixture,
  testCase: BenchmarkCase,
  options: RunnerOptions,
  repoOut: string
): CaseResult {
  const exportPath = testCase.export
    ? join(repoOut, `${testCase.id}.${testCase.export}`)
    : undefined;
  const command = buildCaseCommand(options.luxBin, fixture, testCase, exportPath);
  const result = runCommand(command);
  const stdoutPath = join(repoOut, `${testCase.id}.stdout.txt`);
  const stderrPath = join(repoOut, `${testCase.id}.stderr.txt`);
  writeText(stdoutPath, result.stdout);
  writeText(stderrPath, result.stderr);
  const parsed = { ...parseCasePayload(testCase, result.stdout), exportPath };

  // knownMiss (D6): the RETRIEVAL-QUALITY assertions (searchHit/minMrr) are measured but excluded
  // from CI pass/fail. A case is `closable` when a tier now surfaces gold in top-k (the author should
  // promote it to a real assertion). The one invariant a knownMiss still carries is the exit code —
  // a case that starts CRASHING (a nonzero exit where exit 0 was expected) must redden, not stay
  // green on the strength of `passed:true` (n9).
  if (testCase.surface === 'search' && testCase.knownMiss) {
    const closable = (parsed.searchHitRank ?? 0) > 0;
    const exitOk = result.exitCode === testCase.expect.exitCode;
    return {
      id: testCase.id,
      repoId: fixture.repoId,
      surface: testCase.surface,
      mode: testCase.mode,
      command,
      exitCode: result.exitCode,
      expectedExitCode: testCase.expect.exitCode,
      passed: exitOk, // retrieval miss never reddens; a crash (unexpected exit) does
      failures: exitOk
        ? []
        : [`knownMiss exitCode expected ${testCase.expect.exitCode}, got ${result.exitCode}`],
      durationMs: result.durationMs,
      stdoutPath,
      stderrPath,
      parsed,
      knownMiss: true,
      knownMissClosable: closable,
    };
  }

  // knownMiss (Decision 10) for the anchors surface: a vocabulary-mismatch case the lexical tier
  // provably cannot reach. Measured + tallied but excluded from CI pass/fail; `closable` when a tier
  // now surfaces gold in top-k — which, for the anchor plane, is what the Phase-3 semantic half must
  // flip (its lift evidence). The exit-code invariant still holds (a crash reddens, as with search).
  if (testCase.surface === 'anchors' && testCase.knownMiss) {
    const closable = (parsed.anchorHitRank ?? 0) > 0;
    const exitOk = result.exitCode === testCase.expect.exitCode;
    return {
      id: testCase.id,
      repoId: fixture.repoId,
      surface: testCase.surface,
      mode: testCase.mode,
      command,
      exitCode: result.exitCode,
      expectedExitCode: testCase.expect.exitCode,
      passed: exitOk, // retrieval miss never reddens; a crash (unexpected exit) does
      failures: exitOk
        ? []
        : [`knownMiss exitCode expected ${testCase.expect.exitCode}, got ${result.exitCode}`],
      durationMs: result.durationMs,
      stdoutPath,
      stderrPath,
      parsed,
      knownMiss: true,
      knownMissClosable: closable,
    };
  }

  const failures = validateExpectation(testCase.expect, parsed, result.exitCode, testCase);

  return {
    id: testCase.id,
    repoId: fixture.repoId,
    surface: testCase.surface,
    mode: testCase.mode,
    command,
    exitCode: result.exitCode,
    expectedExitCode: testCase.expect.exitCode,
    passed: failures.length === 0,
    failures,
    durationMs: result.durationMs,
    stdoutPath,
    stderrPath,
    parsed,
  };
}

export async function run(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const loaded = loadRunnerManifest(options.manifestPath);
  const fixtures = options.fixtures.map((path) =>
    readFixture(path, loaded.manifest, loaded.entries)
  );
  const globalCaseIds = new Set<string>();
  const caseCounts = new Map<string, number>();
  for (const fixture of fixtures) {
    for (const testCase of fixture.cases) {
      if (globalCaseIds.has(testCase.id)) {
        throw new Error(`Duplicate selected case ID: ${testCase.id}`);
      }
      globalCaseIds.add(testCase.id);
    }
    caseCounts.set(
      fixture.corpusId,
      (caseCounts.get(fixture.corpusId) ?? 0) + fixture.cases.length
    );
  }
  for (const [corpusId, count] of caseCounts) {
    const minimum = loaded.entries.get(corpusId)!.minimumCases;
    if (count < minimum) {
      throw new Error(
        `Selected fixtures for ${corpusId} have ${count} cases; manifest minimumCases is ${minimum}`
      );
    }
  }
  const corpusIds = [...caseCounts.keys()];

  await withBenchmarkCorpora(
    {
      corpusIds,
      manifestPath: loaded.path,
      checkoutOverrides: options.checkoutOverrides,
    },
    (resolutions) => {
      if (options.preflightOnly) {
        console.log(`preflight: ${corpusIds.join(', ')} ready at owner-approved isolated pins`);
        return;
      }
      if (!existsSync(options.luxBin)) throw new Error(`Lux CLI does not exist: ${options.luxBin}`);

      const tempRoots: string[] = [];
      try {
        const runnable = fixtures.map((fixture) => {
          const resolution: CorpusResolutionV1 | undefined = resolutions.get(fixture.corpusId);
          if (!resolution) throw new Error(`Missing prepared corpus: ${fixture.corpusId}`);
          const tempRoot = mkdtempSync(join(tmpdir(), `lux-retrieval-${fixture.corpusId}-`));
          tempRoots.push(tempRoot);
          return {
            ...fixture,
            rootPath: resolution.rootPath,
            dbPath: join(tempRoot, 'lux.db'),
          };
        });

        // No output exists before all fixture validation and the T17 all-corpus barrier complete.
        mkdirSync(options.outDir, { recursive: true });
        const repos = runnable.map((fixture) => runFixture(fixture, options));
        const cases = repos.flatMap((repo) => repo.cases);
        const failedCases = cases.filter((testCase) => !testCase.passed);
        const knownMisses = cases.filter((testCase) => testCase.knownMiss);
        const knownMissOpen = knownMisses.filter((testCase) => !testCase.knownMissClosable).length;
        const knownMissClosable = knownMisses.filter(
          (testCase) => testCase.knownMissClosable
        ).length;
        const summary = {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          manifestPath: loaded.path,
          owner: loaded.manifest.owner,
          luxBin: options.luxBin,
          outDir: options.outDir,
          totals: {
            repos: repos.length,
            cases: cases.length,
            passed: cases.length - failedCases.length,
            failed: failedCases.length,
          },
          knownMiss: {
            total: knownMisses.length,
            open: knownMissOpen,
            closable: knownMissClosable,
          },
          repos,
        };

        const summaryPath = join(options.outDir, 'summary.json');
        writeText(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
        for (const repo of repos) {
          const passed = repo.cases.filter((testCase) => testCase.passed).length;
          console.log(
            `${repo.repoId}: ${passed}/${repo.cases.length} cases passed (${repo.status.overlayMode ?? 'unknown trust'})`
          );
        }
        if (knownMisses.length > 0) {
          console.log(`knownMiss: ${knownMissOpen} open, ${knownMissClosable} newly-closable`);
        }
        console.log(`summary: ${summaryPath}`);
        if (failedCases.length > 0) {
          for (const testCase of failedCases) {
            console.error(
              `FAIL ${testCase.repoId}/${testCase.id}: ${testCase.failures.join('; ')}`
            );
          }
          process.exitCode = 1;
        }
      } finally {
        let cleanupError: unknown;
        for (const root of tempRoots.reverse()) {
          try {
            rmSync(root, { recursive: true, force: true });
          } catch (error) {
            cleanupError ??= error;
          }
        }
        if (cleanupError !== undefined) throw cleanupError;
      }
    }
  );
}

const isEntryPoint =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntryPoint) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
