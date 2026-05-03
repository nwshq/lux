#!/usr/bin/env npx tsx
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface BenchmarkFixture {
  schemaVersion: 1;
  repoId: string;
  repoPath: string;
  cases: BenchmarkCase[];
}

type BenchmarkSurface = 'feature-path' | 'operational' | 'status';
type BenchmarkMode = 'ask' | 'overlay' | 'status';

interface BenchmarkCase {
  id: string;
  surface: BenchmarkSurface;
  mode: BenchmarkMode;
  question: string;
  json?: boolean;
  target?: string;
  kind?: string;
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
}

function parseArgs(argv: string[]): RunnerOptions {
  const root = repoRoot();
  const fixtures: string[] = [];
  let outDir = join(root, 'benchmarks', 'retrieval', 'results', timestampSlug());
  let luxBin = join(root, 'dist', 'cli', 'index.js');

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--fixture':
        fixtures.push(resolve(argv[++i] ?? ''));
        break;
      case '--out':
        outDir = resolve(argv[++i] ?? '');
        break;
      case '--lux-bin':
        luxBin = resolve(argv[++i] ?? '');
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (fixtures.length === 0) {
    const fixtureDir = join(root, 'benchmarks', 'retrieval', 'fixtures');
    for (const entry of readdirSync(fixtureDir).sort()) {
      if (entry.endsWith('.json')) fixtures.push(join(fixtureDir, entry));
    }
  }

  return { fixtures, outDir, luxBin };
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readFixture(path: string): BenchmarkFixture {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as BenchmarkFixture;
  if (raw.schemaVersion !== 1) throw new Error(`${path}: unsupported schemaVersion`);
  if (!raw.repoId || !raw.repoPath) throw new Error(`${path}: repoId and repoPath are required`);
  return raw;
}

function buildCaseCommand(
  luxBin: string,
  fixture: BenchmarkFixture,
  testCase: BenchmarkCase
): string[] {
  const command = ['node', luxBin, '--corpus', fixture.repoPath];

  if (testCase.surface === 'status') {
    command.push('index', 'status', '--json');
    return command;
  }

  if (testCase.mode === 'ask') {
    command.push('ask', testCase.question);
    if (testCase.json) command.push('--json');
    return command;
  }

  command.push('overlay', testCase.surface, 'ask');
  if (testCase.json) command.push('--json');
  if (testCase.target) command.push('--target', testCase.target);
  if (testCase.kind) command.push('--kind', testCase.kind);
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
    askSurface: testCase.mode === 'ask' ? testCase.surface : undefined,
    askMode: testCase.mode === 'ask' && testCase.surface !== 'status' ? 'retrieval' : undefined,
    resolution: resolutionMatch?.[1] ?? (resolutionMatchLine ? 'resolved' : undefined),
    intent: inferTextIntent(testCase),
    targetId: targetMatch?.[1],
    summary,
    failureText: extractTextFailureText(stdout),
    directEvidenceCount: directEvidenceSection,
    contextCount: contextSection,
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
  exitCode: number
): string[] {
  const failures: string[] = [];
  if (exitCode !== expect.exitCode)
    failures.push(`exitCode expected ${expect.exitCode}, got ${exitCode}`);
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

function runFixture(fixturePath: string, options: RunnerOptions): RepoResult {
  const fixture = readFixture(fixturePath);
  if (!existsSync(fixture.repoPath))
    throw new Error(`${fixture.repoId}: repoPath does not exist: ${fixture.repoPath}`);

  const repoOut = join(options.outDir, fixture.repoId);
  mkdirSync(repoOut, { recursive: true });

  const statusCommand = [
    'node',
    options.luxBin,
    '--corpus',
    fixture.repoPath,
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
    repoPath: fixture.repoPath,
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
  const command = buildCaseCommand(options.luxBin, fixture, testCase);
  const result = runCommand(command);
  const stdoutPath = join(repoOut, `${testCase.id}.stdout.txt`);
  const stderrPath = join(repoOut, `${testCase.id}.stderr.txt`);
  writeText(stdoutPath, result.stdout);
  writeText(stderrPath, result.stderr);
  const parsed = parseCasePayload(testCase, result.stdout);
  const failures = validateExpectation(testCase.expect, parsed, result.exitCode);

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

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.outDir, { recursive: true });
  const repos = options.fixtures.map((fixture) => runFixture(fixture, options));
  const cases = repos.flatMap((repo) => repo.cases);
  const failedCases = cases.filter((testCase) => !testCase.passed);
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    luxBin: options.luxBin,
    outDir: options.outDir,
    totals: {
      repos: repos.length,
      cases: cases.length,
      passed: cases.length - failedCases.length,
      failed: failedCases.length,
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
  console.log(`summary: ${summaryPath}`);

  if (failedCases.length > 0) {
    for (const testCase of failedCases) {
      console.error(`FAIL ${testCase.repoId}/${testCase.id}: ${testCase.failures.join('; ')}`);
    }
    process.exitCode = 1;
  }
}

main();
