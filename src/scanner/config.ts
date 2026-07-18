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

/** Dependency analysis configuration. */
export interface DepsConfig {
  /** Whether dependency analysis is enabled (default: true when boundaries detected). */
  enabled: boolean;
  /** Module boundary pattern, e.g. "src/Module/{name}". */
  moduleBoundary?: string;
}

/** Tree-sitter AST structural-tier configuration. */
export interface AstConfig {
  /** Whether the AST structural tier is enabled (default: true — zero-config). */
  enabled: boolean;
}

/** Content/source scanning configuration. */
export interface ScanConfig {
  /**
   * Exclude generated build artifacts (compiled/minified bundles under
   * public/, sourcemaps). Default: true — the biggest app-build lever, and
   * lossless for the call graph (the bundles are a derived copy of authored
   * source). Set false for apps that serve AUTHORED js from public/.
   */
  excludeGeneratedArtifacts: boolean;
  /** Extra ignore globs, unioned with the built-in defaults. */
  ignorePatterns: string[];
}

/** Top-level lux.yaml configuration (LSP-specific fields). */
export interface LuxLspConfig {
  /** LSP enrichment configuration. */
  lsp: LspConfig;
  /** Dependency analysis configuration. */
  deps: DepsConfig;
  /** AST structural tier configuration. */
  ast?: AstConfig;
  /** Content/source scanning configuration. */
  scan?: ScanConfig;
  /** First-party package promotion (E1): globs against composer package names. */
  firstParty?: FirstPartyConfig;
}

/** The firstParty section of lux.yaml. */
export interface FirstPartyConfig {
  /** Composer package-name globs to promote to app-source, e.g. ["acme/*"]. */
  packages: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: false,
  enrichers: [],
};

const DEFAULT_DEPS_CONFIG: DepsConfig = {
  enabled: true,
};

const DEFAULT_AST_CONFIG: AstConfig = {
  enabled: true,
};

const DEFAULT_SCAN_CONFIG: ScanConfig = {
  excludeGeneratedArtifacts: true,
  ignorePatterns: [],
};

const DEFAULT_CONFIG: LuxLspConfig = {
  lsp: DEFAULT_LSP_CONFIG,
  deps: DEFAULT_DEPS_CONFIG,
  ast: DEFAULT_AST_CONFIG,
  scan: DEFAULT_SCAN_CONFIG,
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

interface RawDepsConfig {
  enabled?: unknown;
  module_boundary?: unknown;
}

interface RawLuxConfig {
  lsp?: unknown;
  deps?: unknown;
  ast?: unknown;
  scan?: unknown;
  firstParty?: unknown;
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
      `Failed to parse lux.yaml: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    return DEFAULT_CONFIG;
  }

  return validateConfig(parsed);
}

/**
 * Validate and normalize a raw parsed YAML object into a LuxLspConfig.
 */
function validateConfig(raw: RawLuxConfig): LuxLspConfig {
  return {
    lsp: raw.lsp ? validateLspConfig(raw.lsp) : DEFAULT_LSP_CONFIG,
    deps: raw.deps ? validateDepsConfig(raw.deps) : DEFAULT_DEPS_CONFIG,
    ast: raw.ast ? validateAstConfig(raw.ast) : DEFAULT_AST_CONFIG,
    scan: raw.scan ? validateScanConfig(raw.scan) : DEFAULT_SCAN_CONFIG,
    firstParty: validateFirstPartyConfig(raw.firstParty),
  };
}

function validateFirstPartyConfig(raw: unknown): FirstPartyConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const packages = (raw as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return undefined;
  const globs = packages.filter((p): p is string => typeof p === 'string');
  return globs.length ? { packages: globs } : undefined;
}

function validateAstConfig(raw: unknown): AstConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_AST_CONFIG;
  const obj = raw as { enabled?: unknown };
  // On by default (zero-config); only an explicit `enabled: false` opts out.
  return { enabled: obj.enabled !== false };
}

function validateScanConfig(raw: unknown): ScanConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SCAN_CONFIG;
  const obj = raw as { exclude_generated_artifacts?: unknown; ignore_patterns?: unknown };
  return {
    // On by default; only an explicit `exclude_generated_artifacts: false` opts out.
    excludeGeneratedArtifacts: obj.exclude_generated_artifacts !== false,
    ignorePatterns: Array.isArray(obj.ignore_patterns)
      ? obj.ignore_patterns.filter((p): p is string => typeof p === 'string')
      : [],
  };
}

function validateDepsConfig(raw: unknown): DepsConfig {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_DEPS_CONFIG;
  }

  const config = raw as RawDepsConfig;

  return {
    enabled: config.enabled !== false,
    moduleBoundary: typeof config.module_boundary === 'string' ? config.module_boundary : undefined,
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
