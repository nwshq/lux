// Shared overlay rebuild orchestration contract.
//
// This module is the single trusted path for capability-surface validation.
// All CLI entry points and validation scripts should call these functions
// rather than encoding their own rebuild semantics.
//
// Two paths are provided:
//   rebuildWithOverlay()  — full overlay-complete rebuild with trust signals
//   rebuildContentOnly()  — lightweight content-index rebuild, explicitly not
//                           suitable for capability-surface validation

import { existsSync } from 'fs';
import { join } from 'path';
import type { LuxDatabase } from '../db/index.js';
import { generalScan } from './general.js';
import type { GeneralScanResult } from './general.js';
import type { OverlayRebuildResult } from './associations/overlay-service.js';
import { loadLspConfig } from './config.js';
import { lookupPack } from './pack/cache.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Completeness classification for a rebuild run. */
export type RebuildMode = 'overlay-complete' | 'content-only' | 'degraded-overlay';

/**
 * Structured result contract for a rebuild.
 *
 * Both CLI renderers and scripts should consume this type to determine
 * whether the run is trustworthy for capability-surface validation.
 */
export interface RebuildResult {
  /** Completeness classification. */
  mode: RebuildMode;
  /** Absolute path to the scanned repo. */
  repoPath: string;
  /** Where configuration was loaded from. */
  configSource: string;
  /** Whether repo config had LSP enabled. */
  configLspEnabled: boolean;
  /** Number of capability-surface nodes detected. */
  surfaceCount: number;
  /** Edges written by the capability-surface detector pass. */
  detectorEdgeCount: number;
  /** Edges added during symbolic propagation. */
  propagatedEdgeCount: number;
  /** File structural nodes materialized. */
  fileNodeCount: number;
  /** Symbol structural nodes materialized from LSP enrichment. */
  symbolNodeCount: number;
  /** Surfaces whose declaration form is controller-backed. */
  controllerBackedCount: number;
  /** Surfaces whose declaration form is closure-backed. */
  closureBackedCount: number;
  /** Surfaces with no recognizable declaration form. */
  unknownProviderKindCount: number;
  /** Whether LSP enrichers ran and produced symbol data. */
  enrichmentStatus: 'active' | 'inactive';
  /** Whether symbolic propagation ran and added edges. */
  propagationStatus: 'ran' | 'skipped' | 'empty';
  /** Trust-relevant warnings. Non-empty when mode is degraded-overlay. */
  warnings: string[];
}

/** Options for orchestrated rebuild functions. */
export interface RebuildOptions {
  /** Progress callback. */
  onProgress?: (message: string) => void;
  /** Include heuristic edges in the overlay (default: false). */
  includeHeuristics?: boolean;
  /**
   * Override the vendor-pack merge (ADR-1/ADR-2). `undefined` ⇒ auto-resolve a
   * cached pack for the project's `composer.lock` (merge iff one exists); an
   * explicit path forces that pack; `null` forces an app-only rebuild (no merge).
   */
  vendorPackPath?: string | null;
}

/**
 * Resolve the cached vendor pack for a project's current `composer.lock`, or null
 * when there is no Composer project or no matching cached pack. Keyed by the
 * lockfile hash, so a dependency bump misses the cache (no stale merge).
 */
