import { spawn, type SpawnOptions } from 'child_process';
import { resolve as resolvePath } from 'path';
import { buildCleanEnv } from '../utils/subprocess-env.js';
import { resolveAiDefaults, resolveSynthesisDefaults } from '../utils/ai-defaults.js';
import type {
  CandidateRegion,
  DiscoveryContext,
  DiscoveryOptions,
  DiscoveryProposal,
  ProposedExpert,
} from './types.js';
import type {
  OverlayNeighborhood,
  ExpertStructuralSignature,
} from '../experts/structural-analysis.js'; // @architecture-ignore intentional shared overlay substrate

// ── Constants ──────────────────────────────────────────────

const {
  model: DEFAULT_MODEL,
  backend: DEFAULT_BACKEND,
  provider: DEFAULT_PI_PROVIDER,
  thinking: DEFAULT_PI_THINKING,
} = resolveAiDefaults();
const { provider: DEFAULT_SYNTHESIS_PROVIDER, thinking: DEFAULT_SYNTHESIS_THINKING } =
  resolveSynthesisDefaults();
const DEFAULT_ANALYSIS_TIMEOUT_MS = 180_000;
const ANALYSIS_MAX_ATTEMPTS = 2;
const DISCOVERY_PROMPT_CHAR_BUDGET = 120_000;
const DISCOVERY_FALLBACK_PROMPT_CHAR_BUDGET = 45_000;
const MAX_FILE_COUNT_DIRS_IN_PROMPT = 200;
const MAX_SYMBOL_SUMMARY_DIRS_IN_PROMPT = 150;
const MAX_SYMBOLS_PER_DIR_IN_PROMPT = 8;
const MAX_CROSS_REFERENCES_IN_PROMPT = 150;
const MAX_EXISTING_EXPERTS_IN_PROMPT = 50;
const MAX_OVERLAY_NEIGHBORHOODS_IN_PROMPT = 20;
const MAX_CANDIDATE_REGIONS_IN_PROMPT = 12;
const BATCHED_ANALYSIS_REGION_THRESHOLD = 8;
const REGIONS_PER_BATCH = 4;
const DISCOVERY_TRACE_ENV_KEYS = ['LUX_DISCOVERY_TRACE', 'LUX_DISCOVERY_ANALYZE_TRACE'] as const;
const CLAUDE_HEARTBEAT_INTERVAL_MS = 10_000;
const STDERR_TAIL_MAX_CHARS = 4000;

interface PromptBudgetProfile {
  totalChars: number;
  maxFileCountDirs: number;
  maxSymbolSummaryDirs: number;
  maxSymbolsPerDir: number;
  maxCrossReferences: number;
  maxExistingExperts: number;
  maxOverlayNeighborhoods: number;
  maxCandidateRegions: number;
}

const DEFAULT_PROMPT_PROFILE: PromptBudgetProfile = {
  totalChars: DISCOVERY_PROMPT_CHAR_BUDGET,
  maxFileCountDirs: MAX_FILE_COUNT_DIRS_IN_PROMPT,
  maxSymbolSummaryDirs: MAX_SYMBOL_SUMMARY_DIRS_IN_PROMPT,
  maxSymbolsPerDir: MAX_SYMBOLS_PER_DIR_IN_PROMPT,
  maxCrossReferences: MAX_CROSS_REFERENCES_IN_PROMPT,
  maxExistingExperts: MAX_EXISTING_EXPERTS_IN_PROMPT,
  maxOverlayNeighborhoods: MAX_OVERLAY_NEIGHBORHOODS_IN_PROMPT,
  maxCandidateRegions: MAX_CANDIDATE_REGIONS_IN_PROMPT,
};

const FALLBACK_PROMPT_PROFILE: PromptBudgetProfile = {
  totalChars: DISCOVERY_FALLBACK_PROMPT_CHAR_BUDGET,
  maxFileCountDirs: 60,
  maxSymbolSummaryDirs: 40,
  maxSymbolsPerDir: 5,
  maxCrossReferences: 30,
  maxExistingExperts: 20,
  maxOverlayNeighborhoods: 8,
  maxCandidateRegions: 6,
};

// ── Prompt ────────────────────────────────────────────────

const OUTPUT_SCHEMA = `{
  "experts": [
    {
      "slug": "string (URL-safe, lowercase, hyphens)",
      "name": "string (human-readable)",
      "mountPath": "string (relative to content root)",
      "additionalPaths": ["string (optional additional paths)"],
      "description": "string (one-paragraph domain description)",
      "reasoning": "string (why this boundary was chosen)",
      "confidence": "number (0.0 to 1.0)",
      "boundaryBasis": "string (one of: directory-led, overlay-led, hybrid) — omit if no overlay data",
      "structuralRationale": "string (brief explanation of structural evidence used) — omit if directory-led"
    }
  ],
  "rationale": "string (brief rationale for the overall proposed structure)"
}`;

const BATCH_OUTPUT_SCHEMA = `{
  "experts": [
    {
      "slug": "string (URL-safe, lowercase, hyphens)",
      "name": "string (human-readable)",
      "mountPath": "string (relative to content root)",
      "additionalPaths": ["string (optional additional paths)"],
      "description": "string (one-paragraph domain description)",
      "reasoning": "string (why this boundary was chosen)",
      "confidence": "number (0.0 to 1.0)",
      "boundaryBasis": "string (one of: directory-led, overlay-led, hybrid) — omit if no overlay data",
      "structuralRationale": "string (brief explanation of structural evidence used) — omit if directory-led"
    }
  ],
  "rationale": "string (brief batch rationale)"
}`;

