import { spawn } from 'child_process';
import { buildCleanEnv } from '../utils/subprocess-env.js';
import type { DiscoveryContext, DiscoveryOptions, DiscoveryProposal } from './types.js';

// ── Constants ──────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const ANALYSIS_TIMEOUT_MS = 120_000;

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
      "confidence": "number (0.0 to 1.0)"
    }
  ],
  "rationale": "string (brief rationale for the overall proposed structure)"
}`;

/**
 * Build the analysis prompt from discovery context.
 * Exported for testing.
 */
export function buildAnalysisPrompt(context: DiscoveryContext): string {
  const sections: string[] = [
    `You are analyzing a codebase to propose domain expert boundaries for a multi-expert AI panel system. Each expert manages a subdirectory of the content root and specializes in a specific domain.`,
    '',
    '## Context',
    '',
    '### Directory Tree',
    context.tree,
  ];

  // File counts by directory
  const fileCounts = Object.entries(context.fileCountsByDirectory);
  if (fileCounts.length > 0) {
    sections.push('', '### File Counts by Directory');
    for (const [dir, count] of fileCounts) {
      sections.push(`  ${dir}: ${count}`);
    }
  }

  // Symbol summaries (optional, Phase 3+)
  if (context.symbolSummaries) {
    const symbols = Object.entries(context.symbolSummaries);
    if (symbols.length > 0) {
      sections.push('', '### Symbol Summaries');
      for (const [dir, names] of symbols) {
        sections.push(`  ${dir}: ${names.join(', ')}`);
      }
    }
  }

  // Cross-references (optional, Phase 3+)
  if (context.crossReferences && context.crossReferences.length > 0) {
    sections.push('', '### Cross-References');
    for (const ref of context.crossReferences) {
      sections.push(`  ${ref.sourceDir} → ${ref.targetDir} (${ref.referenceCount} refs)`);
    }
  }

  // Existing experts
  if (context.existingExperts.length > 0) {
    sections.push('', '### Already Registered Experts');
    for (const expert of context.existingExperts) {
      sections.push(`  - ${expert.slug} (${expert.mountPath})`);
    }
  } else {
    sections.push('', '### Already Registered Experts', '  None');
  }

  sections.push(
    '',
    '## Instructions',
    '',
    'Propose expert boundaries that:',
    '1. Cover distinct functional domains (not just directory names)',
    '2. Group tightly-coupled directories under one expert when they share a domain (e.g., models + controllers + views for "invoicing")',
    '3. Avoid overlapping mount paths',
    '4. Do not duplicate already-registered experts',
    '5. Include a brief domain description for each proposed expert',
    '',
    `Respond with ONLY valid JSON matching this schema:`,
    OUTPUT_SCHEMA
  );

  return sections.join('\n');
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
  const raw = await spawnClaude(prompt, model);
  return parseProposalResponse(raw);
}

// ── Claude CLI Subprocess ─────────────────────────────────

/**
 * Spawn the Claude CLI in print mode and return stdout.
 * Exported for testing.
 */
function spawnClaude(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--print', '--model', model, prompt], {
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
        const detail = stderr.trim() || `Process exited with code ${code}`;
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
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(
      `Failed to parse AI response as JSON: ${error instanceof Error ? error.message : String(error)}`
    );
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

    return {
      slug: expert.slug as string,
      name: expert.name as string,
      mountPath: expert.mountPath as string,
      additionalPaths,
      description: expert.description as string,
      reasoning: expert.reasoning as string,
      confidence: expert.confidence,
    };
  });

  return {
    experts,
    rationale: obj.rationale,
  };
}
