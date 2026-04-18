// Shared structural-analysis substrate for expert discovery and routing.
//
// Computes overlay-native neighborhoods, structural signatures, and ownership
// match scores deterministically from DB state. Consumed by both discovery
// (src/discovery/enrich.ts, analyze.ts) and routing (src/experts/router.ts).
//
// Design rules:
//  - All analysis is deterministic; no AI calls here.
//  - Trust state shapes how strongly structural evidence is used.
//  - Neighborhoods project to operator-legible mount regions; never opaque IDs only.
//  - Signatures are durable (file-path + directory anchored), not raw graph IDs.

import { dirname, basename, extname } from 'path';
import type { LuxDatabase } from '../db/index.js';
import { inspectOverlayTrustState } from '../scanner/overlay-trust-state.js';
import { getSurfaceFeaturePath } from '../scanner/associations/surface-retrieval.js';
import type { FeaturePath } from '../scanner/associations/surface-retrieval.js';

// ── Trust Level ────────────────────────────────────────────────────────────────

/**
 * Five-tier trust level derived from the persisted overlay state.
 *
 * Monotonically ordered: no-overlay < content-only < stale-overlay < degraded-overlay < overlay-complete
 */
export type OverlayTrustLevel =
  | 'no-overlay'
  | 'content-only'
  | 'stale-overlay'
  | 'degraded-overlay'
  | 'overlay-complete';

/**
 * Derive the canonical 5-tier trust level from current DB state.
 *
 *  - no persisted state                          → 'no-overlay'
 *  - content-only mode                           → 'content-only'
 *  - overlay-complete mode                       → 'overlay-complete'
 *  - degraded mode from index-sync               → 'stale-overlay' (was complete, drifted)
 *  - degraded mode from rebuild or derived state → 'degraded-overlay'
 */
export function deriveOverlayTrustLevel(db: LuxDatabase): OverlayTrustLevel {
  const inspection = inspectOverlayTrustState(db);
  if (!inspection.state || inspection.source === 'none') return 'no-overlay';

  const { mode, sourceAction } = inspection.state;

  if (mode === 'content-only') return 'content-only';
  if (mode === 'overlay-complete') return 'overlay-complete';

  // degraded-overlay: distinguish sync-induced staleness from original degradation
  if (mode === 'degraded-overlay' && sourceAction === 'index-sync') return 'stale-overlay';

  return 'degraded-overlay';
}

/**
 * Map a trust level to a numeric weight [0, 1] for scoring.
 * Monotonically increasing; overlay-complete receives full weight.
 */
export function trustLevelToWeight(level: OverlayTrustLevel): number {
  switch (level) {
    case 'overlay-complete':
      return 1.0;
    case 'stale-overlay':
      return 0.4;
    case 'degraded-overlay':
      return 0.3;
    case 'content-only':
      return 0.1;
    case 'no-overlay':
      return 0.0;
  }
}

// ── Core Types ─────────────────────────────────────────────────────────────────

/**
 * A structural neighborhood derived from persisted overlay surfaces and edges.
 * Neighborhoods are the primary unit of structural expert-region evidence.
 */
export interface OverlayNeighborhood {
  /** Stable short ID for this execution; not persisted (signatures are persisted instead). */
  id: string;
  kind: 'surface-family' | 'provider-consumer' | 'contract-cluster';
  /** Human-readable label derived from provider class or dominant directory. */
  label: string;
  /** Files that anchor this neighborhood (provider files, declaring route files). */
  anchorFiles: string[];
  /** All files belonging to this neighborhood (anchors + consumers + contracts). */
  memberFiles: string[];
  /** Top 1–3 directories by anchor file density. */
  dominantDirectories: string[];
  surfaceIds?: string[];
  providerIds?: string[];
  consumerIds?: string[];
  contractNodeIds?: string[];
  /** 0–1: fraction of member files that project into dominant directories. */
  cohesionScore: number;
  /** 0–1: fraction of member files shared with other neighborhoods. */
  externalCouplingScore: number;
  trustState: OverlayTrustLevel;
  trustWeight: number;
  evidenceSummary: string[];
}

/**
 * Durable structural signature for a registered expert.
 * Anchored on file paths and directories rather than transient graph IDs so it
 * can survive overlay rebuilds without becoming stale.
 */
