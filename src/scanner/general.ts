import { readFileSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';
import type { Frontmatter, ScannedKnowledge, ScanResult } from './types.js';
import type { LuxDatabase } from '../db/index.js';
import { loadLspConfig, type LuxLspConfig, type LspEnricherEntry } from './config.js';
import { EnricherRegistry, type EnrichmentMap } from './lsp/index.js';
import { PhpLspEnricher } from './lsp/php.js';
import { TypeScriptLspEnricher } from './lsp/typescript.js';
import { parseImports } from './imports/index.js';
import { detectModuleBoundaries, resolveModule } from './imports/module-boundary.js';
import {
  rebuildStructuralOverlay,
  type OverlayRebuildResult,
} from './associations/overlay-service.js';

// ---------------------------------------------------------------------------
// Source Code Scanning Constants
// ---------------------------------------------------------------------------

/** File extensions to scan as source code, grouped by language. */
export const SOURCE_CODE_EXTENSIONS: string[] = [
  '.php',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rb',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.vue',
  '.svelte',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
];

/** Map file extension to language identifier. */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.php': 'php',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
};

/** Directory patterns to always exclude from source code scanning. */
export const SOURCE_CODE_IGNORE_PATTERNS: string[] = [
  'node_modules/**',
  'vendor/**',
  '.git/**',
  'dist/**',
  'build/**',
  'out/**',
  '.next/**',
  '.nuxt/**',
  'coverage/**',
  '__pycache__/**',
  'target/**',
  '**/*.min.js',
  '**/*.min.css',
];

/** Manifest files whose presence indicates a source code repository. */
const SOURCE_CODE_MANIFEST_FILES: string[] = [
  'package.json',
  'composer.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Gemfile',
  'build.gradle',
  'pom.xml',
  'Makefile',
  'CMakeLists.txt',
  'setup.py',
  'requirements.txt',
];

/**
 * Detect the language identifier for a file based on its extension.
 */
export function detectLanguage(ext: string): string {
  return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';
}

/**
 * Infer tags from a source code file path by extracting meaningful
 * directory and filename segments.
 */
export function inferTagsFromPath(filePath: string): string[] {
  const parts = filePath.split('/');
  const tags: string[] = [];

  for (const part of parts) {
    const name = part.includes('.') ? basename(part, extname(part)) : part;
    if (name && name !== 'src' && name !== 'lib' && name !== 'index') {
      tags.push(name);
    }
  }

  return tags;
}

export class GeneralScanner {
  private rootPath?: string;

  constructor(rootPath?: string) {
    this.rootPath = rootPath;
  }

  async scan(rootPath?: string): Promise<ScanResult> {
    // Allow root path to be passed to scan() or use constructor value
    const scanPath = rootPath ?? this.rootPath;
    if (!scanPath) {
      throw new Error('Root path must be provided either to constructor or scan()');
    }
    const knowledge: ScannedKnowledge[] = [];

    // Scan all markdown files recursively from the root
    const mdFiles = await glob('**/*.md', { cwd: scanPath });

    for (const mdFile of mdFiles) {
      const filePath = join(scanPath, mdFile);
      const fileData = this.parseMarkdownFile(filePath);

      knowledge.push({
        type: this.inferKnowledgeType(mdFile, fileData.frontmatter),
        title:
          fileData.frontmatter?.title ??
          fileData.frontmatter?.name ??
          this.extractTitleFromFilename(mdFile),
        filePath,
        tags: fileData.frontmatter?.tags,
        frontmatter: fileData.frontmatter,
        content: fileData.content,
      });
    }

    // Scan source code files if this looks like a code repository
    if (this.isSourceCodeRepository(scanPath)) {
      const sourceFiles = await this.discoverSourceCodeFiles(scanPath);

      for (const sourceFile of sourceFiles) {
        const filePath = join(scanPath, sourceFile);
        const ext = extname(sourceFile);
        const language = EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';

        let content: string;
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch {
          continue; // Skip unreadable files
        }

        knowledge.push({
          type: 'source-code',
          title: sourceFile,
          filePath,
          tags: this.inferTagsFromPath(sourceFile),
          frontmatter: { language, extension: ext },
          content,
        });
      }
    }

    return { knowledge };
  }

