import { readFileSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';
import type { Frontmatter, ScannedKnowledge, ScanResult } from './types.js';
import type { LuxDatabase } from '../db/index.js';
import { loadLspConfig, type LuxLspConfig, type LspEnricherEntry } from './config.js';
import { EnricherRegistry, type EnrichmentResult } from './lsp/index.js';
import { PhpLspEnricher } from './lsp/php.js';

// ---------------------------------------------------------------------------
// Source Code Scanning Constants
// ---------------------------------------------------------------------------

/** File extensions to scan as source code, grouped by language. */
const SOURCE_CODE_EXTENSIONS: string[] = [
  '.php',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py',
  '.go',
  '.rb',
  '.rs',
  '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp',
  '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml',
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
const SOURCE_CODE_IGNORE_PATTERNS: string[] = [
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
        title: fileData.frontmatter?.title ?? fileData.frontmatter?.name ?? this.extractTitleFromFilename(mdFile),
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
    return SOURCE_CODE_MANIFEST_FILES.some((manifest) =>
      existsSync(join(rootPath, manifest))
    );
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

/** Enrichment results indexed by file path. */
export type EnrichmentMap = Map<string, EnrichmentResult>;

/** Result of a full scan+enrich pipeline run. */
export interface GeneralScanResult {
  /** The base scan result from GeneralScanner. */
  scan: ScanResult;
  /** LSP enrichment results keyed by file path. */
  enrichments: EnrichmentMap;
  /** Summary statistics. */
  stats: {
    /** Number of files that were enriched. */
    enrichedFiles: number;
    /** Number of enrichers that were initialized. */
    activeEnrichers: number;
    /** Errors encountered during enrichment (non-fatal). */
    enrichmentErrors: Array<{ filePath: string; error: string }>;
  };
}

/** Options for the general scan pipeline. */
export interface GeneralScanOptions {
  /** Override LSP config instead of loading from lux.yaml. */
  config?: LuxLspConfig;
  /** Callback for progress reporting. */
  onProgress?: (message: string) => void;
  /** Callback for enrichment errors. */
  onEnrichmentError?: (filePath: string, error: Error) => void;
}

/** Map of language IDs to factory functions for built-in enrichers. */
const ENRICHER_FACTORIES: Record<
  string,
  (entry: LspEnricherEntry) => InstanceType<typeof PhpLspEnricher>
> = {
  php: (entry) =>
    new PhpLspEnricher({
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

  // 2. If LSP is disabled, return scan-only result
  if (!config.lsp.enabled) {
    return {
      scan,
      enrichments: new Map(),
      stats: { enrichedFiles: 0, activeEnrichers: 0, enrichmentErrors: [] },
    };
  }

  // 3. Build enricher registry from config
  report('Initializing LSP enrichers...');
  const registry = buildRegistry(config.lsp.enrichers);

  if (registry.size === 0) {
    report('No LSP enrichers configured.');
    return {
      scan,
      enrichments: new Map(),
      stats: { enrichedFiles: 0, activeEnrichers: 0, enrichmentErrors: [] },
    };
  }

  // 4. Initialize enrichers
  const workspaceRoot = config.lsp.workspaceRoot ?? rootPath;
  let activeCount = 0;

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
  const enrichments: EnrichmentMap = new Map();
  const errors: Array<{ filePath: string; error: string }> = [];

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
        options?.onEnrichmentError?.(filePath, error instanceof Error ? error : new Error(message));
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

  report(`Enrichment complete: ${enrichments.size} files enriched, ${errors.length} errors.`);

  return {
    scan,
    enrichments,
    stats: {
      enrichedFiles: enrichments.size,
      activeEnrichers: activeCount,
      enrichmentErrors: errors,
    },
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

  return {
    ...entry,
    frontmatter: {
      ...entry.frontmatter,
      lsp: {
        symbols: enrichment.symbols,
        diagnostics: enrichment.diagnostics,
        definitions: enrichment.definitions,
        enrichedAt: enrichment.enrichedAt,
        languageId: enrichment.languageId,
      },
    },
  };
}
