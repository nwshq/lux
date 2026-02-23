import { spawn } from 'child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildCleanEnv } from '../utils/subprocess-env.js';

// ── Config Schema ──────────────────────────────────────────

const TypeRuleSchema = z.object({
  pattern: z.string(),
  doc_type: z.string(),
});

const ScannerConfigSchema = z.object({
  include: z.array(z.string()).default(['**/*.md']),
  exclude: z.array(z.string()).default([
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    '.next/**',
    'vendor/**',
  ]),
  type_rules: z.array(TypeRuleSchema).default([
    { pattern: '**/communications/**', doc_type: 'communication' },
    { pattern: '**/explorations/**', doc_type: 'exploration' },
    { pattern: '**/journal/**', doc_type: 'journal' },
  ]),
  default_type: z.string().default('document'),
});

const LuxConfigSchema = z.object({
  version: z.number().int().min(1).default(1),
  scanner: ScannerConfigSchema.default({}),
});

export type LuxConfig = z.infer<typeof LuxConfigSchema>;

// ── Public Types ───────────────────────────────────────────

export interface InitOptions {
  rootPath: string;
  force?: boolean;
  model?: string;
  skipAi?: boolean;
}

export interface InitResult {
  configPath: string;
  config: LuxConfig;
  aiGenerated: boolean;
}

// ── Constants ──────────────────────────────────────────────

const CONFIG_FILENAME = 'lux.yaml';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const INIT_TIMEOUT_MS = 60_000;
const MAX_TREE_DEPTH = 5;
const MAX_TREE_ENTRIES = 200;

const IGNORE_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.cache',
  '.venv',
  'venv',
  'target',
]);

// ── Main Entry Point ───────────────────────────────────────

/**
 * Initialize a lux.yaml config for a content directory.
 *
 * When AI is enabled (default), spawns Claude CLI to analyze the directory
 * structure and generate appropriate type_rules for document classification.
 * Falls back to sensible defaults if AI is skipped or fails.
 */