/**
 * Build the analysis prompt from discovery context.
 * Exported for testing.
 */
export function buildAnalysisPrompt(
  context: DiscoveryContext,
  profile: PromptBudgetProfile = DEFAULT_PROMPT_PROFILE
): string {
  const hasOverlay =
    context.overlayTrustState &&
    context.overlayTrustState !== 'no-overlay' &&
    context.overlayTrustState !== 'content-only' &&
    context.overlayNeighborhoods &&
    context.overlayNeighborhoods.length > 0;

  const tailLines = [
    '',
    '## Instructions',
    '',
    'Propose expert boundaries that:',
    '1. Cover distinct functional domains (not just directory names)',
    '2. Group tightly-coupled directories under one expert when they share a domain (e.g., models + controllers + views for "invoicing")',
    '3. Avoid overlapping mount paths',
    '4. Do not duplicate already-registered experts',
    '5. Include a brief domain description for each proposed expert',
    '6. Prefer the ranked candidate regions as the primary substrate for boundary decisions when present',
  ];

  if (hasOverlay) {
    tailLines.push(
      '',
      'Structural overlay evidence is available. When using it:',
      '- Prefer overlay-led or hybrid boundaries when structural neighborhoods are materially stronger than folder layout alone',
      '- Do NOT over-merge weakly related neighborhoods into one vague expert — when in doubt, keep regions separate',
      '- Always keep experts operator-legible: mount paths must be human-readable directory paths',
      '- Set "boundaryBasis" to "overlay-led" if the boundary is primarily explained by structural neighborhoods,',
      '  "directory-led" if it follows folder layout, or "hybrid" if both matter equally',
      '- Add "structuralRationale" to explain the overlay evidence when the basis is overlay-led or hybrid'
    );
  }

  tailLines.push('', `Respond with ONLY valid JSON matching this schema:`, OUTPUT_SCHEMA);

  const lines: string[] = [
    `You are analyzing a codebase to propose domain expert boundaries for a multi-expert AI panel system. Each expert manages a subdirectory of the content root and specializes in a specific domain.`,
    '',
    '## Context',
    '',
    '### Directory Tree',
    context.tree,
  ];

  appendOptionalBlock(
    lines,
    profile.totalChars,
    tailLines,
    buildCandidateRegionsBlock(context, profile)
  );
  appendOptionalBlock(
    lines,
    profile.totalChars,
    tailLines,
    buildExistingExpertsBlock(context, profile)
  );
  appendOptionalBlock(lines, profile.totalChars, tailLines, buildOverlayBlock(context, profile));

  if (!context.candidateRegions || context.candidateRegions.length === 0) {
    appendOptionalBlock(
      lines,
      profile.totalChars,
      tailLines,
      buildFileCountsBlock(context, profile)
    );
    appendOptionalBlock(
      lines,
      profile.totalChars,
      tailLines,
      buildSymbolSummariesBlock(context, profile)
    );
    appendOptionalBlock(
      lines,
      profile.totalChars,
      tailLines,
      buildCrossReferencesBlock(context, profile)
    );
  }

  lines.push(...tailLines);

  return lines.join('\n');
}

function buildBatchAnalysisPrompt(context: DiscoveryContext): string {
  const lines = [
    'You are analyzing a bounded batch of structurally ranked candidate regions from a codebase.',
    'Propose only expert boundaries that are strongly supported by the candidate regions in this batch.',
    'Avoid overlapping mount paths and avoid vague catch-all experts.',
    '',
    '## Context',
    '',
    '### Candidate-Focused Repository Scaffold',
    ...buildCandidateFocusedScaffold(context, context.candidateRegions ?? []),
    ...buildCandidateRegionsBlock(context, {
      ...FALLBACK_PROMPT_PROFILE,
      maxCandidateRegions: REGIONS_PER_BATCH,
    }),
    ...buildExistingExpertsBlock(context, FALLBACK_PROMPT_PROFILE),
    ...buildOverlayBlock(context, FALLBACK_PROMPT_PROFILE),
    '',
    'Respond with ONLY valid JSON matching this schema:',
    BATCH_OUTPUT_SCHEMA,
  ];

  return lines.join('\n');
}

function buildBatchSynthesisPrompt(
  context: DiscoveryContext,
  batchResults: DiscoveryProposal[]
): string {
  const lines = [
    'You are synthesizing expert-boundary proposals from multiple candidate-region analysis batches.',
    'Merge duplicates, keep only the strongest non-overlapping experts, and prefer the clearest domain boundaries.',
    'Do not invent experts unsupported by the batch results.',
    '',
    '## Candidate-Focused Repository Scaffold',
    ...buildCandidateFocusedScaffold(context, context.candidateRegions ?? []),
    '',
    '## Candidate Regions',
    ...buildCandidateRegionsBlock(context, {
      ...FALLBACK_PROMPT_PROFILE,
      maxCandidateRegions: Math.min(
        context.candidateRegions?.length ?? 0,
        MAX_CANDIDATE_REGIONS_IN_PROMPT
      ),
    }),
    '',
    '## Batch Results',
    ...batchResults.flatMap((result, index) => [
      `### Batch ${index + 1}`,
      `Rationale: ${result.rationale}`,
      ...(result.experts.length > 0
        ? result.experts.map(
            (expert) =>
              `- ${expert.slug} | ${expert.mountPath} | confidence=${expert.confidence.toFixed(2)} | ${expert.reasoning}`
          )
        : ['- No experts proposed']),
      '',
    ]),
    'Respond with ONLY valid JSON matching this schema:',
    OUTPUT_SCHEMA,
  ];

  return lines.join('\n');
}

