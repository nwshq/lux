// Stage 2 enrichment for expert discovery.
//
// Aggregates FTS5 file counts by directory and extracts LSP symbol/cross-reference
// data from indexed knowledge entries. Produces structured enrichment data that
// Stage 3 (AI analysis) uses to propose expert boundaries.

import { dirname, isAbsolute, relative, resolve } from 'path';
import type { LuxDatabase } from '../db/index.js';
import type { KnowledgeEntry, ModuleDependency } from '../db/types.js';
import type {
  DiscoveryContext,
  DiscoveryOptions,
  CrossReference,
  EnrichContextFn,
} from './types.js';
import { computeClusters } from '../db/clustering.js';
import {
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
} from '../scanner/overlay-trust-state.js'; // @architecture-ignore intentional shared overlay substrate
import { extractOverlayNeighborhoods } from '../experts/structural-analysis.js'; // @architecture-ignore intentional shared overlay substrate

// ---------------------------------------------------------------------------
// Types (internal)
// ---------------------------------------------------------------------------

/** Shape of LSP data nested inside knowledge entry metadata JSON. */
interface LspMetadata {
  symbols?: LspSymbol[];
  definitions?: LspDefinition[];
}

interface LspSymbol {
  name: string;
  kind: number;
  kindLabel?: string;
  children?: LspSymbol[];
}

interface LspDefinition {
  symbolName: string;
  targetUri: string;
  targetStartLine?: number;
}

/** LSP SymbolKind values for high-value symbols (classes, interfaces, enums, structs, functions). */
const HIGH_VALUE_KINDS = new Set([
  5, // Class
  10, // Enum
  11, // Interface
  12, // Function
  23, // Struct
]);

/** Maximum number of symbols to include per directory summary. */
const MAX_SYMBOLS_PER_DIR = 15;

// ---------------------------------------------------------------------------
// Public API — EnrichContextFn implementation
// ---------------------------------------------------------------------------

/**
 * Stage 2: Enrich context with database signals (EnrichContextFn implementation).
 *
 * Takes the tree string from Stage 1, queries the database for indexed
 * file paths, and aggregates counts into `fileCountsByDirectory` keyed
 * by directory prefix (relative to contentRoot). Also extracts LSP symbol
 * summaries and cross-references when available, and includes existing
 * experts to prevent duplicates in AI proposals.
 */
export const enrichContext: EnrichContextFn = (
  tree: string,
  db: LuxDatabase,
  options: DiscoveryOptions
): DiscoveryContext => {
  const contentRoot = options.rootPath;
  const allEntries = db.getAllKnowledgeEntries();
  const entries = allEntries.filter((entry) => isPathWithinRoot(entry.file_path, contentRoot));
  const dbAppearsScopedToRoot = allEntries.length === entries.length;

  const existingExperts = db
    .getAllExperts()
    .filter((expert) => isPathWithinRoot(expert.mount_path, contentRoot))
    .map((e) => {
      const parsed = parseExpertStructuralFields(e.boundary_basis, e.structural_signature);
      return {
        slug: e.slug,
        mountPath: e.mount_path,
        ...(parsed.boundaryBasis && { boundaryBasis: parsed.boundaryBasis }),
        ...(parsed.structuralSignature && { structuralSignature: parsed.structuralSignature }),
      };
    });

  const symbolSummaries = extractSymbolSummaries(entries, contentRoot);
  const crossReferences = extractCrossReferences(entries, contentRoot);

  // Add module dependency data if available
  let moduleCoupling;
  let clusters;
  try {
    const allDeps = db.getAllModuleDependencies();
    const scopedDeps = allDeps.filter((dep) => {
      const touchesRoot = moduleDependencyTouchesRoot(dep, contentRoot);
      return touchesRoot === true || (touchesRoot === null && dbAppearsScopedToRoot);
    });
    if (scopedDeps.length > 0) {
      moduleCoupling = scopedDeps;
      clusters = computeClusters(scopedDeps);
    }
  } catch {
    // Module dependencies not available — skip
  }

  // Add overlay-native structural evidence when available
  const overlayInspection = inspectOverlayTrustState(db);
  const overlayState = overlayInspection.state;
  const persistedRepoPath = overlayState?.repoPath;
  const overlayStateSafe =
    overlayInspection.source === 'persisted'
      ? persistedRepoPath !== undefined && sameResolvedPath(persistedRepoPath, contentRoot)
      : dbAppearsScopedToRoot;
  const overlayTrustState =
    overlayStateSafe && overlayState ? deriveOverlayTrustLevelFromState(overlayState) : undefined;
  const overlayNeighborhoods =
    overlayTrustState !== 'no-overlay' && overlayTrustState !== 'content-only'
      ? extractOverlayNeighborhoods(db).filter((nbhd) => neighborhoodTouchesRoot(nbhd, contentRoot))
      : undefined;

  return {
    tree,
    fileCountsByDirectory: aggregateFileCountsByDirectory(entries, contentRoot),
    ...(Object.keys(symbolSummaries).length > 0 && { symbolSummaries }),
    ...(crossReferences.length > 0 && { crossReferences }),
    existingExperts,
    ...(moduleCoupling && moduleCoupling.length > 0 && { moduleCoupling }),
    ...(clusters && clusters.length > 0 && { clusters }),
    ...(overlayTrustState !== undefined && { overlayTrustState }),
    ...(overlayNeighborhoods && overlayNeighborhoods.length > 0 && { overlayNeighborhoods }),
  };
};