export interface ExpertStructuralSignature {
  version: 1;
  anchorFiles: string[];
  dominantDirectories: string[];
  dominantSurfaces?: string[];
  dominantProviders?: string[];
  contractFamilies?: string[];
  interactionKinds?: string[];
}

/**
 * Result of scoring an expert's structural ownership against a query's hit files.
 */
export interface StructuralOwnershipMatch {
  expertSlug?: string;
  /** Raw structural overlap [0, 1]. */
  overlapScore: number;
  /** Overlap × trustWeight — what routing should actually use. */
  trustAdjustedScore: number;
  /** IDs of neighborhoods that matched the hit files. */
  matchedNeighborhoodIds: string[];
  warningLevel: 'none' | 'debug-only' | 'user-visible';
  warningReason?: string;
}

// ── Neighborhood Extraction ────────────────────────────────────────────────────

/**
 * Extract overlay-native structural neighborhoods from persisted DB state.
 *
 * Returns an empty array when overlay trust is too weak to be useful.
 * Each neighborhood is anchored on a surface family and its immediate
 * structural closure (providers, consumers, validators, response contracts).
 */
export function extractOverlayNeighborhoods(db: LuxDatabase): OverlayNeighborhood[] {
  const trustLevel = deriveOverlayTrustLevel(db);
  const trustWeight = trustLevelToWeight(trustLevel);

  if (trustLevel === 'no-overlay' || trustLevel === 'content-only') {
    return [];
  }

  const surfaces = db.getCapabilitySurfaces();
  if (surfaces.length === 0) return [];

  // Build feature paths for all surfaces
  interface SurfaceEntry {
    surfaceId: string;
    path: FeaturePath | null;
  }
  const entries: SurfaceEntry[] = surfaces.map((s) => ({
    surfaceId: s.id,
    path: getSurfaceFeaturePath(db, s.id),
  }));

  // Group surfaces by provider file (primary) or declaring file (secondary)
  const groups = new Map<string, SurfaceEntry[]>();
  for (const entry of entries) {
    const key = groupingKey(entry.path, entry.surfaceId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  // Build candidate neighborhoods
  const neighborhoods: OverlayNeighborhood[] = [];
  let idx = 0;
  for (const [key, group] of groups) {
    const nbhd = buildNeighborhood(`nbhd-${idx++}`, key, group, trustLevel, trustWeight);
    neighborhoods.push(nbhd);
  }

  // Cross-neighborhood coupling requires all neighborhoods to be built first
  const memberFileIndex = buildMemberFileIndex(neighborhoods);
  for (const nbhd of neighborhoods) {
    nbhd.externalCouplingScore = computeExternalCoupling(nbhd, memberFileIndex);
  }

  return neighborhoods;
}

/**
 * Derive a durable structural signature from a neighborhood.
 *
 * The signature is anchored on file paths and directories rather than
 * transient graph node IDs so it can outlive overlay rebuild churn.
 */
export function computeStructuralSignature(nbhd: OverlayNeighborhood): ExpertStructuralSignature {
  return {
    version: 1,
    anchorFiles: [...nbhd.anchorFiles].sort(),
    dominantDirectories: [...nbhd.dominantDirectories],
    dominantSurfaces:
      nbhd.surfaceIds && nbhd.surfaceIds.length > 0 ? nbhd.surfaceIds.slice(0, 5) : undefined,
    dominantProviders:
      nbhd.providerIds && nbhd.providerIds.length > 0 ? nbhd.providerIds.slice(0, 5) : undefined,
    contractFamilies: contractFamiliesFromIds(nbhd.contractNodeIds),
  };
}

/**
 * Score how well a set of FTS5 hit files matches an expert's structural signature,
 * adjusted for current overlay trust.
 *
 * Scoring weights:
 *   40% — anchor-file Jaccard similarity
 *   35% — dominant-directory Jaccard similarity
 *   25% — neighborhood overlap bonus
 */
export function scoreOwnershipMatch(
  hitFiles: string[],
  expertSignature: ExpertStructuralSignature,
  allNeighborhoods: OverlayNeighborhood[],
  trustWeight: number,
  expertSlug?: string
): StructuralOwnershipMatch {
  if (hitFiles.length === 0 || trustWeight === 0) {
    return {
      expertSlug,
      overlapScore: 0,
      trustAdjustedScore: 0,
      matchedNeighborhoodIds: [],
      warningLevel: trustWeight === 0 ? 'debug-only' : 'none',
      warningReason:
        trustWeight === 0 ? 'overlay trust weight is zero; structural scoring disabled' : undefined,
    };
  }

  const hitFileSet = new Set(hitFiles);
  const hitDirs = new Set(hitFiles.map((f) => dirname(f)));

  // Find neighborhoods overlapping with the query's hit files
  const matchedIds: string[] = [];
  let bestNeighborhoodOverlap = 0;
  for (const nbhd of allNeighborhoods) {
    const anchorJ = jaccardSets(new Set(nbhd.anchorFiles), hitFileSet);
    const memberJ = jaccardSets(new Set(nbhd.memberFiles), hitFileSet);
    const combined = anchorJ * 0.7 + memberJ * 0.3;
    if (combined > 0.05) {
      matchedIds.push(nbhd.id);
      if (combined > bestNeighborhoodOverlap) bestNeighborhoodOverlap = combined;
    }
  }

  // Score against the expert's structural signature
  const anchorFileScore = jaccardSets(new Set(expertSignature.anchorFiles), hitFileSet);
  const dirScore = jaccardSets(new Set(expertSignature.dominantDirectories), hitDirs);
  const neighborhoodBonus = matchedIds.length > 0 ? Math.min(bestNeighborhoodOverlap * 2, 1) : 0;

  const overlapScore = anchorFileScore * 0.4 + dirScore * 0.35 + neighborhoodBonus * 0.25;
  const trustAdjustedScore = overlapScore * trustWeight;

  const { warningLevel, warningReason } = computeWarningLevel(trustWeight, overlapScore);

  return {
    expertSlug,
    overlapScore,
    trustAdjustedScore,
    matchedNeighborhoodIds: matchedIds,
    warningLevel,
    warningReason,
  };
}

// ── Private Helpers ────────────────────────────────────────────────────────────

function groupingKey(fp: FeaturePath | null, surfaceId: string): string {
  if (fp) {
    const providerFile = fp.providers[0]?.file_path;
    if (providerFile) return `provider:${providerFile}`;

    const declaringFile = fp.declaringFile?.file_path;
    if (declaringFile) return `declaring:${declaringFile}`;

    if (fp.surface.file_path) return `surface-file:${fp.surface.file_path}`;
  }
  return `surface:${surfaceId}`;
}

function buildNeighborhood(
  id: string,
  groupKey: string,
  entries: Array<{ surfaceId: string; path: FeaturePath | null }>,
  trustLevel: OverlayTrustLevel,
  trustWeight: number
): OverlayNeighborhood {
  const anchorFilesSet = new Set<string>();
  const memberFilesSet = new Set<string>();
  const surfaceIds: string[] = [];
  const providerIds: string[] = [];
  const consumerIds: string[] = [];
  const contractNodeIds: string[] = [];
  const evidenceParts: string[] = [];

  for (const { surfaceId, path } of entries) {
    surfaceIds.push(surfaceId);
    if (!path) continue;

    // Anchor files: declaring file + provider files
    if (path.declaringFile?.file_path) {
      anchorFilesSet.add(path.declaringFile.file_path);
      memberFilesSet.add(path.declaringFile.file_path);
    }
    for (const p of path.providers) {
      if (p.file_path) {
        anchorFilesSet.add(p.file_path);
        memberFilesSet.add(p.file_path);
      }
      providerIds.push(p.id);
    }

    // Members: consumers, validators, response contracts, artifacts
    for (const c of path.consumers) {
      if (c.file_path) memberFilesSet.add(c.file_path);
      consumerIds.push(c.id);
    }
    for (const v of path.validators) {
      if (v.file_path) memberFilesSet.add(v.file_path);
      contractNodeIds.push(v.id);
    }
    for (const r of path.responseContracts) {
      if (r.file_path) memberFilesSet.add(r.file_path);
      contractNodeIds.push(r.id);
    }
    for (const a of path.artifacts) {
      if (a.file_path) memberFilesSet.add(a.file_path);
    }

    if (path.surface.symbol_name) {
      evidenceParts.push(`surface:${path.surface.symbol_name}`);
    }
  }

  const anchorFiles = [...anchorFilesSet];
  const memberFiles = [...memberFilesSet];
  const dominantDirectories = computeDominantDirectories(anchorFiles);
  const cohesionScore = computeCohesionScore(memberFiles, dominantDirectories);
  const label = deriveLabel(groupKey, dominantDirectories);

  const evidenceSummary = [
    `${surfaceIds.length} surface(s), ${anchorFiles.length} anchor file(s)`,
    ...evidenceParts.slice(0, 5),
  ];

  return {
    id,
    kind: 'surface-family',
    label,
    anchorFiles,
    memberFiles,
    dominantDirectories,
    surfaceIds,
    providerIds: providerIds.length > 0 ? providerIds : undefined,
    consumerIds: consumerIds.length > 0 ? consumerIds : undefined,
    contractNodeIds: contractNodeIds.length > 0 ? contractNodeIds : undefined,
    cohesionScore,
    externalCouplingScore: 0,
    trustState: trustLevel,
    trustWeight,
    evidenceSummary,
  };
}

function computeDominantDirectories(anchorFiles: string[]): string[] {
  if (anchorFiles.length === 0) return [];

  const dirCounts = new Map<string, number>();
  for (const f of anchorFiles) {
    const d = dirname(f);
    dirCounts.set(d, (dirCounts.get(d) ?? 0) + 1);
  }

  return [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => d);
}

function computeCohesionScore(memberFiles: string[], dominantDirs: string[]): number {
  if (memberFiles.length === 0 || dominantDirs.length === 0) return 0;
  const dominantDirSet = new Set(dominantDirs);
  const inDominant = memberFiles.filter((f) => dominantDirSet.has(dirname(f))).length;
  return inDominant / memberFiles.length;
}

function buildMemberFileIndex(neighborhoods: OverlayNeighborhood[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const nbhd of neighborhoods) {
    for (const f of nbhd.memberFiles) {
      if (!index.has(f)) index.set(f, []);
      index.get(f)!.push(nbhd.id);
    }
  }
  return index;
}

function computeExternalCoupling(
  nbhd: OverlayNeighborhood,
  memberFileIndex: Map<string, string[]>
): number {
  if (nbhd.memberFiles.length === 0) return 0;
  let shared = 0;
  for (const f of nbhd.memberFiles) {
    const others = memberFileIndex.get(f) ?? [];
    if (others.some((id) => id !== nbhd.id)) shared++;
  }
  return shared / nbhd.memberFiles.length;
}

function deriveLabel(groupKey: string, dominantDirs: string[]): string {
  if (groupKey.startsWith('provider:')) {
    const filePath = groupKey.slice('provider:'.length);
    return basename(filePath, extname(filePath));
  }
  if (dominantDirs.length > 0) {
    return basename(dominantDirs[0]) || dominantDirs[0];
  }
  // Fallback: use last segment of the key
  const last = groupKey.lastIndexOf(':');
  return last >= 0 ? groupKey.slice(last + 1) : groupKey;
}

function contractFamiliesFromIds(contractNodeIds?: string[]): string[] | undefined {
  if (!contractNodeIds || contractNodeIds.length === 0) return undefined;
  const families = new Set<string>();
  for (const id of contractNodeIds) {
    const last = id.lastIndexOf(':');
    if (last >= 0) {
      const suffix = id.slice(last + 1);
      if (suffix.length > 3 && !suffix.startsWith('contract-')) {
        families.add(suffix);
      }
    }
  }
  return families.size > 0 ? [...families].slice(0, 10) : undefined;
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function computeWarningLevel(
  trustWeight: number,
  overlapScore: number
): { warningLevel: StructuralOwnershipMatch['warningLevel']; warningReason?: string } {
  if (trustWeight < 0.5 && overlapScore > 0.3) {
    return {
      warningLevel: 'user-visible',
      warningReason: `structural ownership confidence reduced — overlay trust weight is ${trustWeight.toFixed(2)}`,
    };
  }
  if (trustWeight < 1.0) {
    return {
      warningLevel: 'debug-only',
      warningReason: `overlay trust weight is ${trustWeight.toFixed(2)}; structural evidence may be incomplete`,
    };
  }
  return { warningLevel: 'none' };
}