function buildCandidateRegionsBlock(
  context: DiscoveryContext,
  profile: PromptBudgetProfile
): string[] {
  if (!context.candidateRegions || context.candidateRegions.length === 0) {
    return [];
  }

  const regions = context.candidateRegions.slice(0, profile.maxCandidateRegions);
  const omittedCount = context.candidateRegions.length - regions.length;

  return [
    '',
    '### Candidate Regions (ranked structural salience)',
    ...regions.flatMap((region, index) => [
      `  ${index + 1}. ${region.label} [${region.basis}] score=${region.salienceScore.toFixed(2)}`,
      `    Directories: ${region.dominantDirectories.join(', ')}`,
      ...(region.anchorPaths.length > 0
        ? [
            `    Anchor paths: ${region.anchorPaths.slice(0, 4).join(', ')}${region.anchorPaths.length > 4 ? ` (+${region.anchorPaths.length - 4} more)` : ''}`,
          ]
        : []),
      ...(region.supportingPaths && region.supportingPaths.length > 0
        ? [
            `    Supporting paths: ${region.supportingPaths.slice(0, 4).join(', ')}${region.supportingPaths.length > 4 ? ` (+${region.supportingPaths.length - 4} more)` : ''}`,
          ]
        : []),
      `    Evidence: ${region.evidence.slice(0, 3).join('; ')}`,
      ...(region.trustWeight !== undefined
        ? [
            `    Trust weight: ${region.trustWeight.toFixed(2)}${region.cohesionScore !== undefined ? `, Cohesion: ${region.cohesionScore.toFixed(2)}` : ''}${region.externalCouplingScore !== undefined ? `, External coupling: ${region.externalCouplingScore.toFixed(2)}` : ''}`,
          ]
        : []),
    ]),
    ...(omittedCount > 0
      ? [`  ... ${omittedCount} more candidate regions omitted for prompt budget`]
      : []),
  ];
}

function buildFileCountsBlock(context: DiscoveryContext, profile: PromptBudgetProfile): string[] {
  const fileCounts = Object.entries(context.fileCountsByDirectory)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, profile.maxFileCountDirs);

  if (fileCounts.length === 0) {
    return [];
  }

  const omittedCount = Object.keys(context.fileCountsByDirectory).length - fileCounts.length;
  return [
    '',
    '### File Counts by Directory',
    ...fileCounts.map(([dir, count]) => `  ${dir}: ${count}`),
    ...(omittedCount > 0
      ? [`  ... ${omittedCount} more directories omitted for prompt budget`]
      : []),
  ];
}

function buildSymbolSummariesBlock(
  context: DiscoveryContext,
  profile: PromptBudgetProfile
): string[] {
  if (!context.symbolSummaries) {
    return [];
  }

  const symbols = Object.entries(context.symbolSummaries)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, profile.maxSymbolSummaryDirs);

  if (symbols.length === 0) {
    return [];
  }

  const omittedCount = Object.keys(context.symbolSummaries).length - symbols.length;
  return [
    '',
    '### Symbol Summaries',
    ...symbols.map(([dir, names]) => {
      const included = names.slice(0, profile.maxSymbolsPerDir);
      const omittedSymbols = names.length - included.length;
      return `  ${dir}: ${included.join(', ')}${omittedSymbols > 0 ? ` (+${omittedSymbols} more symbols)` : ''}`;
    }),
    ...(omittedCount > 0
      ? [`  ... ${omittedCount} more directories omitted for prompt budget`]
      : []),
  ];
}

function buildCrossReferencesBlock(
  context: DiscoveryContext,
  profile: PromptBudgetProfile
): string[] {
  if (!context.crossReferences || context.crossReferences.length === 0) {
    return [];
  }

  const refs = context.crossReferences.slice(0, profile.maxCrossReferences);
  const omittedCount = context.crossReferences.length - refs.length;
  return [
    '',
    '### Cross-References',
    ...refs.map((ref) => `  ${ref.sourceDir} → ${ref.targetDir} (${ref.referenceCount} refs)`),
    ...(omittedCount > 0
      ? [`  ... ${omittedCount} more cross-references omitted for prompt budget`]
      : []),
  ];
}

function buildExistingExpertsBlock(
  context: DiscoveryContext,
  profile: PromptBudgetProfile
): string[] {
  if (context.existingExperts.length === 0) {
    return ['', '### Already Registered Experts', '  None'];
  }

  const experts = context.existingExperts.slice(0, profile.maxExistingExperts);
  const omittedCount = context.existingExperts.length - experts.length;
  return [
    '',
    '### Already Registered Experts',
    ...experts.map((expert) => {
      const basisNote = expert.boundaryBasis ? ` [${expert.boundaryBasis}]` : '';
      return `  - ${expert.slug} (${expert.mountPath})${basisNote}`;
    }),
    ...(omittedCount > 0
      ? [`  ... ${omittedCount} more existing experts omitted for prompt budget`]
      : []),
  ];
}

