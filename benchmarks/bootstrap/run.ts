#!/usr/bin/env npx tsx
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuxDatabase } from '../../src/db/index.js';
import { rebuildWithOverlay } from '../../src/scanner/rebuild-orchestrator.js';
import { attachEnrichment } from '../../src/scanner/general.js';
import { GeneralScanner } from '../../src/scanner/index.js';
// The expert runtime is parked in this release. Type-only references preserve the benchmark's
// established contract; runtime loading is deferred until after corpus preflight so
// `--preflight-only` remains usable while all deterministic/real/both options stay intact.
import type {
  DiscoveryContext,
  DiscoveryOptions,
  DiscoveryProposal,
  PipelineStages,
  ProposedExpert,
  RegisteredExpert,
  ExpertCountPolicy,
} from './compat/parked-discovery-types.js';
import type { RebuildResult } from '../../src/scanner/rebuild-orchestrator.js';

interface ExpertInsert {
  slug: string;
  name: string;
  mount_path: string;
  model?: string;
  backend?: string;
  provider?: string;
  thinking?: string;
  claude_md_path?: string;
  boundary_basis?: string;
  structural_signature?: string;
  structural_rationale?: string;
}
import type { CorpusManifestEntryV1, CorpusManifestV1 } from '../corpora/preflight.js';
import {
  loadCheckoutOverrides,
  loadRunnerManifest,
  validateFixtureIdentity,
  withBenchmarkCorpora,
} from '../corpora/runtime.js';

interface BootstrapBenchmarkFixture {
  schemaVersion: 1;
  goldSchemaVersion: 1;
  owner: string;
  corpusId: string;
  repoId: string;
  repoPath: string;
  timeoutMs?: number;
}

interface PortableBootstrapFixture {
  schemaVersion: 1;
  goldSchemaVersion: 1;
  owner: string;
  corpusId: string;
  timeoutMs?: number;
}

interface RunnerOptions {
  fixtures: string[];
  outDir: string;
  keepDbs: boolean;
  discoveryMode: 'deterministic' | 'real' | 'both';
  discoveryOptions: Partial<DiscoveryOptions>;
  manifestPath?: string;
  checkoutOverrides?: Readonly<Record<string, string>>;
  preflightOnly: boolean;
}

interface MemorySample {
  timestampMs: number;
  phase: string;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  processTreeRssBytes: number;
}

interface PhaseResult {
  id: string;
  label: string;
  durationMs: number;
  memoryBefore: MemorySample;
  memoryAfter: MemorySample;
  peakRssBytes: number;
  peakHeapUsedBytes: number;
}

interface RepoResult {
  repoId: string;
  repoPath: string;
  dbPath: string;
  discoveryMode: RunnerOptions['discoveryMode'];
  phases: PhaseResult[];
  totalDurationMs: number;
  peakRssBytes: number;
  peakHeapUsedBytes: number;
  overlay?: RebuildResult;
  scan: {
    knowledgeEntries: number;
    sourceCodeFiles: number;
    enrichedFiles: number;
    activeEnrichers: number;
    enrichmentErrors: number;
    moduleDependencies: number;
  };
  discovery: {
    treeChars: number;
    candidateRegions: number;
    proposedExperts: number;
    registeredExperts: number;
    countPolicy?: ExpertCountPolicy;
  };
}