  /**
   * Check if a directory looks like a source code repository by checking
   * for common manifest/build files.
   */
  private isSourceCodeRepository(rootPath: string): boolean {
    return SOURCE_CODE_MANIFEST_FILES.some((manifest) => existsSync(join(rootPath, manifest)));
  }

  /**
   * Discover source code files in a directory, respecting ignore patterns.
   */
  private async discoverSourceCodeFiles(rootPath: string): Promise<string[]> {
    const extensionGlobs = SOURCE_CODE_EXTENSIONS.map((ext) => `**/*${ext}`);
    const files = await glob(extensionGlobs, {
      cwd: rootPath,
      ignore: SOURCE_CODE_IGNORE_PATTERNS,
      nodir: true,
    });
    return files;
  }

  /**
   * Infer tags from a source code file path by extracting meaningful
   * directory and filename segments.
   */
  private inferTagsFromPath(filePath: string): string[] {
    const parts = filePath.split('/');
    const tags: string[] = [];

    for (const part of parts) {
      // Use directory names and the file stem (without extension)
      const name = part.includes('.') ? basename(part, extname(part)) : part;
      // Skip common uninformative segments
      if (name && name !== 'src' && name !== 'lib' && name !== 'index') {
        tags.push(name);
      }
    }

    return tags;
  }