function buildOverlayBlock(context: DiscoveryContext, profile: PromptBudgetProfile): string[] {
  if (!context.overlayTrustState || context.overlayTrustState === 'no-overlay') {
    return [];
  }

  const lines = ['', `### Overlay Trust Level`, `  ${context.overlayTrustState}`];

  if (context.overlayNeighborhoods && context.overlayNeighborhoods.length > 0) {
    lines.push('', '### Structural Neighborhoods (from overlay)');
    for (const nbhd of context.overlayNeighborhoods.slice(0, profile.maxOverlayNeighborhoods)) {
      lines.push(`  Neighborhood: ${nbhd.label}`);
      lines.push(`    Directories: ${nbhd.dominantDirectories.join(', ') || '(none)'}`);
      lines.push(
        `    Anchor files: ${nbhd.anchorFiles.slice(0, 4).join(', ')}${nbhd.anchorFiles.length > 4 ? ` (+${nbhd.anchorFiles.length - 4} more)` : ''}`
      );
      lines.push(
        `    Cohesion: ${nbhd.cohesionScore.toFixed(2)}, External coupling: ${nbhd.externalCouplingScore.toFixed(2)}, Trust: ${nbhd.trustState}`
      );
      if (nbhd.evidenceSummary.length > 0) {
        lines.push(`    Evidence: ${nbhd.evidenceSummary.slice(0, 3).join('; ')}`);
      }
    }

    const omittedCount = context.overlayNeighborhoods.length - profile.maxOverlayNeighborhoods;
    if (omittedCount > 0) {
      lines.push(`  ... ${omittedCount} more neighborhoods omitted for prompt budget`);
    }
  }

  return lines;
}

function appendOptionalBlock(
  lines: string[],
  budget: number,
  tailLines: string[],
  block: string[]
): void {
  if (block.length === 0) {
    return;
  }

  const currentLength = joinedLength(lines);
  const blockLength = joinedLength(block);
  const tailLength = joinedLength(tailLines);
  if (currentLength + blockLength + tailLength <= budget) {
    lines.push(...block);
  }
}

function joinedLength(lines: string[]): number {
  if (lines.length === 0) {
    return 0;
  }

  return lines.reduce((sum, line) => sum + line.length, 0) + (lines.length - 1);
}

// ── Public API ────────────────────────────────────────────

/**
 * Stage 3: AI analysis.
 *
 * Spawns the configured analysis backend with the discovery context and parses the
 * structured JSON response into a DiscoveryProposal.
 */
export async function analyze(
  context: DiscoveryContext,
  options: DiscoveryOptions
): Promise<DiscoveryProposal> {
  const model = options.model ?? DEFAULT_MODEL;
  const startedAt = Date.now();
  const candidateRegionCount = context.candidateRegions?.length ?? 0;
  const batchMode = candidateRegionCount >= BATCHED_ANALYSIS_REGION_THRESHOLD;

  traceDiscovery('analyze.start', {
    model,
    rootPath: options.rootPath,
    candidateRegionCount,
    existingExpertCount: context.existingExperts.length,
    overlayTrustState: context.overlayTrustState,
    batchMode,
  });

  if (batchMode) {
    const batched = await analyzeInBatches(context, options, model);
    if (context.overlayNeighborhoods && context.overlayNeighborhoods.length > 0) {
      attachStructuralSignatures(batched.experts, context.overlayNeighborhoods);
    }
    traceDiscovery('analyze.complete', {
      mode: 'batched',
      durationMs: Date.now() - startedAt,
      expertCount: batched.experts.length,
    });
    return batched;
  }

  const proposal = await analyzeSinglePass(context, options, model);
  if (context.overlayNeighborhoods && context.overlayNeighborhoods.length > 0) {
    attachStructuralSignatures(proposal.experts, context.overlayNeighborhoods);
  }
  traceDiscovery('analyze.complete', {
    mode: 'single',
    durationMs: Date.now() - startedAt,
    expertCount: proposal.experts.length,
  });
  return proposal;
}

async function analyzeSinglePass(
  context: DiscoveryContext,
  options: DiscoveryOptions,
  model: string
): Promise<DiscoveryProposal> {
  const backend = resolveBackend(options);
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= ANALYSIS_MAX_ATTEMPTS; attempt++) {
    const promptBuildStartedAt = Date.now();
    const prompt = buildAnalysisPrompt(
      context,
      attempt === 1 ? DEFAULT_PROMPT_PROFILE : FALLBACK_PROMPT_PROFILE
    );
    traceDiscovery('analyze.single.prompt_built', {
      attempt,
      durationMs: Date.now() - promptBuildStartedAt,
      promptChars: prompt.length,
      candidateRegionCount: context.candidateRegions?.length ?? 0,
    });

    try {
      const runnerStartedAt = Date.now();
      const raw = await runAnalysisPrompt(prompt, {
        backend,
        model,
        provider: options.provider,
        rootPath: options.rootPath,
        thinking: options.thinking,
        timeoutMs: options.analysisTimeoutMs,
        traceMeta: {
          phase: 'single',
          attempt,
          promptChars: prompt.length,
        },
      });
      traceDiscovery('analyze.single.runner_complete', {
        backend,
        attempt,
        durationMs: Date.now() - runnerStartedAt,
        outputChars: raw.length,
      });

      const parseStartedAt = Date.now();
      const parsed = parseProposalResponse(raw);
      traceDiscovery('analyze.single.parse_complete', {
        attempt,
        durationMs: Date.now() - parseStartedAt,
        expertCount: parsed.experts.length,
      });
      return parsed;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      traceDiscovery('analyze.single.attempt_failed', {
        attempt,
        retryable: isRetryableAnalysisError(err),
        error: err.message,
      });
      if (attempt >= ANALYSIS_MAX_ATTEMPTS || !isRetryableAnalysisError(err)) {
        throw err;
      }
    }
  }

  throw lastError ?? new Error('Expert discovery analysis failed');
}