interface BenchmarkSummary {
  schemaVersion: 1;
  generatedAt: string;
  results: RepoResult[];
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv: string[]): RunnerOptions {
  const fixtures: string[] = [];
  let outDir = join(repoRoot(), 'benchmarks', 'bootstrap', 'results', timestampSlug());
  let keepDbs = false;
  let discoveryMode: RunnerOptions['discoveryMode'] = 'deterministic';
  const discoveryOptions: Partial<DiscoveryOptions> = {};
  let manifestPath: string | undefined;
  let checkoutOverrides: Readonly<Record<string, string>> | undefined;
  let preflightOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--fixture':
        fixtures.push(resolve(argv[++i] ?? ''));
        break;
      case '--out':
        outDir = resolve(argv[++i] ?? '');
        break;
      case '--keep-dbs':
        keepDbs = true;
        break;
      case '--manifest':
        manifestPath = resolve(argv[++i] ?? '');
        break;
      case '--checkout-overrides':
        checkoutOverrides = loadCheckoutOverrides(argv[++i] ?? '');
        break;
      case '--preflight-only':
        preflightOnly = true;
        break;
      case '--discovery-mode': {
        const value = argv[++i];
        if (value !== 'deterministic' && value !== 'real' && value !== 'both') {
          throw new Error('--discovery-mode must be one of: deterministic, real, both');
        }
        discoveryMode = value;
        break;
      }
      case '--backend': {
        const value = argv[++i];
        if (value !== 'claude' && value !== 'pi') {
          throw new Error('--backend must be one of: claude, pi');
        }
        discoveryOptions.backend = value;
        break;
      }
      case '--synthesis-backend': {
        const value = argv[++i];
        if (value !== 'claude' && value !== 'pi') {
          throw new Error('--synthesis-backend must be one of: claude, pi');
        }
        discoveryOptions.synthesisBackend = value;
        break;
      }
      case '--provider':
        discoveryOptions.provider = argv[++i];
        break;
      case '--synthesis-provider':
        discoveryOptions.synthesisProvider = argv[++i];
        break;
      case '--model':
        discoveryOptions.model = argv[++i];
        break;
      case '--synthesis-model':
        discoveryOptions.synthesisModel = argv[++i];
        break;
      case '--thinking':
        discoveryOptions.thinking = argv[++i] as DiscoveryOptions['thinking'];
        break;
      case '--analysis-timeout-ms': {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error('--analysis-timeout-ms must be a positive number');
        }
        discoveryOptions.analysisTimeoutMs = value;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (fixtures.length === 0) {
    fixtures.push(join(repoRoot(), 'benchmarks', 'bootstrap', 'fixtures', 'canonical-lux.json'));
  }

  return {
    fixtures,
    outDir,
    keepDbs,
    discoveryMode,
    discoveryOptions,
    manifestPath,
    checkoutOverrides,
    preflightOnly,
  };
}

function readFixtures(
  paths: string[],
  manifest: CorpusManifestV1,
  entries: ReadonlyMap<string, CorpusManifestEntryV1>
): PortableBootstrapFixture[] {
  const fixtures: PortableBootstrapFixture[] = [];
  for (const path of paths) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: 1;
      owner?: string;
      repos?: PortableBootstrapFixture[];
    };
    if (raw.schemaVersion !== 1) throw new Error(`${path}: unsupported schemaVersion`);
    if (raw.owner !== manifest.owner) throw new Error(`${path}: owner must match manifest owner`);
    if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
      throw new Error(`${path}: expected a non-empty repos[]`);
    }
    for (const fixture of raw.repos) {
      validateFixtureIdentity(fixture, path, manifest, entries);
      fixtures.push(fixture);
    }
  }
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.corpusId)) {
      throw new Error(`Duplicate selected bootstrap corpus ID: ${fixture.corpusId}`);
    }
    ids.add(fixture.corpusId);
  }
  return fixtures;
}

function memorySample(phase: string): MemorySample {
  const usage = process.memoryUsage();
  return {
    timestampMs: Date.now(),
    phase,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    processTreeRssBytes: processTreeRssBytes(process.pid),
  };
}

function processTreeRssBytes(rootPid: number): number {
  try {
    const raw = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = raw
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row.length === 3 && row.every((value) => Number.isFinite(value))) as Array<
      [number, number, number]
    >;
    const children = new Map<number, Array<{ pid: number; rssKb: number }>>();
    for (const [pid, ppid, rssKb] of rows) {
      const list = children.get(ppid) ?? [];
      list.push({ pid, rssKb });
      children.set(ppid, list);
    }
    let totalKb = 0;
    const stack = [rootPid];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const row = rows.find(([candidate]) => candidate === pid);
      if (row) totalKb += row[2];
      for (const child of children.get(pid) ?? []) stack.push(child.pid);
    }
    return totalKb * 1024;
  } catch {
    return process.memoryUsage().rss;
  }
}