// ---------------------------------------------------------------------------
// FTS5 file count aggregation
// ---------------------------------------------------------------------------

/**
 * Count indexed files per directory.
 *
 * Groups knowledge entries by their parent directory (relative to contentRoot)
 * and returns a map of directory path → file count.
 */
export function aggregateFileCountsByDirectory(
  entries: KnowledgeEntry[],
  contentRoot: string
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const entry of entries) {
    const dir = toRelativeDir(entry.file_path, contentRoot);
    counts[dir] = (counts[dir] ?? 0) + 1;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// LSP symbol extraction
// ---------------------------------------------------------------------------

/**
 * Extract top symbol names per directory from LSP-enriched knowledge entries.
 *
 * Parses the `metadata` JSON from each entry, looks for `lsp.symbols`,
 * and collects symbol names. High-value symbols (classes, interfaces,
 * functions, enums) are prioritized over methods and properties.
 */
export function extractSymbolSummaries(
  entries: KnowledgeEntry[],
  contentRoot: string
): Record<string, string[]> {
  const dirSymbols = new Map<string, Map<string, number>>();

  for (const entry of entries) {
    const lsp = parseLspMetadata(entry.metadata);
    if (!lsp?.symbols || lsp.symbols.length === 0) continue;

    const dir = toRelativeDir(entry.file_path, contentRoot);
    if (!dirSymbols.has(dir)) {
      dirSymbols.set(dir, new Map());
    }
    const symbolMap = dirSymbols.get(dir)!;

    collectSymbolNames(lsp.symbols, symbolMap);
  }

  const result: Record<string, string[]> = {};

  for (const [dir, symbolMap] of dirSymbols) {
    // Sort: high-value kinds first (priority 1), then others (priority 2), then alphabetical
    const sorted = Array.from(symbolMap.entries())
      .sort((a, b) => {
        if (a[1] !== b[1]) return a[1] - b[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, MAX_SYMBOLS_PER_DIR)
      .map(([name]) => name);

    if (sorted.length > 0) {
      result[dir] = sorted;
    }
  }

  return result;
}

/**
 * Recursively collect symbol names from an LSP symbol tree.
 * Assigns priority: high-value kinds (class, interface, function, enum) = 1, others = 2.
 */
function collectSymbolNames(symbols: LspSymbol[], symbolMap: Map<string, number>): void {
  for (const symbol of symbols) {
    const priority = HIGH_VALUE_KINDS.has(symbol.kind) ? 1 : 2;
    const existing = symbolMap.get(symbol.name);
    if (existing === undefined || priority < existing) {
      symbolMap.set(symbol.name, priority);
    }

    if (symbol.children) {
      collectSymbolNames(symbol.children, symbolMap);
    }
  }
}

// ---------------------------------------------------------------------------
// LSP cross-reference extraction
// ---------------------------------------------------------------------------

/**
 * Extract cross-directory references from LSP definition data.
 *
 * For each knowledge entry with LSP definitions, maps the source file's
 * directory to each definition target's directory. Self-references (same
 * directory) are excluded. Results are aggregated by (sourceDir, targetDir)
 * pair and sorted by reference count descending.
 */
export function extractCrossReferences(
  entries: KnowledgeEntry[],
  contentRoot: string
): CrossReference[] {
  const refCounts = new Map<string, number>();

  for (const entry of entries) {
    const lsp = parseLspMetadata(entry.metadata);
    if (!lsp?.definitions || lsp.definitions.length === 0) continue;

    const sourceDir = toRelativeDir(entry.file_path, contentRoot);

    for (const def of lsp.definitions) {
      const targetPath = uriToPath(def.targetUri);
      if (!targetPath) continue;

      const targetDir = toRelativeDir(targetPath, contentRoot);

      // Skip self-references within the same directory
      if (targetDir === sourceDir) continue;

      const key = `${sourceDir}\0${targetDir}`;
      refCounts.set(key, (refCounts.get(key) ?? 0) + 1);
    }
  }

  return Array.from(refCounts.entries())
    .map(([key, count]) => {
      const [sourceDir, targetDir] = key.split('\0');
      return { sourceDir, targetDir, referenceCount: count };
    })
    .sort((a, b) => b.referenceCount - a.referenceCount);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the parent directory of a file path, relative to the content root.
 * Returns '.' for files at the content root level.
 */
function toRelativeDir(filePath: string, contentRoot: string): string {
  const rel = relative(resolve(contentRoot), dirname(resolveAgainstRoot(filePath, contentRoot)));
  return rel || '.';
}

function resolveAgainstRoot(targetPath: string, contentRoot: string): string {
  return resolve(isAbsolute(targetPath) ? targetPath : resolve(contentRoot, targetPath));
}

function sameResolvedPath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function isPathWithinRoot(targetPath: string, contentRoot: string): boolean {
  const rel = relative(resolve(contentRoot), resolveAgainstRoot(targetPath, contentRoot));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function moduleDependencyTouchesRoot(dep: ModuleDependency, contentRoot: string): boolean | null {
  if (!dep.sample_files) return null;

  try {
    const sampleFiles = JSON.parse(dep.sample_files) as unknown;
    if (!Array.isArray(sampleFiles)) return false;
    return sampleFiles.some(
      (file) => typeof file === 'string' && isPathWithinRoot(file, contentRoot)
    );
  } catch {
    return false;
  }
}

function neighborhoodTouchesRoot(
  neighborhood: import('../experts/structural-analysis.js').OverlayNeighborhood,
  contentRoot: string
): boolean {
  return [
    ...neighborhood.anchorFiles,
    ...neighborhood.memberFiles,
    ...neighborhood.dominantDirectories,
  ].some((path) => isPathWithinRoot(path, contentRoot));
}

/**
 * Convert a file:// URI or plain absolute path to a file system path.
 * Returns null if the input cannot be converted.
 */
function uriToPath(uri: string): string | null {
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(uri.slice(7));
    } catch {
      return null;
    }
  }

  if (uri.startsWith('/')) {
    return uri;
  }

  return null;
}

/**
 * Parse LSP metadata from a knowledge entry's metadata JSON string.
 * Returns the `lsp` sub-object, or null if not present or unparseable.
 */
function parseLspMetadata(metadataJson: string | undefined): LspMetadata | null {
  if (!metadataJson) return null;

  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    const lsp = metadata.lsp as LspMetadata | undefined;
    return lsp ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse optional structural fields from persisted expert DB columns.
 * Returns empty fields for legacy experts that predate structural metadata.
 */
function parseExpertStructuralFields(
  boundaryBasisRaw: string | undefined,
  structuralSignatureRaw: string | undefined
): {
  boundaryBasis?: 'directory-led' | 'overlay-led' | 'hybrid';
  structuralSignature?: import('./types.js').ExpertStructuralSignature;
} {
  const validBases = new Set(['directory-led', 'overlay-led', 'hybrid']);
  const boundaryBasis =
    boundaryBasisRaw && validBases.has(boundaryBasisRaw)
      ? (boundaryBasisRaw as 'directory-led' | 'overlay-led' | 'hybrid')
      : undefined;

  let structuralSignature: import('./types.js').ExpertStructuralSignature | undefined;
  if (structuralSignatureRaw) {
    try {
      structuralSignature = JSON.parse(
        structuralSignatureRaw
      ) as import('./types.js').ExpertStructuralSignature;
    } catch {
      // Corrupted signature — treat as absent
    }
  }

  return { boundaryBasis, structuralSignature };
}