async function analyzeInBatches(
  context: DiscoveryContext,
  options: DiscoveryOptions,
  model: string
): Promise<DiscoveryProposal> {
  const batchBackend = resolveBackend(options);
  const synthesisBackend = resolveSynthesisBackend(options);
  const synthesisModel = options.synthesisModel ?? model;
  const batches = chunkCandidateRegions(context.candidateRegions ?? [], REGIONS_PER_BATCH);
  const batchResults: DiscoveryProposal[] = [];

  traceDiscovery('analyze.batched.start', {
    batchCount: batches.length,
    regionsPerBatch: REGIONS_PER_BATCH,
    totalCandidateRegions: context.candidateRegions?.length ?? 0,
  });

  for (const [index, regions] of batches.entries()) {
    const batchNumber = index + 1;
    const batchContext: DiscoveryContext = {
      ...context,
      candidateRegions: regions,
    };
    const promptBuildStartedAt = Date.now();
    const prompt = buildBatchAnalysisPrompt(batchContext);
    traceDiscovery('analyze.batched.prompt_built', {
      batch: batchNumber,
      batchCount: batches.length,
      durationMs: Date.now() - promptBuildStartedAt,
      promptChars: prompt.length,
      regionLabels: regions.map((region) => region.label),
    });

    const runnerStartedAt = Date.now();
    const raw = await runAnalysisPrompt(prompt, {
      backend: batchBackend,
      model,
      provider: options.provider,
      rootPath: options.rootPath,
      thinking: options.thinking,
      timeoutMs: options.analysisTimeoutMs,
      traceMeta: {
        phase: 'batch',
        batch: batchNumber,
        batchCount: batches.length,
        promptChars: prompt.length,
        candidateRegionLabels: regions.map((region) => region.label),
      },
    });
    traceDiscovery('analyze.batched.runner_complete', {
      backend: batchBackend,
      batch: batchNumber,
      batchCount: batches.length,
      durationMs: Date.now() - runnerStartedAt,
      outputChars: raw.length,
    });

    const parseStartedAt = Date.now();
    const parsed = parseProposalResponse(raw);
    traceDiscovery('analyze.batched.parse_complete', {
      batch: batchNumber,
      batchCount: batches.length,
      durationMs: Date.now() - parseStartedAt,
      expertCount: parsed.experts.length,
    });
    batchResults.push(parsed);
  }

  const synthesisPromptBuildStartedAt = Date.now();
  const synthesisPrompt = buildBatchSynthesisPrompt(context, batchResults);
  traceDiscovery('analyze.synthesis.prompt_built', {
    durationMs: Date.now() - synthesisPromptBuildStartedAt,
    promptChars: synthesisPrompt.length,
    batchResultCount: batchResults.length,
  });

  const synthesisStartedAt = Date.now();
  const synthesisRaw = await runAnalysisPrompt(synthesisPrompt, {
    backend: synthesisBackend,
    model: synthesisModel,
    provider: options.synthesisProvider ?? options.provider ?? DEFAULT_SYNTHESIS_PROVIDER,
    rootPath: options.rootPath,
    thinking:
      options.synthesisBackend === 'pi'
        ? (options.thinking ?? DEFAULT_SYNTHESIS_THINKING)
        : options.thinking,
    timeoutMs: options.analysisTimeoutMs,
    traceMeta: {
      phase: 'synthesis',
      promptChars: synthesisPrompt.length,
      batchResultCount: batchResults.length,
    },
  });
  traceDiscovery('analyze.synthesis.runner_complete', {
    backend: synthesisBackend,
    model: synthesisModel,
    durationMs: Date.now() - synthesisStartedAt,
    outputChars: synthesisRaw.length,
  });

  const synthesisParseStartedAt = Date.now();
  const parsed = parseProposalResponse(synthesisRaw);
  traceDiscovery('analyze.synthesis.parse_complete', {
    durationMs: Date.now() - synthesisParseStartedAt,
    expertCount: parsed.experts.length,
  });
  return parsed;
}

// ── Claude backend subprocess ───────────────────────────────

/**
 * Spawn the Claude backend in print mode and return stdout.
 * Exported for testing.
 */
export function buildClaudeArgs(prompt: string, model: string): string[] {
  return ['--print', '--permission-mode', 'bypassPermissions', '--model', model, prompt];
}

export function buildClaudeSpawnOptions(rootPath?: string): SpawnOptions {
  return {
    stdio: ['ignore', 'pipe', 'pipe'] as const,
    env: buildCleanEnv(),
    ...(rootPath ? { cwd: resolvePath(rootPath) } : {}),
  };
}