  private parseMarkdownFile(filePath: string): { frontmatter?: Frontmatter; content: string } {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = matter(content);
      return {
        frontmatter: parsed.data as Frontmatter,
        content: parsed.content,
      };
    } catch {
      return { content: '' };
    }
  }

  private slugToTitle(slug: string): string {
    return slug
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private extractTitleFromFilename(filename: string): string {
    const base = basename(filename, '.md');
    // Remove date prefix if present
    const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}_/, '');
    return this.slugToTitle(withoutDate);
  }

  private inferKnowledgeType(filePath: string, frontmatter?: Frontmatter): string {
    if (frontmatter?.type) return String(frontmatter.type);

    if (filePath.includes('methodology')) return 'methodology';
    if (filePath.includes('specs')) return 'spec';
    if (filePath.includes('architecture')) return 'architecture';
    if (filePath.includes('explorations')) return 'exploration';
    if (filePath.includes('implementation-payloads')) return 'implementation-payload';
    if (filePath.includes('payloads')) return 'payload';

    return 'general';
  }

  /**
   * Index scanned entities into the database.
   * This method takes the result of scan() and writes all entities to SQLite.
   *
   * @param db - The LuxDatabase instance to write to
   * @param scanResult - The result from scan() containing all entities
   * @returns Summary of indexed entities with counts
   */
  index(
    db: LuxDatabase,
    scanResult: ScanResult
  ): Promise<{
    knowledge: number;
  }> {
    // Validate inputs
    if (!db) {
      return Promise.reject(new Error('Database instance is required for indexing'));
    }
    if (!scanResult || typeof scanResult !== 'object') {
      return Promise.reject(new Error('Invalid scan result: must be an object'));
    }
    if (!Array.isArray(scanResult.knowledge)) {
      return Promise.reject(new Error('Invalid scan result: knowledge must be an array'));
    }

    let indexedCounts = { knowledge: 0 };

    try {
      // Index knowledge entries
      for (const entry of scanResult.knowledge) {
        // Validate knowledge data
        if (!entry.type || typeof entry.type !== 'string') {
          throw new Error(
            `Invalid knowledge entry: missing or invalid type (file: ${entry.filePath})`
          );
        }
        if (!entry.title || typeof entry.title !== 'string') {
          throw new Error(
            `Invalid knowledge entry: missing or invalid title (file: ${entry.filePath})`
          );
        }

        try {
          db.insertKnowledgeEntry({
            type: entry.type,
            title: entry.title,
            file_path: entry.filePath,
            tags: entry.tags,
            metadata: entry.frontmatter,
            content: entry.content,
          });
          indexedCounts.knowledge++;
        } catch (error) {
          throw new Error(
            `Failed to insert knowledge entry "${entry.title}" (${entry.filePath}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      return Promise.resolve(indexedCounts);
    } catch (error) {
      // Add context about what was successfully indexed before the error
      const partialMsg = `Partial index created: ${indexedCounts.knowledge} knowledge entries. `;
      if (error instanceof Error) {
        return Promise.reject(new Error(partialMsg + error.message));
      }
      return Promise.reject(new Error(partialMsg + String(error)));
    }
  }
}

// ---------------------------------------------------------------------------
// LSP Enrichment Pipeline
// ---------------------------------------------------------------------------

/** Enrichment results indexed by file path. Re-exported from lsp/index for convenience. */
export type { EnrichmentMap } from './lsp/index.js';

/** Aggregated module dependency ready for DB insertion. */
export interface AggregatedDependency {
  source_module: string;
  target_module: string;
  reference_count: number;
  sample_files: string[];
}

/** Result of a full scan+enrich pipeline run. */
export interface GeneralScanResult {
  /** The base scan result from GeneralScanner. */
  scan: ScanResult;
  /** LSP enrichment results keyed by file path. */
  enrichments: EnrichmentMap;
  /** Aggregated module dependencies from import parsing. */
  dependencies: AggregatedDependency[];
  /** Summary statistics. */
  stats: {
    /** Number of files that were enriched. */
    enrichedFiles: number;
    /** Number of enrichers that were initialized. */
    activeEnrichers: number;
    /** Errors encountered during enrichment (non-fatal). */
    enrichmentErrors: Array<{ filePath: string; error: string }>;
  };
  /** Structural overlay rebuild result (only present when overlayEnabled=true). */
  overlay?: OverlayRebuildResult;
}

/** Options for the general scan pipeline. */
export interface GeneralScanOptions {
  /** Override LSP config instead of loading from lux.yaml. */
  config?: LuxLspConfig;
  /** Callback for progress reporting. */
  onProgress?: (message: string) => void;
  /** Callback for enrichment errors. */
  onEnrichmentError?: (filePath: string, error: Error) => void;
  /** Database to write structural overlay into. Required when overlayEnabled=true. */
  db?: LuxDatabase;
  /** Run structural overlay rebuild after scan+enrich. Requires db option. */
  overlayEnabled?: boolean;
}

/** Map of language IDs to factory functions for built-in enrichers. */
const ENRICHER_FACTORIES: Record<
  string,
  (entry: LspEnricherEntry) => PhpLspEnricher | TypeScriptLspEnricher
> = {
  php: (entry) =>
    new PhpLspEnricher({
      serverCommand: entry.serverCommand,
      serverArgs: entry.serverArgs,
      maxConcurrency: entry.maxConcurrency,
      requestTimeoutMs: entry.requestTimeoutMs,
      initTimeoutMs: entry.initTimeoutMs,
    }),
  typescript: (entry) =>
    new TypeScriptLspEnricher({
      serverCommand: entry.serverCommand,
      serverArgs: entry.serverArgs,
      maxConcurrency: entry.maxConcurrency,
      requestTimeoutMs: entry.requestTimeoutMs,
      initTimeoutMs: entry.initTimeoutMs,
    }),
};

/**
 * Run the full scan-then-enrich pipeline.
 *
 * 1. Loads LSP configuration from lux.yaml (or uses provided config)
 * 2. Scans the content directory for entities
 * 3. If LSP enrichment is enabled, initializes enrichers and enriches files
 * 4. Returns combined scan + enrichment results
 *
 * LSP enrichment failures are non-fatal — the scan result is always returned
 * even if enrichment partially or fully fails.
 *
 * @param rootPath - Root path of the content directory.
 * @param options - Pipeline options.
 * @returns Combined scan and enrichment results.
 */
export async function generalScan(
  rootPath: string,
  options?: GeneralScanOptions
): Promise<GeneralScanResult> {
  const report = options?.onProgress ?? (() => {});
  const config = options?.config ?? loadLspConfig(rootPath);

  // 1. Run the base scan
  report('Scanning content directory...');
  const scanner = new GeneralScanner(rootPath);
  const scan = await scanner.scan();

  // 2. Parse imports and compute module dependencies (independent of LSP)
  const dependencies = parseDependencies(scan, rootPath, config, report);

  const enrichments: EnrichmentMap = new Map();
  const errors: Array<{ filePath: string; error: string }> = [];
  let activeCount = 0;

  if (!config.lsp.enabled) {
    report('LSP enrichment disabled.');
  } else {
    // 3. Build enricher registry from config
    report('Initializing LSP enrichers...');
    const registry = buildRegistry(config.lsp.enrichers);

    if (registry.size === 0) {
      report('No LSP enrichers configured.');
    } else {
      // 4. Initialize enrichers
      const workspaceRoot = config.lsp.workspaceRoot ?? rootPath;

      for (const enricher of registry.getAll()) {
        try {
          report(`Initializing ${enricher.languageId} enricher...`);
          await enricher.initialize(workspaceRoot);
          activeCount++;
        } catch (error) {
          report(
            `Failed to initialize ${enricher.languageId} enricher: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // 5. Collect enrichable files from scan results
      const filesToEnrich = collectEnrichableFiles(scan, registry);
      report(`Found ${filesToEnrich.size} files to enrich across ${activeCount} enrichers.`);

      // 6. Run enrichment
      for (const [languageId, filePaths] of filesToEnrich) {
        const enricher = registry.get(languageId);
        if (!enricher?.isReady) continue;

        report(`Enriching ${filePaths.length} ${languageId} files...`);

        for (const filePath of filePaths) {
          try {
            const result = await enricher.enrich(filePath);
            if (result) {
              enrichments.set(filePath, result);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ filePath, error: message });
            options?.onEnrichmentError?.(
              filePath,
              error instanceof Error ? error : new Error(message)
            );
          }
        }
      }

      // 7. Shut down enrichers
      report('Shutting down LSP enrichers...');
      try {
        await registry.shutdownAll();
      } catch (error) {
        report(
          `Warning: enricher shutdown errors: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  report(`Enrichment complete: ${enrichments.size} files enriched, ${errors.length} errors.`);

  // 8. Optionally rebuild structural overlay
  let overlay: OverlayRebuildResult | undefined;
  if (options?.overlayEnabled && options.db) {
    report('Rebuilding structural overlay...');
    try {
      overlay = await rebuildStructuralOverlay(options.db, rootPath, scan, enrichments, {
        onProgress: report,
      });
      report(
        `Overlay complete: ${overlay.fileNodes} file node(s), ${overlay.symbolNodes} symbol node(s), ` +
          `${overlay.edgesStored} edge(s) stored.`
      );
    } catch (error) {
      report(
        `Warning: overlay rebuild failed — ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    scan,
    enrichments,
    dependencies,
    stats: {
      enrichedFiles: enrichments.size,
      activeEnrichers: activeCount,
      enrichmentErrors: errors,
    },
    overlay,
  };
}

/**
 * Build an EnricherRegistry from lux.yaml enricher entries.
 * Only creates enrichers for known language IDs with enabled=true.
 */
function buildRegistry(entries: LspEnricherEntry[]): EnricherRegistry {
  const registry = new EnricherRegistry();

  for (const entry of entries) {
    if (entry.enabled === false) continue;

    const factory = ENRICHER_FACTORIES[entry.languageId];
    if (!factory) continue;

    try {
      const enricher = factory(entry);
      registry.register(enricher);
    } catch {
      // Skip duplicate or invalid enrichers
    }
  }

  return registry;
}

/**
 * Collect files from scan results that match registered enrichers.
 * Groups file paths by language ID for batch processing.
 */
function collectEnrichableFiles(
  scan: ScanResult,
  registry: EnricherRegistry
): Map<string, string[]> {
  const filesByLanguage = new Map<string, string[]>();
  const supportedExtensions = new Set(registry.getSupportedExtensions());

  // Collect all file paths from scan results
  const allFiles: string[] = [];

  for (const entry of scan.knowledge) {
    allFiles.push(entry.filePath);
  }

  // Group by enricher language ID
  for (const filePath of allFiles) {
    const ext = extname(filePath);
    if (!ext || !supportedExtensions.has(ext)) continue;

    const enricher = registry.getByExtension(ext);
    if (!enricher) continue;

    const existing = filesByLanguage.get(enricher.languageId);
    if (existing) {
      existing.push(filePath);
    } else {
      filesByLanguage.set(enricher.languageId, [filePath]);
    }
  }

  return filesByLanguage;
}

/**
 * Parse imports from scanned source files and aggregate into module-level dependencies.
 *
 * This runs independently of LSP enrichment — it only needs file content (already in memory).
 */
function parseDependencies(
  scan: ScanResult,
  rootPath: string,
  config: LuxLspConfig,
  report: (msg: string) => void
): AggregatedDependency[] {
  if (!config.deps?.enabled) {
    return [];
  }

  // Detect module boundaries
  const boundaryConfig = config.deps.moduleBoundary
    ? { patterns: [config.deps.moduleBoundary] }
    : undefined;
  const patterns = detectModuleBoundaries(rootPath, boundaryConfig);

  if (patterns.length === 0) {
    return [];
  }

  report(`Detected module boundaries: ${patterns.join(', ')}`);

  // Aggregate: (sourceModule, targetModule) → { count, sampleFiles }
  const depMap = new Map<string, { count: number; sampleFiles: Set<string> }>();

  const sourceEntries = scan.knowledge.filter((k) => k.type === 'source-code');
  let parsedCount = 0;

  for (const entry of sourceEntries) {
    if (!entry.content) continue;

    const lang = (entry.frontmatter as Record<string, unknown>)?.language as string | undefined;
    if (!lang) continue;

    const sourceModule = resolveModule(entry.filePath, rootPath, patterns);
    if (!sourceModule) continue;

    const imports = parseImports(entry.content, lang);
    if (imports.length === 0) continue;

    parsedCount++;

    for (const imp of imports) {
      // Try to resolve the import to a target module
      // For PHP: map namespace segments to file path heuristic
      // For TS/JS: resolve relative paths against source file
      const targetModule = resolveImportToModule(
        imp.rawImport,
        entry.filePath,
        rootPath,
        patterns,
        lang
      );
      if (!targetModule || targetModule === sourceModule) continue;

      const key = `${sourceModule}\0${targetModule}`;
      const existing = depMap.get(key);
      if (existing) {
        existing.count++;
        if (existing.sampleFiles.size < 5) {
          existing.sampleFiles.add(entry.filePath);
        }
      } else {
        depMap.set(key, { count: 1, sampleFiles: new Set([entry.filePath]) });
      }
    }
  }

  if (parsedCount > 0) {
    report(
      `Parsed imports from ${parsedCount} source files, found ${depMap.size} module dependencies`
    );
  }

  return Array.from(depMap.entries()).map(([key, val]) => {
    const [source_module, target_module] = key.split('\0');
    return {
      source_module,
      target_module,
      reference_count: val.count,
      sample_files: Array.from(val.sampleFiles),
    };
  });
}

/**
 * Attempt to resolve an import path to a target module name.
 *
 * For PHP: maps namespace segments (e.g. App\Module\Users\Service) to directory
 * patterns by matching namespace prefixes against module boundary patterns.
 *
 * For JS/TS: resolves relative paths against the source file's location and
 * then applies module boundary resolution.
 */
function resolveImportToModule(
  rawImport: string,
  sourceFilePath: string,
  rootPath: string,
  patterns: string[],
  language: string
): string | null {
  if (language === 'php') {
    return resolvePhpNamespaceToModule(rawImport, rootPath, patterns);
  }

  if (language === 'typescript' || language === 'javascript') {
    return resolveTsPathToModule(rawImport, sourceFilePath, rootPath, patterns);
  }

  return null;
}

/**
 * Map a PHP namespace to a module by trying multiple resolution strategies:
 * 1. Direct namespace-to-path mapping
 * 2. Extract module name from namespace segments that match pattern structure
 */
function resolvePhpNamespaceToModule(
  namespace: string,
  rootPath: string,
  patterns: string[]
): string | null {
  const segments = namespace.replace(/\\/g, '/').split('/');

  // Strategy 1: Direct path mapping
  const asPath = segments.join('/');
  const fakePath = join(rootPath, asPath + '.php');
  const direct = resolveModule(fakePath, rootPath, patterns);
  if (direct) return direct;

  // Strategy 2: For each pattern, try to match namespace segments
  // e.g. pattern "src/Module/{name}" has depth 2 before {name}
  // namespace "App\Module\Users\Service" — try matching from each offset
  for (const pattern of patterns) {
    const nameIndex = pattern.indexOf('{name}');
    if (nameIndex === -1) continue;

    const patternPrefix = pattern.slice(0, nameIndex);
    const patternParts = patternPrefix.split('/').filter((p) => p.length > 0);
    const patternDepth = patternParts.length;

    // Strategy 2a (namespace-prefix-aware): a module directory may sit under
    // a namespace prefix that is DEEPER than the filesystem pattern prefix.
    // e.g. files live at "src/Module/{Name}" (prefix depth 2) but the PHP
    // namespace is "acme\\Core\\Module\\{Name}\\..." (module name at
    // depth 3). Anchor on the last literal segment of the pattern prefix
    // (e.g. "Module") and take the namespace segment immediately after it,
    // wherever it occurs — instead of assuming a fixed segment index. The
    // constructed module directory is verified to actually exist, which
    // also filters out vendor namespaces (Illuminate\*, Spatie\*, Carbon\*)
    // that would otherwise resolve to phantom modules.
    const anchor = patternParts[patternParts.length - 1];
    if (anchor) {
      const anchorIndex = segments.lastIndexOf(anchor);
      if (anchorIndex !== -1 && anchorIndex + 1 < segments.length) {
        const moduleName = segments[anchorIndex + 1];
        if (existsSync(join(rootPath, patternPrefix, moduleName))) {
          const constructedPath = join(rootPath, patternPrefix, moduleName, 'dummy.php');
          const resolved = resolveModule(constructedPath, rootPath, patterns);
          if (resolved) return resolved;
        }
      }
    }

    // Strategy 2b (fixed-index fallback): original behaviour for repos whose
    // namespace depth matches the filesystem pattern depth. Also existence-
    // verified so non-module namespaces do not produce phantom modules.
    if (segments.length > patternDepth) {
      const moduleName = segments[patternDepth];
      if (existsSync(join(rootPath, patternPrefix, moduleName))) {
        // Verify this forms a valid path under the pattern
        const constructedPath = join(rootPath, patternPrefix, moduleName, 'dummy.php');
        const resolved = resolveModule(constructedPath, rootPath, patterns);
        if (resolved) return resolved;
      }
    }
  }

  return null;
}

/**
 * Resolve a relative TS/JS import path to a module by combining it with
 * the source file's directory and applying module boundary resolution.
 */
function resolveTsPathToModule(
  importPath: string,
  sourceFilePath: string,
  rootPath: string,
  patterns: string[]
): string | null {
  if (!importPath.startsWith('.')) {
    // Absolute or bare — try direct module resolution
    const fakePath = join(rootPath, importPath);
    return resolveModule(fakePath, rootPath, patterns);
  }

  // Resolve relative to source file
  const sourceDir = sourceFilePath.substring(0, sourceFilePath.lastIndexOf('/'));
  const resolved = join(sourceDir, importPath);
  return resolveModule(resolved, rootPath, patterns);
}

/**
 * Attach enrichment data to a scanned knowledge entry's frontmatter.
 * Merges the enrichment result into frontmatter.lsp for downstream
 * storage in the database metadata field.
 *
 * @param entry - The scanned knowledge entry to enrich.
 * @param enrichments - Map of file path to enrichment results.
 * @returns The entry with lsp data merged into frontmatter, or unchanged.
 */
export function attachEnrichment(
  entry: ScannedKnowledge,
  enrichments: EnrichmentMap
): ScannedKnowledge {
  const enrichment = enrichments.get(entry.filePath);
  if (!enrichment) return entry;

  const ext = enrichment as unknown as Record<string, unknown>;

  return {
    ...entry,
    frontmatter: {
      ...entry.frontmatter,
      lsp: {
        symbols: enrichment.symbols,
        diagnostics: enrichment.diagnostics,
        definitions: enrichment.definitions,
        references: ext['references'] as unknown[] | undefined,
        typeHierarchy: ext['typeHierarchy'] as unknown[] | undefined,
        enrichedAt: enrichment.enrichedAt,
        languageId: enrichment.languageId,
      },
    },
  };
}
