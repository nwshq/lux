import { readFileSync, statSync } from 'fs';
import { join, basename, extname } from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';
import type {
  Frontmatter,
  ScannedClient,
  ScannedProject,
  ScannedCommunication,
  ScannedKnowledge,
  ScanResult,
} from './types.js';
import type { LuxDatabase } from '../db/index.js';
import { loadLspConfig, type LuxLspConfig, type LspEnricherEntry } from './config.js';
import { EnricherRegistry, type EnrichmentResult } from './lsp/index.js';
import { PhpLspEnricher } from './lsp/php.js';

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
    const clients: ScannedClient[] = [];
    const projects: ScannedProject[] = [];
    const communications: ScannedCommunication[] = [];
    const knowledge: ScannedKnowledge[] = [];

    // Scan clients directory
    const clientsPath = join(scanPath, 'knowledge/10_clients');
    const clientDirs = await glob('*/', { cwd: clientsPath });

    for (const clientDir of clientDirs) {
      const clientSlug = clientDir.replace('/', '');
      const clientPath = join(clientsPath, clientDir);

      // Try multiple file options for client metadata
      let clientData: { frontmatter?: Frontmatter; content: string } = {
        frontmatter: undefined,
        content: '',
      };
      let filePath = '';

      // Priority order: README.md, AGENTS.md, CLAUDE.md, _meta directory
      const candidateFiles = [
        join(clientPath, 'README.md'),
        join(clientPath, 'AGENTS.md'),
        join(clientPath, 'CLAUDE.md'),
      ];

      for (const candidate of candidateFiles) {
        try {
          statSync(candidate);
          clientData = this.parseMarkdownFile(candidate);
          filePath = candidate;
          break;
        } catch {
          // Try next candidate
        }
      }

      // If no markdown file found, check if directory exists with subdirectories
      if (!filePath) {
        try {
          statSync(clientPath);
          filePath = clientPath; // Use directory as reference
        } catch {
          continue; // Skip if directory doesn't exist
        }
      }

      clients.push({
        slug: clientSlug,
        name: clientData.frontmatter?.name ?? this.slugToTitle(clientSlug),
        type: clientData.frontmatter?.type ? String(clientData.frontmatter.type) : undefined,
        status: clientData.frontmatter?.status ? String(clientData.frontmatter.status) : undefined,
        filePath: filePath,
        frontmatter: clientData.frontmatter,
        content: clientData.content,
      });

      // Scan projects within client
      const projectDirs = await glob('*/', { cwd: clientPath });
      for (const projectDir of projectDirs) {
        const projectSlug = projectDir.replace('/', '');

        // Skip special directories
        if (
          ['communications', '_meta', 'archive', 'implementation-payloads', 'hiring'].includes(
            projectSlug
          )
        ) {
          continue;
        }

        const projectPath = join(clientPath, projectDir);

        // Try multiple file options for project metadata
        let projectData: { frontmatter?: Frontmatter; content: string } = {
          frontmatter: undefined,
          content: '',
        };
        let projectFilePath = '';

        // Priority order: README.md, AGENTS.md, CLAUDE.md
        const projectCandidates = [
          join(projectPath, 'README.md'),
          join(projectPath, 'AGENTS.md'),
          join(projectPath, 'CLAUDE.md'),
        ];

        for (const candidate of projectCandidates) {
          try {
            statSync(candidate);
            projectData = this.parseMarkdownFile(candidate);
            projectFilePath = candidate;
            break;
          } catch {
            // Try next candidate
          }
        }

        // If no markdown file found, check if directory exists with subdirectories
        if (!projectFilePath) {
          try {
            statSync(projectPath);
            projectFilePath = projectPath; // Use directory as reference
          } catch {
            continue; // Skip if directory doesn't exist
          }
        }

        // Check for explorations/ and payloads/ subdirectories
        const explorationsPath = join(projectPath, 'explorations');
        const payloadsPath = join(projectPath, 'payloads');
        let hasExplorations = false;
        let hasPayloads = false;

        try {
          statSync(explorationsPath);
          hasExplorations = true;
        } catch {
          // No explorations directory
        }

        try {
          statSync(payloadsPath);
          hasPayloads = true;
        } catch {
          // No payloads directory
        }

        projects.push({
          clientSlug,
          slug: projectSlug,
          name: projectData.frontmatter?.name ?? this.slugToTitle(projectSlug),
          status: projectData.frontmatter?.status
            ? String(projectData.frontmatter.status)
            : undefined,
          filePath: projectFilePath,
          frontmatter: projectData.frontmatter,
          content: projectData.content,
          hasExplorations,
          hasPayloads,
        });

        // Scan project-scoped explorations
        if (hasExplorations) {
          const explorationFiles = await glob('*.md', { cwd: explorationsPath });
          for (const mdFile of explorationFiles) {
            const filePath = join(explorationsPath, mdFile);
            const fileData = this.parseMarkdownFile(filePath);

            knowledge.push({
              clientSlug,
              projectSlug,
              type: this.inferKnowledgeType('explorations', fileData.frontmatter),
              title: fileData.frontmatter?.title ?? this.extractTitleFromFilename(mdFile),
              filePath,
              tags: fileData.frontmatter?.tags,
              frontmatter: fileData.frontmatter,
              content: fileData.content,
            });
          }
        }

        // Scan project-scoped payloads
        if (hasPayloads) {
          const payloadFiles = await glob('**/*.md', { cwd: payloadsPath });
          for (const mdFile of payloadFiles) {
            const filePath = join(payloadsPath, mdFile);
            const fileData = this.parseMarkdownFile(filePath);

            knowledge.push({
              clientSlug,
              projectSlug,
              type: this.inferKnowledgeType('payloads', fileData.frontmatter),
              title: fileData.frontmatter?.title ?? this.extractTitleFromFilename(mdFile),
              filePath,
              tags: fileData.frontmatter?.tags,
              frontmatter: fileData.frontmatter,
              content: fileData.content,
            });
          }
        }
      }

      // Scan communications
      const commsPath = join(clientPath, 'communications');
      try {
        statSync(commsPath);
        const commFiles = await glob('*.md', { cwd: commsPath });

        for (const commFile of commFiles) {
          const commPath = join(commsPath, commFile);
          const commData = this.parseMarkdownFile(commPath);

          // Try to extract date from filename (YYYY-MM-DD_*.md)
          const dateMatch = commFile.match(/^(\d{4}-\d{2}-\d{2})/);
          const dateRange = dateMatch
            ? dateMatch[1]
            : commData.frontmatter?.date
              ? String(commData.frontmatter.date)
              : undefined;

          const subject =
            commData.frontmatter?.subject ??
            commData.frontmatter?.title ??
            this.extractTitleFromFilename(commFile);

          communications.push({
            clientSlug,
            type: commData.frontmatter?.type
              ? String(commData.frontmatter.type)
              : this.inferCommType(commFile),
            subject,
            dateRange,
            participants: commData.frontmatter?.participants,
            filePath: commPath,
            frontmatter: commData.frontmatter,
            content: commData.content,
          });
        }
      } catch {
        // No communications directory
      }
    }

    // Scan other knowledge directories
    const knowledgeDirs = [
      'knowledge/20_methodology',
      'knowledge/30_specs',
      'knowledge/40_architecture',
      'explorations',
      'implementation-payloads',
    ];

    for (const dir of knowledgeDirs) {
      const dirPath = join(scanPath, dir);
      try {
        statSync(dirPath);
        const mdFiles = await glob('**/*.md', { cwd: dirPath });

        for (const mdFile of mdFiles) {
          const filePath = join(dirPath, mdFile);
          const fileData = this.parseMarkdownFile(filePath);

          knowledge.push({
            type: this.inferKnowledgeType(dir, fileData.frontmatter),
            title: fileData.frontmatter?.title ?? this.extractTitleFromFilename(mdFile),
            filePath,
            tags: fileData.frontmatter?.tags,
            frontmatter: fileData.frontmatter,
            content: fileData.content,
          });
        }
      } catch {
        // Directory doesn't exist
      }
    }

    return { clients, projects, communications, knowledge };
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

  private inferCommType(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.includes('email')) return 'email';
    if (lower.includes('slack')) return 'slack';
    if (lower.includes('meeting')) return 'meeting';
    if (lower.includes('call')) return 'call';
    return 'other';
  }

  private inferKnowledgeType(dirPath: string, frontmatter?: Frontmatter): string {
    if (frontmatter?.type) return String(frontmatter.type);

    if (dirPath.includes('methodology')) return 'methodology';
    if (dirPath.includes('specs')) return 'spec';
    if (dirPath.includes('architecture')) return 'architecture';
    if (dirPath.includes('explorations')) return 'exploration';
    if (dirPath.includes('implementation-payloads')) return 'implementation-payload';
    if (dirPath.includes('payloads')) return 'payload';

    return 'general';
  }

  /**
   * Index scanned entities into the database.
   * This method takes the result of scan() and writes all entities to SQLite.
   *
   * @param db - The LuxDatabase instance to write to
   * @param scanResult - The result from scan() containing all entities
   * @returns Summary of indexed entities with counts and IDs
   */
  index(
    db: LuxDatabase,
    scanResult: ScanResult
  ): Promise<{
    clients: number;
    projects: number;
    communications: number;
    knowledge: number;
  }> {
    // Validate inputs
    if (!db) {
      return Promise.reject(new Error('Database instance is required for indexing'));
    }
    if (!scanResult || typeof scanResult !== 'object') {
      return Promise.reject(new Error('Invalid scan result: must be an object'));
    }
    if (!Array.isArray(scanResult.clients)) {
      return Promise.reject(new Error('Invalid scan result: clients must be an array'));
    }
    if (!Array.isArray(scanResult.projects)) {
      return Promise.reject(new Error('Invalid scan result: projects must be an array'));
    }
    if (!Array.isArray(scanResult.communications)) {
      return Promise.reject(new Error('Invalid scan result: communications must be an array'));
    }
    if (!Array.isArray(scanResult.knowledge)) {
      return Promise.reject(new Error('Invalid scan result: knowledge must be an array'));
    }

    const clientIdMap = new Map<string, number>();
    const projectIdMap = new Map<string, number>();
    let indexedCounts = { clients: 0, projects: 0, communications: 0, knowledge: 0 };

    try {
      // 1. Index clients first (no dependencies)
      for (const client of scanResult.clients) {
        // Validate client data
        if (!client.slug || typeof client.slug !== 'string') {
          throw new Error(`Invalid client: missing or invalid slug (file: ${client.filePath})`);
        }
        if (!client.name || typeof client.name !== 'string') {
          throw new Error(`Invalid client: missing or invalid name (slug: ${client.slug})`);
        }

        try {
          const clientId = db.insertClient({
            slug: client.slug,
            name: client.name,
            type: client.type,
            status: client.status,
            file_path: client.filePath,
            metadata: client.frontmatter,
            content: client.content,
          });
          clientIdMap.set(client.slug, clientId);
          indexedCounts.clients++;
        } catch (error) {
          throw new Error(
            `Failed to insert client "${client.slug}" (${client.filePath}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // 2. Index projects (depends on clients)
      for (const project of scanResult.projects) {
        // Validate project data
        if (!project.slug || typeof project.slug !== 'string') {
          throw new Error(`Invalid project: missing or invalid slug (file: ${project.filePath})`);
        }
        if (!project.clientSlug || typeof project.clientSlug !== 'string') {
          throw new Error(`Invalid project: missing or invalid clientSlug (slug: ${project.slug})`);
        }

        const clientId = clientIdMap.get(project.clientSlug);
        if (!clientId) {
          throw new Error(
            `Client "${project.clientSlug}" not found for project "${project.slug}" (${project.filePath}). ` +
              `Ensure the client directory exists and was scanned.`
          );
        }

        try {
          const projectId = db.insertProject({
            client_id: clientId,
            slug: project.slug,
            name: project.name,
            status: project.status,
            file_path: project.filePath,
            metadata: project.frontmatter,
            content: project.content,
          });

          // Store project ID with composite key
          const projectKey = `${project.clientSlug}/${project.slug}`;
          projectIdMap.set(projectKey, projectId);
          indexedCounts.projects++;
        } catch (error) {
          throw new Error(
            `Failed to insert project "${project.slug}" for client "${project.clientSlug}" (${project.filePath}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // 3. Index communications (depends on clients, optionally projects)
      for (const comm of scanResult.communications) {
        // Validate communication data
        if (!comm.clientSlug || typeof comm.clientSlug !== 'string') {
          throw new Error(
            `Invalid communication: missing or invalid clientSlug (file: ${comm.filePath})`
          );
        }
        if (!comm.type || typeof comm.type !== 'string') {
          throw new Error(
            `Invalid communication: missing or invalid type (file: ${comm.filePath})`
          );
        }

        const clientId = clientIdMap.get(comm.clientSlug);
        if (!clientId) {
          throw new Error(
            `Client "${comm.clientSlug}" not found for communication "${comm.subject ?? 'Untitled'}" (${comm.filePath}). ` +
              `Ensure the client directory exists and was scanned.`
          );
        }

        let projectId: number | undefined;
        if (comm.projectSlug) {
          const projectKey = `${comm.clientSlug}/${comm.projectSlug}`;
          projectId = projectIdMap.get(projectKey);
          // Note: projectId being undefined is acceptable for client-level communications
        }

        try {
          db.insertCommunication({
            client_id: clientId,
            project_id: projectId,
            type: comm.type,
            subject: comm.subject,
            date_range: comm.dateRange,
            participants: comm.participants,
            file_path: comm.filePath,
            metadata: comm.frontmatter,
            content: comm.content,
          });
          indexedCounts.communications++;
        } catch (error) {
          throw new Error(
            `Failed to insert communication "${comm.subject ?? 'Untitled'}" (${comm.filePath}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // 4. Index knowledge entries (optionally depends on clients/projects)
      for (const knowledge of scanResult.knowledge) {
        // Validate knowledge data
        if (!knowledge.type || typeof knowledge.type !== 'string') {
          throw new Error(
            `Invalid knowledge entry: missing or invalid type (file: ${knowledge.filePath})`
          );
        }
        if (!knowledge.title || typeof knowledge.title !== 'string') {
          throw new Error(
            `Invalid knowledge entry: missing or invalid title (file: ${knowledge.filePath})`
          );
        }

        let clientId: number | undefined;
        let projectId: number | undefined;

        if (knowledge.clientSlug) {
          clientId = clientIdMap.get(knowledge.clientSlug);
          // Note: clientId being undefined is acceptable for global knowledge
        }

        if (knowledge.projectSlug && knowledge.clientSlug) {
          const projectKey = `${knowledge.clientSlug}/${knowledge.projectSlug}`;
          projectId = projectIdMap.get(projectKey);
          // Note: projectId being undefined is acceptable
        }

        try {
          db.insertKnowledgeEntry({
            client_id: clientId,
            project_id: projectId,
            type: knowledge.type,
            title: knowledge.title,
            file_path: knowledge.filePath,
            tags: knowledge.tags,
            metadata: knowledge.frontmatter,
            content: knowledge.content,
          });
          indexedCounts.knowledge++;
        } catch (error) {
          throw new Error(
            `Failed to insert knowledge entry "${knowledge.title}" (${knowledge.filePath}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      return Promise.resolve(indexedCounts);
    } catch (error) {
      // Add context about what was successfully indexed before the error
      const partialMsg = `Partial index created: ${indexedCounts.clients} clients, ${indexedCounts.projects} projects, ${indexedCounts.communications} communications, ${indexedCounts.knowledge} knowledge entries. `;
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
      `Warning: enricher shutdown errors: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  report(
    `Enrichment complete: ${enrichments.size} files enriched, ${errors.length} errors.`
  );

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
export function buildRegistry(entries: LspEnricherEntry[]): EnricherRegistry {
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
export function collectEnrichableFiles(
  scan: ScanResult,
  registry: EnricherRegistry
): Map<string, string[]> {
  const filesByLanguage = new Map<string, string[]>();
  const supportedExtensions = new Set(registry.getSupportedExtensions());

  // Collect all file paths from scan results
  const allFiles: string[] = [];

  for (const client of scan.clients) {
    allFiles.push(client.filePath);
  }
  for (const project of scan.projects) {
    allFiles.push(project.filePath);
  }
  for (const comm of scan.communications) {
    allFiles.push(comm.filePath);
  }
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