export function buildPiArgs(
  prompt: string,
  model: string,
  provider: string = DEFAULT_PI_PROVIDER ?? 'openai',
  thinking: string = DEFAULT_PI_THINKING ?? 'high'
): string[] {
  return [
    '--provider',
    provider,
    '--model',
    model,
    '--thinking',
    thinking,
    '--mode',
    'text',
    '--print',
    '--no-tools',
    prompt,
  ];
}

function buildPiSpawnOptions(rootPath?: string): SpawnOptions {
  return {
    stdio: ['ignore', 'pipe', 'pipe'] as const,
    env: buildCleanEnv(),
    ...(rootPath ? { cwd: resolvePath(rootPath) } : {}),
  };
}

interface AnalysisRunnerOptions {
  backend: 'claude' | 'pi';
  model: string;
  provider?: string;
  rootPath?: string;
  thinking?: string;
  timeoutMs?: number;
  traceMeta?: Record<string, unknown>;
}

function runAnalysisPrompt(prompt: string, options: AnalysisRunnerOptions): Promise<string> {
  if (options.backend === 'pi') {
    return spawnPi(
      prompt,
      options.model,
      options.provider,
      options.rootPath,
      options.thinking,
      options.timeoutMs,
      options.traceMeta
    );
  }

  return spawnClaude(prompt, options.model, options.rootPath, options.timeoutMs, options.traceMeta);
}