export async function initCorpus(options: InitOptions): Promise<InitResult> {
  const { rootPath, force, model, skipAi } = options;

  if (!existsSync(rootPath)) {
    throw new Error(`Directory not found: ${rootPath}`);
  }

  const stat = statSync(rootPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${rootPath}`);
  }

  const configPath = join(rootPath, CONFIG_FILENAME);

  if (existsSync(configPath) && !force) {
    throw new Error(
      `Config already exists: ${configPath}\n  Use --force to overwrite.`,
    );
  }

  let config: LuxConfig;
  let aiGenerated = false;

  if (skipAi) {
    config = LuxConfigSchema.parse({});
  } else {
    const tree = collectDirectoryTree(rootPath);

    try {
      config = await generateConfigWithAi(tree, model);
      aiGenerated = true;
    } catch (error) {
      // Fall back to defaults if AI fails
      config = LuxConfigSchema.parse({});
    }
  }

  const yamlContent = renderConfigYaml(config, rootPath, aiGenerated);
  writeFileSync(configPath, yamlContent, 'utf-8');

  return { configPath, config, aiGenerated };
}

// ── Directory Tree Collection ──────────────────────────────

/**
 * Collect a limited directory tree for AI analysis.
 * Produces a tree-formatted string showing directory structure,
 * capped at MAX_TREE_DEPTH levels and MAX_TREE_ENTRIES entries.
 */
export function collectDirectoryTree(rootPath: string): string {
  const lines: string[] = [];
  let entryCount = 0;

  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > MAX_TREE_DEPTH || entryCount >= MAX_TREE_ENTRIES) return;

    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    // Filter out ignored directories and hidden files
    entries = entries.filter((e) => {
      if (e.startsWith('.')) return false;
      if (IGNORE_DIRS.has(e)) return false;
      return true;
    });

    for (let i = 0; i < entries.length; i++) {
      if (entryCount >= MAX_TREE_ENTRIES) {
        lines.push(`${prefix}... (truncated)`);
        return;
      }

      const entry = entries[i];
      const fullPath = join(dir, entry);
      const isLast = i === entries.length - 1;
      const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 ';
      const childPrefix = isLast ? '    ' : '\u2502   ';

      let isDir = false;
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        continue;
      }

      const displayName = isDir ? `${entry}/` : entry;
      lines.push(`${prefix}${connector}${displayName}`);
      entryCount++;

      if (isDir) {
        walk(fullPath, depth + 1, prefix + childPrefix);
      }
    }
  }

  lines.push(`${basename(rootPath)}/`);
  entryCount++;
  walk(rootPath, 1, '');

  return lines.join('\n');
}

// ── AI Config Generation ───────────────────────────────────

const AI_PROMPT = `You are analyzing a content directory structure to generate a lux.yaml configuration file.

lux.yaml configures how Lux scans and classifies documents. The key section is "scanner" with these fields:

- include: glob patterns for files to scan (default: ["**/*.md"])
- exclude: glob patterns to skip (default: ["node_modules/**", ".git/**", "dist/**", "build/**", ".next/**", "vendor/**"])
- type_rules: ordered list of {pattern, doc_type} rules for classifying documents by path
- default_type: fallback type when no rule matches (default: "document")

Common doc_type values:
- communication: meeting notes, emails, messages
- exploration: research, investigation, analysis documents
- journal: journal entries, logs, daily notes
- methodology: process docs, how-tos, standards
- spec: specifications, requirements
- architecture: system design, diagrams, ADRs
- payload: implementation payloads, task breakdowns
- readme: README files

type_rules are matched in order — first match wins. Use glob patterns relative to the root.

Given the following directory tree, generate ONLY valid YAML (no markdown fences, no commentary) for a lux.yaml file. Include version: 1 and a scanner section with appropriate type_rules for this directory structure. Be conservative — only add rules for directory patterns you can clearly identify.

Directory tree:
`;

/**
 * Spawn Claude CLI to generate config based on directory structure analysis.
 */
async function generateConfigWithAi(
  directoryTree: string,
  model?: string,
): Promise<LuxConfig> {
  const prompt = AI_PROMPT + directoryTree;
  const effectiveModel = model ?? DEFAULT_MODEL;

  const raw = await spawnClaude(
    ['--print', '--model', effectiveModel, prompt],
    INIT_TIMEOUT_MS,
  );

  return parseAndValidateYaml(raw);
}

// ── YAML Parsing & Validation ──────────────────────────────

/**
 * Parse raw YAML text and validate against the LuxConfig schema.
 * Strips markdown code fences if present (in case the AI wraps output).
 */
export function parseAndValidateYaml(raw: string): LuxConfig {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:ya?ml)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(cleaned);
  } catch (error) {
    throw new Error(
      `Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    throw new Error('YAML parsed to non-object value');
  }

  const result = LuxConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${issues}`);
  }

  return result.data;
}

// ── Claude CLI Subprocess ──────────────────────────────────

/**
 * Spawn a Claude CLI process and return its stdout.
 * Uses clean environment isolation and proper timeout handling.
 */
function spawnClaude(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildCleanEnv(),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      // Escalate to SIGKILL after 5s
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      }, 5_000);
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr!.on('data', (chunk: Buffer) => {
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

// ── YAML Rendering ─────────────────────────────────────────

/**
 * Render a LuxConfig to a human-readable YAML string with a descriptive header.
 */
function renderConfigYaml(
  config: LuxConfig,
  rootPath: string,
  aiGenerated: boolean,
): string {
  const dirName = basename(rootPath);
  const method = aiGenerated ? 'AI-generated' : 'default template';

  const header = [
    `# Lux configuration for ${dirName}`,
    `# Generated by \`lux init\` (${method})`,
    '#',
    '# scanner.type_rules controls how documents are classified.',
    '# Rules are matched in order; first match wins.',
    '# See: https://github.com/anthropics/lux for documentation.',
    '',
  ].join('\n');

  const body = stringifyYaml(config, {
    indent: 2,
    lineWidth: 100,
  });

  return header + body;
}