function resolveVendorPackPath(rootPath: string): string | null {
  try {
    if (!existsSync(join(rootPath, 'composer.lock'))) return null;
    const lookup = lookupPack(rootPath);
    return lookup.hit ? lookup.packPath : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an overlay-complete rebuild and return structured trust metadata.
 *
 * This is the canonical path for capability-surface validation. Calls
 * generalScan() with overlayEnabled=true and classifies the resulting
 * overlay state into a RebuildResult with explicit completeness signals.
 *
 * @param db - Initialized database to write overlay state into.
 * @param rootPath - Absolute repository root.
 * @param options - Rebuild options.
 */
export async function rebuildWithOverlay(
  db: LuxDatabase,
  rootPath: string,
  options: RebuildOptions = {}
): Promise<{ result: RebuildResult; scanResult: GeneralScanResult }> {
  const config = loadLspConfig(rootPath);
  options.onProgress?.('Clearing existing content index and structural overlay...');
  db.clearRebuildTrustState();
  db.clearOverlay();
  db.clearKnowledgeIndex();

  // ADR-1/ADR-2: locate the cached pack for this dependency set (null ⇒ app-only).
  // An explicit option (incl. null) overrides auto-resolution.
  const vendorPackPath =
    options.vendorPackPath !== undefined ? options.vendorPackPath : resolveVendorPackPath(rootPath);

  const scanResult = await generalScan(rootPath, {
    config,
    onProgress: options.onProgress,
    overlayEnabled: true,
    db,
    vendorPackPath,
  });

  const result = classifyResult(rootPath, scanResult, db, 'overlay', config.lsp.enabled);
  return { result, scanResult };
}

/**
 * Run a content-only rebuild (no overlay).
 *
 * Returns a RebuildResult explicitly classified as content-only. This path
 * must NOT be used for capability-surface validation — use rebuildWithOverlay()
 * for that purpose.
 *
 * @param rootPath - Absolute repository root.
 * @param options - Rebuild options.
 */
export async function rebuildContentOnly(
  rootPath: string,
  options: RebuildOptions & { db?: LuxDatabase } = {}
): Promise<{ result: RebuildResult; scanResult: GeneralScanResult }> {
  const config = loadLspConfig(rootPath);
  if (options.db) {
    options.onProgress?.('Clearing existing content index and structural overlay...');
    options.db.clearRebuildTrustState();
    options.db.clearOverlay();
    options.db.clearKnowledgeIndex();
  }

  const scanResult = await generalScan(rootPath, {
    config,
    onProgress: options.onProgress,
  });

  const result = classifyResult(rootPath, scanResult, null, 'content', config.lsp.enabled);
  return { result, scanResult };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Derive a RebuildResult from a completed generalScan output.
 * Determines completeness state and collects trust-relevant warnings.
 */
function classifyResult(
  rootPath: string,
  scanResult: GeneralScanResult,
  db: LuxDatabase | null,
  intent: 'overlay' | 'content',
  configLspEnabled: boolean
): RebuildResult {
  if (intent === 'content') {
    return {
      mode: 'content-only',
      repoPath: rootPath,
      configSource: 'lux.yaml',
      configLspEnabled,
      surfaceCount: 0,
      detectorEdgeCount: 0,
      propagatedEdgeCount: 0,
      fileNodeCount: 0,
      symbolNodeCount: 0,
      controllerBackedCount: 0,
      closureBackedCount: 0,
      unknownProviderKindCount: 0,
      enrichmentStatus: scanResult.stats.activeEnrichers > 0 ? 'active' : 'inactive',
      propagationStatus: 'skipped',
      warnings: [],
    };
  }

  const overlay = scanResult.overlay;

  if (!overlay) {
    return {
      mode: 'degraded-overlay',
      repoPath: rootPath,
      configSource: 'lux.yaml',
      configLspEnabled,
      surfaceCount: 0,
      detectorEdgeCount: 0,
      propagatedEdgeCount: 0,
      fileNodeCount: 0,
      symbolNodeCount: 0,
      controllerBackedCount: 0,
      closureBackedCount: 0,
      unknownProviderKindCount: 0,
      enrichmentStatus: scanResult.stats.activeEnrichers > 0 ? 'active' : 'inactive',
      propagationStatus: 'skipped',
      warnings: ['Overlay rebuild did not produce a result — structural overlay state is absent.'],
    };
  }

  const warnings = collectWarnings(overlay, scanResult.stats.activeEnrichers);
  const mode: RebuildMode = warnings.length > 0 ? 'degraded-overlay' : 'overlay-complete';

  const { controllerBackedCount, closureBackedCount, unknownProviderKindCount } =
    countProviderKinds(db);

  const propagationStatus: 'ran' | 'skipped' | 'empty' =
    overlay.propagationEdgesAdded > 0 ? 'ran' : overlay.surfacesDetected > 0 ? 'empty' : 'skipped';

  return {
    mode,
    repoPath: rootPath,
    configSource: 'lux.yaml',
    configLspEnabled,
    surfaceCount: overlay.surfacesDetected,
    detectorEdgeCount: overlay.surfaceEdgesStored,
    propagatedEdgeCount: overlay.propagationEdgesAdded,
    fileNodeCount: overlay.fileNodes,
    symbolNodeCount: overlay.symbolNodes,
    controllerBackedCount,
    closureBackedCount,
    unknownProviderKindCount,
    enrichmentStatus: scanResult.stats.activeEnrichers > 0 ? 'active' : 'inactive',
    propagationStatus,
    warnings,
  };
}

/** Collect trust-relevant warnings from an overlay rebuild result. */
function collectWarnings(overlay: OverlayRebuildResult, activeEnrichers: number): string[] {
  const warnings: string[] = [];

  if (overlay.symbolNodes === 0) {
    warnings.push(
      'No symbol nodes were materialized — provider propagation trust is reduced. ' +
        (activeEnrichers === 0
          ? 'No LSP enrichers were active or configured for this repo.'
          : 'LSP enrichers ran but produced no symbols.')
    );
  }

  if (overlay.propagationEdgesAdded === 0 && overlay.surfacesDetected > 0) {
    warnings.push(
      `${overlay.surfacesDetected} surface(s) detected but propagation produced no provider edges.`
    );
  }

  return warnings;
}

/** Count provider-kind classifications across all capability-surface nodes in the DB. */
function countProviderKinds(db: LuxDatabase | null): {
  controllerBackedCount: number;
  closureBackedCount: number;
  unknownProviderKindCount: number;
} {
  if (!db) {
    return { controllerBackedCount: 0, closureBackedCount: 0, unknownProviderKindCount: 0 };
  }

  let controllerBackedCount = 0;
  let closureBackedCount = 0;
  let unknownProviderKindCount = 0;

  for (const surface of db.getCapabilitySurfaces()) {
    if (surface.metadata) {
      try {
        const meta = JSON.parse(surface.metadata) as Record<string, unknown>;
        if (meta.providerKind === 'controller') {
          controllerBackedCount++;
        } else if (meta.providerKind === 'closure') {
          closureBackedCount++;
        } else {
          unknownProviderKindCount++;
        }
      } catch {
        unknownProviderKindCount++;
      }
    } else {
      unknownProviderKindCount++;
    }
  }

  return { controllerBackedCount, closureBackedCount, unknownProviderKindCount };
}
