import { spawn } from 'child_process';
import { buildCleanEnv } from '../utils/subprocess-env.js';
import type {
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

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const ANALYSIS_TIMEOUT_MS = 180_000;
const ANALYSIS_MAX_ATTEMPTS = 2;
const DISCOVERY_PROMPT_CHAR_BUDGET = 120_000;
const MAX_FILE_COUNT_DIRS_IN_PROMPT = 200;
const MAX_SYMBOL_SUMMARY_DIRS_IN_PROMPT = 150;
const MAX_SYMBOLS_PER_DIR_IN_PROMPT = 8;
const MAX_CROSS_REFERENCES_IN_PROMPT = 150;
const MAX_EXISTING_EXPERTS_IN_PROMPT = 50;
const MAX_OVERLAY_NEIGHBORHOODS_IN_PROMPT = 20;

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

/**
 * Build the analysis prompt from discovery context.
 * Exported for testing.
 */
export function buildAnalysisPrompt(context: DiscoveryContext): string {
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
    DISCOVERY_PROMPT_CHAR_BUDGET,
    tailLines,
    buildFileCountsBlock(context)
  );
  appendOptionalBlock(
    lines,
    DISCOVERY_PROMPT_CHAR_BUDGET,
    tailLines,
    buildSymbolSummariesBlock(context)
  );
  appendOptionalBlock(
    lines,
    DISCOVERY_PROMPT_CHAR_BUDGET,
    tailLines,
    buildCrossReferencesBlock(context)
  );
  appendOptionalBlock(
    lines,
    DISCOVERY_PROMPT_CHAR_BUDGET,
    tailLines,
    buildExistingExpertsBlock(context)
  );
  appendOptionalBlock(lines, DISCOVERY_PROMPT_CHAR_BUDGET, tailLines, buildOverlayBlock(context));

  lines.push(...tailLines);

  return lines.join('\n');
}

function buildFileCountsBlock(context: DiscoveryContext): string[] {
  const fileCounts = Object.entries(context.fileCountsByDirectory)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_FILE_COUNT_DIRS_IN_PROMPT);

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

function buildSymbolSummariesBlock(context: DiscoveryContext): string[] {
  if (!context.symbolSummaries) {
    return [];
  }

  const symbols = Object.entries(context.symbolSummaries)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_SYMBOL_SUMMARY_DIRS_IN_PROMPT);

  if (symbols.length === 0) {
    return [];
  }

  const omittedCount = Object.keys(context.symbolSummaries).length - symbols.length;
  return [
    '',
    '### Symbol Summaries',
    ...symbols.map(([dir, names]) => {
      const included = names.slice(0, MAX_SYMBOLS_PER_DIR_IN_PROMPT);
      const omittedSymbols = names.length - included.length;
      return `  ${dir}: ${included.join(', ')}${omittedSymbols > 0 ? ` (+${omittedSymbols} more symbols)` : ''}`;
    }),
    ...(omittedCount > 0
      ? [`  ... ${omittedCount} more directories omitted for prompt budget`]
      : []),
  ];
}

function buildCrossReferencesBlock(context: DiscoveryContext): string[] {
  if (!context.crossReferences || context.crossReferences.length === 0) {
    return [];
  }

  const refs = context.crossReferences.slice(0, MAX_CROSS_REFERENCES_IN_PROMPT);
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

function buildExistingExpertsBlock(context: DiscoveryContext): string[] {
  if (context.existingExperts.length === 0) {
    return ['', '### Already Registered Experts', '  None'];
  }

  const experts = context.existingExperts.slice(0, MAX_EXISTING_EXPERTS_IN_PROMPT);
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

function buildOverlayBlock(context: DiscoveryContext): string[] {
  if (!context.overlayTrustState || context.overlayTrustState === 'no-overlay') {
    return [];
  }

  const lines = ['', `### Overlay Trust Level`, `  ${context.overlayTrustState}`];

  if (context.overlayNeighborhoods && context.overlayNeighborhoods.length > 0) {
    lines.push('', '### Structural Neighborhoods (from overlay)');
    for (const nbhd of context.overlayNeighborhoods.slice(0, MAX_OVERLAY_NEIGHBORHOODS_IN_PROMPT)) {
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

    const omittedCount = context.overlayNeighborhoods.length - MAX_OVERLAY_NEIGHBORHOODS_IN_PROMPT;
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
 * Spawns Claude CLI with the discovery context and parses the
 * structured JSON response into a DiscoveryProposal.
 */
export async function analyze(
  context: DiscoveryContext,
  options: DiscoveryOptions
): Promise<DiscoveryProposal> {
  const model = options.model ?? DEFAULT_MODEL;
  const prompt = buildAnalysisPrompt(context);

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= ANALYSIS_MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await spawnClaude(prompt, model);
      const proposal = parseProposalResponse(raw);
      if (context.overlayNeighborhoods && context.overlayNeighborhoods.length > 0) {
        attachStructuralSignatures(proposal.experts, context.overlayNeighborhoods);
      }
      return proposal;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      if (attempt >= ANALYSIS_MAX_ATTEMPTS || !isRetryableAnalysisError(err)) {
        throw err;
      }
    }
  }

  throw lastError ?? new Error('Expert discovery analysis failed');
}

// ── Claude CLI Subprocess ─────────────────────────────────

/**
 * Spawn the Claude CLI in print mode and return stdout.
 * Exported for testing.
 */
export function buildClaudeArgs(prompt: string, model: string): string[] {
  return ['--print', '--permission-mode', 'bypassPermissions', '--model', model, prompt];
}

function spawnClaude(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', buildClaudeArgs(prompt, model), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildCleanEnv(),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      }, 5_000);
      reject(new Error(`Claude CLI timed out after ${ANALYSIS_TIMEOUT_MS}ms`));
    }, ANALYSIS_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      if (code !== 0) {
        const stdoutTrimmed = stdout.trim();
        const stderrTrimmed = stderr.trim();
        const detail = stdoutTrimmed || stderrTrimmed || `Process exited with code ${code}`;
        reject(new Error(`Claude CLI failed: ${detail}`));
        return;
      }

      if (!stdout.trim()) {
        reject(new Error('Claude CLI returned empty output'));
        return;
      }

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
        `Failed to parse AI response as JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      parsed = JSON.parse(extracted);
    } catch (nestedError) {
      throw new Error(
        `Failed to parse AI response as JSON: ${nestedError instanceof Error ? nestedError.message : String(nestedError)}`
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