function spawnClaude(
  prompt: string,
  model: string,
  rootPath?: string,
  timeoutMs: number = DEFAULT_ANALYSIS_TIMEOUT_MS,
  traceMeta?: Record<string, unknown>
): Promise<string> {
  return new Promise((resolve, reject) => {
    traceDiscovery('claude.spawn.start', {
      model,
      rootPath,
      promptChars: prompt.length,
      ...traceMeta,
    });

    const child = spawn(
      'claude',
      buildClaudeArgs(prompt, model),
      buildClaudeSpawnOptions(rootPath)
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let sawStdout = false;
    let sawStderr = false;

    const startedAt = Date.now();
    traceDiscovery('claude.spawn.pid', {
      pid: child.pid,
      model,
      ...traceMeta,
    });

    const heartbeat = setInterval(() => {
      traceDiscovery('claude.spawn.heartbeat', {
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        stdoutChars: bufferLength(stdoutChunks),
        stderrChars: bufferLength(stderrChunks),
        ...traceMeta,
      });
    }, CLAUDE_HEARTBEAT_INTERVAL_MS);

    const timeout = setTimeout(() => {
      traceDiscovery('claude.spawn.timeout', {
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        model,
        stdoutChars: bufferLength(stdoutChunks),
        stderrChars: bufferLength(stderrChunks),
        stderrTail: getBufferTail(stderrChunks, STDERR_TAIL_MAX_CHARS),
        ...traceMeta,
      });
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          traceDiscovery('claude.spawn.sigkill', {
            pid: child.pid,
            durationMs: Date.now() - startedAt,
            ...traceMeta,
          });
          child.kill('SIGKILL');
        }
      }, 5_000);
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (!sawStdout) {
        sawStdout = true;
        traceDiscovery('claude.spawn.stdout_first_byte', {
          pid: child.pid,
          durationMs: Date.now() - startedAt,
          chunkBytes: chunk.length,
          ...traceMeta,
        });
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (!sawStderr) {
        sawStderr = true;
        traceDiscovery('claude.spawn.stderr_first_byte', {
          pid: child.pid,
          durationMs: Date.now() - startedAt,
          chunkBytes: chunk.length,
          ...traceMeta,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      traceDiscovery('claude.spawn.error', {
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        model,
        error: err.message,
        stderrTail: getBufferTail(stderrChunks, STDERR_TAIL_MAX_CHARS),
        ...traceMeta,
      });
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const durationMs = Date.now() - startedAt;

      if (code !== 0) {
        const stdoutTrimmed = stdout.trim();
        const stderrTrimmed = stderr.trim();
        const detail = stdoutTrimmed || stderrTrimmed || `Process exited with code ${code}`;
        traceDiscovery('claude.spawn.failed', {
          pid: child.pid,
          durationMs,
          model,
          code,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          stderrTail: tailString(stderr, STDERR_TAIL_MAX_CHARS),
          detail,
          ...traceMeta,
        });
        reject(new Error(`Claude CLI failed: ${detail}`));
        return;
      }

      if (!stdout.trim()) {
        traceDiscovery('claude.spawn.empty_output', {
          pid: child.pid,
          durationMs,
          model,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          stderrTail: tailString(stderr, STDERR_TAIL_MAX_CHARS),
          ...traceMeta,
        });
        reject(new Error('Claude CLI returned empty output'));
        return;
      }

      traceDiscovery('claude.spawn.complete', {
        pid: child.pid,
        durationMs,
        model,
        code,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        ...traceMeta,
      });
      resolve(stdout);
    });
  });
}

// ── Response Parsing ──────────────────────────────────────

/**
 * Parse raw Claude output into a DiscoveryProposal.
 * Handles markdown code fences and validates required fields.
 * Exported for testing.
 */
export function parseProposalResponse(raw: string): DiscoveryProposal {
  const cleaned = stripJsonFences(raw.trim());

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const extracted = extractJsonObject(cleaned);
    if (!extracted) {
      throw new Error(
        `Failed to parse AI response as JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    try {
      parsed = JSON.parse(extracted);
    } catch (nestedError) {
      throw new Error(
        `Failed to parse AI response as JSON: ${nestedError instanceof Error ? nestedError.message : String(nestedError)}`,
        { cause: nestedError }
      );
    }
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('AI response parsed to non-object value');
  }

  const obj = parsed as Record<string, unknown>;

  // Validate top-level structure
  if (!Array.isArray(obj.experts)) {
    throw new Error('AI response missing "experts" array');
  }

  if (typeof obj.rationale !== 'string') {
    throw new Error('AI response missing "rationale" string');
  }

  // Validate and normalize each expert
  const experts = obj.experts.map((e: unknown, i: number) => {
    if (e === null || typeof e !== 'object') {
      throw new Error(`Expert at index ${i} is not an object`);
    }

    const expert = e as Record<string, unknown>;

    // Required string fields
    for (const field of ['slug', 'name', 'mountPath', 'description', 'reasoning']) {
      if (typeof expert[field] !== 'string' || expert[field].length === 0) {
        throw new Error(`Expert at index ${i} missing or empty "${field}"`);
      }
    }

    // Confidence must be a number 0.0–1.0
    if (typeof expert.confidence !== 'number' || expert.confidence < 0 || expert.confidence > 1) {
      throw new Error(`Expert at index ${i} has invalid "confidence" (must be 0.0–1.0)`);
    }

    // additionalPaths is optional but must be string[] if present
    let additionalPaths: string[] | undefined;
    if (expert.additionalPaths !== undefined) {
      if (
        !Array.isArray(expert.additionalPaths) ||
        !expert.additionalPaths.every((p: unknown) => typeof p === 'string')
      ) {
        throw new Error(`Expert at index ${i} has invalid "additionalPaths" (must be string[])`);
      }
      additionalPaths = expert.additionalPaths;
    }

    // Optional structural fields
    const validBases = new Set(['directory-led', 'overlay-led', 'hybrid']);
    const boundaryBasis =
      typeof expert.boundaryBasis === 'string' && validBases.has(expert.boundaryBasis)
        ? (expert.boundaryBasis as 'directory-led' | 'overlay-led' | 'hybrid')
        : undefined;

    const structuralRationale =
      typeof expert.structuralRationale === 'string' && expert.structuralRationale.length > 0
        ? expert.structuralRationale
        : undefined;

    return {
      slug: expert.slug as string,
      name: expert.name as string,
      mountPath: expert.mountPath as string,
      additionalPaths,
      description: expert.description as string,
      reasoning: expert.reasoning as string,
      confidence: expert.confidence,
      ...(boundaryBasis && { boundaryBasis }),
      ...(structuralRationale && { structuralRationale }),
    };
  });

  return {
    experts,
    rationale: obj.rationale,
  };
}

function spawnPi(
  prompt: string,
  model: string,
  provider: string = DEFAULT_PI_PROVIDER ?? 'openai',
  rootPath?: string,
  thinking: string = DEFAULT_PI_THINKING ?? 'high',
  timeoutMs: number = DEFAULT_ANALYSIS_TIMEOUT_MS,
  traceMeta?: Record<string, unknown>
): Promise<string> {
  return new Promise((resolve, reject) => {
    traceDiscovery('pi.spawn.start', {
      model,
      provider,
      rootPath,
      promptChars: prompt.length,
      thinking,
      ...traceMeta,
    });

    const child = spawn(
      'pi',
      buildPiArgs(prompt, model, provider, thinking),
      buildPiSpawnOptions(rootPath)
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let sawStdout = false;
    let sawStderr = false;

    const startedAt = Date.now();
    traceDiscovery('pi.spawn.pid', {
      pid: child.pid,
      model,
      provider,
      thinking,
      ...traceMeta,
    });

    const heartbeat = setInterval(() => {
      traceDiscovery('pi.spawn.heartbeat', {
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        stdoutChars: bufferLength(stdoutChunks),
        stderrChars: bufferLength(stderrChunks),
        ...traceMeta,
      });
    }, CLAUDE_HEARTBEAT_INTERVAL_MS);

    const timeout = setTimeout(() => {
      traceDiscovery('pi.spawn.timeout', {
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        model,
        provider,
        stdoutChars: bufferLength(stdoutChunks),
        stderrChars: bufferLength(stderrChunks),
        stderrTail: getBufferTail(stderrChunks, STDERR_TAIL_MAX_CHARS),
        ...traceMeta,
      });
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          traceDiscovery('pi.spawn.sigkill', {
            pid: child.pid,
            durationMs: Date.now() - startedAt,
            ...traceMeta,
          });
          child.kill('SIGKILL');
        }
      }, 5_000);
      reject(new Error(`Pi CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (!sawStdout) {
        sawStdout = true;
        traceDiscovery('pi.spawn.stdout_first_byte', {
          pid: child.pid,
          durationMs: Date.now() - startedAt,
          chunkBytes: chunk.length,
          ...traceMeta,
        });
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (!sawStderr) {
        sawStderr = true;
        traceDiscovery('pi.spawn.stderr_first_byte', {
          pid: child.pid,
          durationMs: Date.now() - startedAt,
          chunkBytes: chunk.length,
          ...traceMeta,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      traceDiscovery('pi.spawn.error', {
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        model,
        provider,
        error: err.message,
        stderrTail: getBufferTail(stderrChunks, STDERR_TAIL_MAX_CHARS),
        ...traceMeta,
      });
      reject(new Error(`Failed to spawn Pi CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const durationMs = Date.now() - startedAt;

      if (code !== 0) {
        const stdoutTrimmed = stdout.trim();
        const stderrTrimmed = stderr.trim();
        const detail = stdoutTrimmed || stderrTrimmed || `Process exited with code ${code}`;
        traceDiscovery('pi.spawn.failed', {
          pid: child.pid,
          durationMs,
          model,
          provider,
          code,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          stderrTail: tailString(stderr, STDERR_TAIL_MAX_CHARS),
          detail,
          ...traceMeta,
        });
        reject(new Error(`Pi CLI failed: ${detail}`));
        return;
      }

      if (!stdout.trim()) {
        traceDiscovery('pi.spawn.empty_output', {
          pid: child.pid,
          durationMs,
          model,
          provider,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          stderrTail: tailString(stderr, STDERR_TAIL_MAX_CHARS),
          ...traceMeta,
        });
        reject(new Error('Pi CLI returned empty output'));
        return;
      }

      traceDiscovery('pi.spawn.complete', {
        pid: child.pid,
        durationMs,
        model,
        provider,
        code,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        ...traceMeta,
      });
      resolve(stdout.trim());
    });
  });
}

function traceDiscovery(event: string, payload: Record<string, unknown>): void {
  if (!isDiscoveryTraceEnabled()) {
    return;
  }

  const record = {
    ts: new Date().toISOString(),
    scope: 'lux.discovery.analyze',
    event,
    ...payload,
  };

  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function isDiscoveryTraceEnabled(): boolean {
  return DISCOVERY_TRACE_ENV_KEYS.some((key) => {
    const value = process.env[key];
    return value === '1' || value === 'true' || value === 'yes';
  });
}

function bufferLength(buffers: Buffer[]): number {
  return buffers.reduce((sum, chunk) => sum + chunk.length, 0);
}

function getBufferTail(buffers: Buffer[], maxChars: number): string {
  return tailString(Buffer.concat(buffers).toString('utf-8'), maxChars);
}

function tailString(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function buildCandidateFocusedScaffold(
  _context: DiscoveryContext,
  regions: CandidateRegion[]
): string[] {
  const directories = new Set<string>();

  for (const region of regions) {
    for (const dir of region.dominantDirectories) directories.add(dir);
    for (const path of region.supportingPaths ?? []) directories.add(path);
    for (const path of region.anchorPaths) directories.add(parentDirectory(path));
  }

  const lines = Array.from(directories)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 24)
    .map((dir) => `  - ${dir}`);

  return lines.length > 0 ? lines : ['  - (no candidate-focused directories available)'];
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(0, idx);
}

function chunkCandidateRegions(regions: CandidateRegion[], batchSize: number): CandidateRegion[][] {
  const batches: CandidateRegion[][] = [];
  for (let i = 0; i < regions.length; i += batchSize) {
    batches.push(regions.slice(i, i + batchSize));
  }
  return batches;
}

function resolveBackend(options: DiscoveryOptions): 'claude' | 'pi' {
  return options.backend ?? DEFAULT_BACKEND;
}

function resolveSynthesisBackend(options: DiscoveryOptions): 'claude' | 'pi' {
  return options.synthesisBackend ?? resolveBackend(options);
}

function isRetryableAnalysisError(error: Error): boolean {
  return (
    error.message.includes('timed out') ||
    error.message.includes('returned empty output') ||
    error.message.includes('Failed to parse AI response as JSON')
  );
}

function stripJsonFences(raw: string): string {
  if (!raw.startsWith('```')) return raw;
  return raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
}

export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

// ── Structural signature attachment ──────────────────────────

/**
 * Populate `structuralSignature` on each proposal by matching overlay
 * neighborhoods whose dominant directories fall under the proposal's
 * mount path.  Multiple matching neighborhoods are merged into one
 * signature so the proposal carries the full structural picture for
 * its boundary region.
 *
 * Exported for unit testing.
 */
export function attachStructuralSignatures(
  proposals: ProposedExpert[],
  neighborhoods: OverlayNeighborhood[]
): void {
  for (const proposal of proposals) {
    const mount = proposal.mountPath.replace(/\/+$/, '');

    const matching = neighborhoods.filter((nbhd) =>
      nbhd.dominantDirectories.some((dir) => dir === mount || dir.startsWith(mount + '/'))
    );

    if (matching.length === 0) continue;

    const anchorFiles = [...new Set(matching.flatMap((n) => n.anchorFiles))].sort();
    const dominantDirectories = [...new Set(matching.flatMap((n) => n.dominantDirectories))];
    const dominantSurfaces = [...new Set(matching.flatMap((n) => n.surfaceIds ?? []))].slice(0, 5);
    const dominantProviders = [...new Set(matching.flatMap((n) => n.providerIds ?? []))].slice(
      0,
      5
    );

    const sig: ExpertStructuralSignature = {
      version: 1,
      anchorFiles,
      dominantDirectories,
      ...(dominantSurfaces.length > 0 && { dominantSurfaces }),
      ...(dominantProviders.length > 0 && { dominantProviders }),
    };

    proposal.structuralSignature = sig;
  }
}