class PhaseRecorder {
  private readonly samples: MemorySample[] = [];
  private activePhase = 'startup';
  private timer: NodeJS.Timeout | undefined;

  start(): void {
    this.sample('startup');
    this.timer = setInterval(() => this.sample(this.activePhase), 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  sample(phase = this.activePhase): MemorySample {
    const sample = memorySample(phase);
    this.samples.push(sample);
    return sample;
  }

  async measure<T>(
    id: string,
    label: string,
    fn: () => Promise<T> | T
  ): Promise<{ value: T; phase: PhaseResult }> {
    this.activePhase = id;
    const before = this.sample(`${id}:before`);
    const start = process.hrtime.bigint();
    const value = await fn();
    const end = process.hrtime.bigint();
    const after = this.sample(`${id}:after`);
    const phaseSamples = this.samples.filter(
      (sample) =>
        sample.timestampMs >= before.timestampMs && sample.timestampMs <= after.timestampMs
    );
    const peakRssBytes = Math.max(
      before.processTreeRssBytes,
      after.processTreeRssBytes,
      ...phaseSamples.map((sample) => sample.processTreeRssBytes)
    );
    const peakHeapUsedBytes = Math.max(
      before.heapUsedBytes,
      after.heapUsedBytes,
      ...phaseSamples.map((sample) => sample.heapUsedBytes)
    );
    this.activePhase = 'idle';
    return {
      value,
      phase: {
        id,
        label,
        durationMs: Number(end - start) / 1_000_000,
        memoryBefore: before,
        memoryAfter: after,
        peakRssBytes,
        peakHeapUsedBytes,
      },
    };
  }

  peakRss(): number {
    return Math.max(...this.samples.map((sample) => sample.processTreeRssBytes));
  }

  peakHeapUsed(): number {
    return Math.max(...this.samples.map((sample) => sample.heapUsedBytes));
  }

  writeSamples(path: string): void {
    writeFileSync(path, JSON.stringify(this.samples, null, 2));
  }
}

async function benchmarkRepo(
  fixture: BootstrapBenchmarkFixture,
  outDir: string,
  options: RunnerOptions
): Promise<RepoResult> {
  if (!existsSync(fixture.repoPath)) {
    throw new Error(`${fixture.repoId}: repoPath does not exist: ${fixture.repoPath}`);
  }

  const repoOutDir = join(outDir, fixture.repoId);
  mkdirSync(repoOutDir, { recursive: true });
  const tmpRoot = mkdtempSync(join(tmpdir(), `lux-bootstrap-${fixture.repoId}-`));
  const dbPath = options.keepDbs ? join(repoOutDir, 'lux.db') : join(tmpRoot, 'lux.db');
  const recorder = new PhaseRecorder();
  const phases: PhaseResult[] = [];
  const startedAt = process.hrtime.bigint();
  let db: LuxDatabase | undefined;

  recorder.start();
  try {
    const dbInit = await recorder.measure(
      'db-init',
      'Initialize benchmark SQLite database',
      () => new LuxDatabase(dbPath)
    );
    db = dbInit.value;
    phases.push(dbInit.phase);

    let overlay: RebuildResult | undefined;
    let scanSummary: RepoResult['scan'] | undefined;
    const abortDeadline = fixture.timeoutMs ? Date.now() + fixture.timeoutMs : undefined;
    const rebuild = await recorder.measure(
      'overlay-rebuild',
      'Scan, enrich, and rebuild structural overlay',
      async () => {
        const { result, scanResult } = await rebuildWithOverlay(db!, fixture.repoPath, {
          onProgress: (message) => {
            if (abortDeadline && Date.now() > abortDeadline) {
              throw new Error(`Bootstrap benchmark timed out after ${fixture.timeoutMs}ms`);
            }
            if (
              message.startsWith('Initializing') ||
              message.startsWith('Enriching') ||
              message.startsWith('Rebuilding')
            ) {
              console.error(`[${fixture.repoId}] ${message}`);
            }
          },
        });
        overlay = result;
        const knowledge = scanResult.scan.knowledge;
        scanSummary = {
          knowledgeEntries: knowledge.length,
          sourceCodeFiles: knowledge.filter((entry) => entry.type === 'source-code').length,
          enrichedFiles: scanResult.stats.enrichedFiles,
          activeEnrichers: scanResult.stats.activeEnrichers,
          enrichmentErrors: scanResult.stats.enrichmentErrors.length,
          moduleDependencies: scanResult.dependencies.length,
        };
        const persisted = {
          ...scanResult.scan,
          knowledge: scanResult.scan.knowledge.map((entry) =>
            attachEnrichment(entry, scanResult.enrichments)
          ),
        };
        const scanner = new GeneralScanner(fixture.repoPath);
        await scanner.index(db!, persisted);
        if (scanResult.dependencies.length > 0) {
          db!.clearModuleDependencies();
          for (const dep of scanResult.dependencies) {
            db!.insertModuleDependency({
              source_module: dep.source_module,
              target_module: dep.target_module,
              reference_count: dep.reference_count,
              sample_files: JSON.stringify(dep.sample_files),
            });
          }
        }
        return result;
      }
    );
    phases.push(rebuild.phase);

    let discoverySummary: RepoResult['discovery'] | undefined;
    if (options.discoveryMode === 'deterministic' || options.discoveryMode === 'both') {
      const deterministic = await recorder.measure(
        'deterministic-expert-bootstrap',
        'Derive candidate expert regions and register deterministic proposed expert stubs',
        async () =>
          runDiscovery(
            db!,
            fixture,
            repoOutDir,
            {
              rootPath: fixture.repoPath,
              acceptAll: true,
              minConfidence: 0,
              maxExperts: 6,
              countSelectionMode: 'top-n-slice',
              ...options.discoveryOptions,
            },
            'deterministic',
            (summary) => {
              discoverySummary = summary;
            }
          )
      );
      phases.push(deterministic.phase);
    }

    if (options.discoveryMode === 'real' || options.discoveryMode === 'both') {
      const real = await recorder.measure(
        'real-expert-discovery',
        'Run model-backed expert discovery analysis and register accepted experts',
        async () =>
          runDiscovery(
            db!,
            fixture,
            repoOutDir,
            {
              rootPath: fixture.repoPath,
              acceptAll: true,
              minConfidence: 0,
              countSelectionMode: 'quality-gated-inventory',
              ...options.discoveryOptions,
            },
            'real',
            (summary) => {
              discoverySummary = summary;
            }
          )
      );
      phases.push(real.phase);
    }

    const endedAt = process.hrtime.bigint();
    recorder.writeSamples(join(repoOutDir, 'memory-samples.json'));

    return {
      repoId: fixture.repoId,
      repoPath: fixture.repoPath,
      dbPath,
      discoveryMode: options.discoveryMode,
      phases,
      totalDurationMs: Number(endedAt - startedAt) / 1_000_000,
      peakRssBytes: recorder.peakRss(),
      peakHeapUsedBytes: recorder.peakHeapUsed(),
      overlay,
      scan: scanSummary ?? {
        knowledgeEntries: 0,
        sourceCodeFiles: 0,
        enrichedFiles: 0,
        activeEnrichers: 0,
        enrichmentErrors: 0,
        moduleDependencies: 0,
      },
      discovery: discoverySummary ?? {
        treeChars: 0,
        candidateRegions: 0,
        proposedExperts: 0,
        registeredExperts: 0,
      },
    };
  } finally {
    recorder.stop();
    db?.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function loadParkedDiscoveryRuntime(): Promise<{
  createDefaultStages: () => PipelineStages;
  runDiscoveryPipeline: (
    db: LuxDatabase,
    options: DiscoveryOptions,
    stages: PipelineStages
  ) => Promise<{
    proposed: ProposedExpert[];
    registered: RegisteredExpert[];
    rationale: string;
    countPolicy: ExpertCountPolicy;
  }>;
}> {
  try {
    const [defaults, pipeline] = await Promise.all([
      import('../../src/' + 'discovery/defaults.js'),
      import('../../src/' + 'discovery/pipeline.js'),
    ]);
    return {
      createDefaultStages: defaults.createDefaultStages,
      runDiscoveryPipeline: pipeline.runDiscoveryPipeline,
    };
  } catch {
    throw new Error(
      'Expert discovery runtime is parked in this build; deterministic/real/both modes require a build containing src/discovery'
    );
  }
}

async function runDiscovery(
  db: LuxDatabase,
  fixture: BootstrapBenchmarkFixture,
  repoOutDir: string,
  options: DiscoveryOptions,
  mode: 'deterministic' | 'real',
  onSummary: (summary: RepoResult['discovery']) => void
) {
  const { createDefaultStages, runDiscoveryPipeline } = await loadParkedDiscoveryRuntime();
  const defaultStages = createDefaultStages();
  void createSummaryCapture;
  const stagesWithAnalyze =
    mode === 'deterministic' ? createDeterministicStages(defaultStages, onSummary) : defaultStages;
  const stages: PipelineStages = {
    ...stagesWithAnalyze,
    register: (accepted: ProposedExpert[], db: LuxDatabase, discoveryOptions: DiscoveryOptions) =>
      registerExpertsInBenchmarkDb(accepted, db, discoveryOptions, mode, repoOutDir),
  };
  const result = await runDiscoveryPipeline(db, options, stages);
  const previousSummary: RepoResult['discovery'] = {
    treeChars: 0,
    candidateRegions: 0,
    proposedExperts: result.proposed.length,
    registeredExperts: result.registered.length,
    countPolicy: result.countPolicy,
  };
  onSummary(previousSummary);
  writeFileSync(
    join(repoOutDir, `benchmark-${mode}-discovery-last.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        repoId: fixture.repoId,
        mode,
        generatedAt: new Date().toISOString(),
        proposed: result.proposed.map(redactProposalForBenchmark),
        registered: result.registered.map(redactRegisteredForBenchmark),
        rationale: result.rationale,
        countPolicy: result.countPolicy,
      },
      null,
      2
    )
  );
  return result;
}

function registerExpertsInBenchmarkDb(
  accepted: ProposedExpert[],
  db: LuxDatabase,
  options: DiscoveryOptions,
  mode: 'deterministic' | 'real',
  repoOutDir: string
): RegisteredExpert[] {
  const registered: RegisteredExpert[] = [];
  for (const proposal of accepted) {
    const mountPath = resolve(options.rootPath, proposal.mountPath);
    const claudeMdPath = join(
      repoOutDir,
      'benchmark-expert-stubs',
      mode,
      proposal.slug,
      'claude.md'
    );
    const insert: ExpertInsert = {
      slug: proposal.slug,
      name: proposal.name,
      mount_path: mountPath,
      model: options.model,
      backend: options.backend,
      provider: options.provider,
      thinking: options.thinking,
      claude_md_path: claudeMdPath,
      ...(proposal.boundaryBasis && { boundary_basis: proposal.boundaryBasis }),
      ...(proposal.structuralSignature && {
        structural_signature: JSON.stringify(proposal.structuralSignature),
      }),
      ...(proposal.structuralRationale && { structural_rationale: proposal.structuralRationale }),
    };
    const expertDb = db as LuxDatabase & { insertExpert(expert: ExpertInsert): number };
    expertDb.insertExpert(insert);
    registered.push({ slug: proposal.slug, mountPath, claudeMdPath });
  }
  return registered;
}

function createSummaryCapture(stages: PipelineStages): {
  stages: PipelineStages;
  summary: RepoResult['discovery'];
} {
  const summary: RepoResult['discovery'] = {
    treeChars: 0,
    candidateRegions: 0,
    proposedExperts: 0,
    registeredExperts: 0,
  };

  return {
    summary,
    stages: {
      ...stages,
      deriveCandidateRegions: (context: DiscoveryContext, options: DiscoveryOptions) => {
        const derived = stages.deriveCandidateRegions(context, options);
        summary.treeChars = derived.tree.length;
        summary.candidateRegions = derived.candidateRegions?.length ?? 0;
        return derived;
      },
    },
  };
}

function createDeterministicStages(
  defaultStages: PipelineStages,
  onSummary: (summary: RepoResult['discovery']) => void
): PipelineStages {
  return {
    ...defaultStages,
    analyze: (context: DiscoveryContext): DiscoveryProposal => {
      onSummary({
        treeChars: context.tree.length,
        candidateRegions: context.candidateRegions?.length ?? 0,
        proposedExperts: Math.min(context.candidateRegions?.length ?? 0, 6),
        registeredExperts: 0,
      });
      const candidates = context.candidateRegions ?? [];
      return {
        rationale: 'Deterministic bootstrap benchmark proposals derived from candidate regions.',
        experts: candidates.slice(0, 6).map((candidate, index: number) => ({
          slug: `benchmark-${index + 1}-${slugify(candidate.label)}`,
          name: `Benchmark ${candidate.label}`,
          mountPath: mountDirectory(candidate.anchorPaths[0] ?? '.'),
          additionalPaths: candidate.supportingPaths?.map(mountDirectory).slice(0, 5),
          description: `Benchmark expert stub for ${candidate.label}.`,
          reasoning: candidate.evidence.join(' '),
          confidence: Math.max(0.55, Math.min(0.95, candidate.salienceScore / 100)),
          boundaryBasis: candidate.basis,
        })),
      };
    },
  };
}

function redactProposalForBenchmark(proposal: ProposedExpert): ProposedExpert {
  return {
    ...proposal,
    reasoning: proposal.reasoning.slice(0, 1000),
    description: proposal.description.slice(0, 1000),
  };
}

function redactRegisteredForBenchmark(registered: RegisteredExpert): RegisteredExpert {
  return registered;
}

function mountDirectory(path: string): string {
  if (path === '.' || path.endsWith('/')) return path;
  const base = basename(path);
  return base.includes('.') ? dirname(path) : path;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'region';
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatMs(ms: number): string {
  if (ms > 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function printRepoSummary(result: RepoResult): void {
  console.log(
    `${result.repoId}: total=${formatMs(result.totalDurationMs)}, peakRSS=${formatBytes(result.peakRssBytes)}, ` +
      `entries=${result.scan.knowledgeEntries}, enriched=${result.scan.enrichedFiles}, surfaces=${result.overlay?.surfaceCount ?? 0}, ` +
      `experts=${result.discovery.registeredExperts}`
  );
  for (const phase of result.phases) {
    console.log(
      `  - ${phase.id}: ${formatMs(phase.durationMs)}, peakRSS=${formatBytes(phase.peakRssBytes)}, ` +
        `heap=${formatBytes(phase.peakHeapUsedBytes)}`
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loaded = loadRunnerManifest(options.manifestPath);
  const fixtures = readFixtures(options.fixtures, loaded.manifest, loaded.entries);

  await withBenchmarkCorpora(
    {
      corpusIds: fixtures.map((fixture) => fixture.corpusId),
      manifestPath: loaded.path,
      checkoutOverrides: options.checkoutOverrides,
    },
    async (resolutions) => {
      if (options.preflightOnly) {
        console.log(
          `preflight: ${fixtures.map((fixture) => fixture.corpusId).join(', ')} ready at owner-approved isolated pins`
        );
        return;
      }

      // No DB, scanner, or output exists until every selected corpus has crossed the global barrier.
      mkdirSync(options.outDir, { recursive: true });
      const results: RepoResult[] = [];
      for (const fixture of fixtures) {
        const resolution = resolutions.get(fixture.corpusId);
        if (!resolution) throw new Error(`Missing prepared corpus: ${fixture.corpusId}`);
        const runnable: BootstrapBenchmarkFixture = {
          ...fixture,
          repoId: fixture.corpusId,
          repoPath: resolution.rootPath,
        };
        const result = await benchmarkRepo(runnable, options.outDir, options);
        results.push(result);
        printRepoSummary(result);
      }

      const summary: BenchmarkSummary = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        results,
      };
      const summaryPath = join(options.outDir, 'summary.json');
      writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
      console.log(`summary: ${summaryPath}`);
    }
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
