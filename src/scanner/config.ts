// Scanner configuration: loads and validates lux.yaml LSP section from the content root.
//
// The lux.yaml file is optional. When present, it configures LSP enrichers
// and other scanner behavior. When absent, defaults are used (no enrichment).

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/** Configuration for a single LSP enricher in lux.yaml. */
export interface LspEnricherEntry {
  /** Language identifier (e.g. "php", "typescript"). */
  languageId: string;
  /** Whether this enricher is enabled (default: true). */
  enabled?: boolean;
  /** Command to spawn the language server. */
  serverCommand?: string;
  /** Arguments to pass to the language server. */
  serverArgs?: string[];
  /** Maximum concurrent LSP requests. */
  maxConcurrency?: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Initialization timeout in milliseconds. */
  initTimeoutMs?: number;
}

/** The lsp section of lux.yaml. */
export interface LspConfig {
  /** Whether LSP enrichment is enabled globally (default: false). */
  enabled: boolean;
  /** Workspace root override for LSP servers (default: content root path). */
  workspaceRoot?: string;
  /** Per-language enricher configurations. */
  enrichers: LspEnricherEntry[];
}

/** Top-level lux.yaml configuration (LSP-specific fields). */
export interface LuxLspConfig {
  /** LSP enrichment configuration. */
  lsp: LspConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: false,
  enrichers: [],
};

const DEFAULT_CONFIG: LuxLspConfig = {
  lsp: DEFAULT_LSP_CONFIG,
};

// ---------------------------------------------------------------------------
// Raw YAML shape (pre-validation)
// ---------------------------------------------------------------------------

interface RawLspEnricherEntry {
  language_id?: unknown;
  enabled?: unknown;
  server_command?: unknown;
  server_args?: unknown;
  max_concurrency?: unknown;
  request_timeout_ms?: unknown;
  init_timeout_ms?: unknown;
}

interface RawLspConfig {
  enabled?: unknown;
  workspace_root?: unknown;
  enrichers?: unknown;
}

interface RawLuxConfig {
  lsp?: unknown;
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

/**
 * Load LSP configuration from a lux.yaml file in the given directory.
 *
 * @param rootPath - Root directory to look for lux.yaml.
 * @returns Parsed and validated configuration, with defaults applied.
 */
export function loadLspConfig(rootPath: string): LuxLspConfig {
  const configPath = join(rootPath, 'lux.yaml');

  let rawContent: string;
  try {
    rawContent = readFileSync(configPath, 'utf-8');
  } catch {
    // No config file — return defaults (LSP disabled)
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawContent);
  } catch (error) {
    throw new Error(
      `Failed to parse lux.yaml: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    return DEFAULT_CONFIG;
  }

  return validateConfig(parsed as RawLuxConfig);
}

/**
 * Validate and normalize a raw parsed YAML object into a LuxLspConfig.
 */
function validateConfig(raw: RawLuxConfig): LuxLspConfig {
  return {
    lsp: raw.lsp ? validateLspConfig(raw.lsp) : DEFAULT_LSP_CONFIG,
  };
}

function validateLspConfig(raw: unknown): LspConfig {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_LSP_CONFIG;
  }

  const config = raw as RawLspConfig;

  return {
    enabled: config.enabled === true,
    workspaceRoot: typeof config.workspace_root === 'string' ? config.workspace_root : undefined,
    enrichers: Array.isArray(config.enrichers)
      ? config.enrichers.map(validateEnricherEntry).filter(isValidEntry)
      : [],
  };
}

function validateEnricherEntry(raw: unknown): LspEnricherEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const entry = raw as RawLspEnricherEntry;

  if (typeof entry.language_id !== 'string' || !entry.language_id) {
    return null;
  }

  return {
    languageId: entry.language_id,
    enabled: entry.enabled !== false,
    serverCommand: typeof entry.server_command === 'string' ? entry.server_command : undefined,
    serverArgs: Array.isArray(entry.server_args)
      ? entry.server_args.filter((a): a is string => typeof a === 'string')
      : undefined,
    maxConcurrency:
      typeof entry.max_concurrency === 'number' && entry.max_concurrency > 0
        ? entry.max_concurrency
        : undefined,
    requestTimeoutMs:
      typeof entry.request_timeout_ms === 'number' && entry.request_timeout_ms > 0
        ? entry.request_timeout_ms
        : undefined,
    initTimeoutMs:
      typeof entry.init_timeout_ms === 'number' && entry.init_timeout_ms > 0
        ? entry.init_timeout_ms
        : undefined,
  };
}

function isValidEntry(entry: LspEnricherEntry | null): entry is LspEnricherEntry {
  return entry !== null;
}
