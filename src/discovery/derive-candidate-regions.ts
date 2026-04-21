import { isAbsolute, relative, resolve } from 'path';
import type { ModuleDependency } from '../db/types.js';
import type { ModuleCluster } from '../db/clustering.js';
import type {
  CandidateRegion,
  DeriveCandidateRegionsFn,
  DiscoveryContext,
  DiscoveryOptions,
  OverlayNeighborhood,
} from './types.js';

const MAX_CANDIDATE_REGIONS = 20;
const MAX_ANCHOR_PATHS = 6;
const MAX_SUPPORTING_PATHS = 6;
const MAX_EVIDENCE_LINES = 6;
const GENERIC_DIRECTORY_NAMES = new Set([
  'app',
  'src',
  'lib',
  'modules',
  'services',
  'controllers',
  'models',
  'views',
  'resources',
  'routes',
  'tests',
]);

type CandidateBasis = CandidateRegion['basis'];

interface RegionAccumulator {
  path: string;
  dominantDirectories: Set<string>;
  anchorPaths: Set<string>;
  supportingPaths: Set<string>;
  evidence: Set<string>;
  sizeScore: number;
  symbolScore: number;
  referenceScore: number;
  dependencyScore: number;
  overlayScore: number;
  uncoveredRegionBonus: number;
  cohesionScore?: number;
  externalCouplingScore?: number;
  trustWeight?: number;
}

export const deriveCandidateRegions: DeriveCandidateRegionsFn = (
  context: DiscoveryContext,
  options: DiscoveryOptions
): DiscoveryContext => {
  const regions = new Map<string, RegionAccumulator>();

  for (const [dir, count] of Object.entries(context.fileCountsByDirectory)) {
    const key = normalizeCandidatePath(dir, options.rootPath);
    if (!key) continue;

    const region = ensureRegion(regions, key);
    region.sizeScore += normalizeCount(count, 40);
    region.dominantDirectories.add(key);
    if (count >= 3) {
      region.evidence.add(`${count} indexed files under ${key}`);
    }
  }

  for (const [dir, names] of Object.entries(context.symbolSummaries ?? {})) {
    const key = normalizeCandidatePath(dir, options.rootPath);
    if (!key) continue;

    const region = ensureRegion(regions, key);
    region.symbolScore += Math.min(names.length, 10) / 10;
    region.dominantDirectories.add(key);
    region.supportingPaths.add(key);
    if (names.length > 0) {
      region.evidence.add(
        `symbol-rich area (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''})`
      );
    }
  }

  for (const ref of context.crossReferences ?? []) {
    const sourceDir = normalizeCandidatePath(ref.sourceDir, options.rootPath);
    const targetDir = normalizeCandidatePath(ref.targetDir, options.rootPath);
    if (!sourceDir || !targetDir) continue;

    const boost = normalizeCount(ref.referenceCount, 20);

    const sourceRegion = ensureRegion(regions, sourceDir);
    sourceRegion.referenceScore += boost;
    sourceRegion.dominantDirectories.add(sourceDir);
    sourceRegion.supportingPaths.add(targetDir);
    if (ref.referenceCount >= 2) {
      sourceRegion.evidence.add(
        `strong outbound reference flow to ${targetDir} (${ref.referenceCount} refs)`
      );
    }

    const targetRegion = ensureRegion(regions, targetDir);
    targetRegion.referenceScore += boost;
    targetRegion.dominantDirectories.add(targetDir);
    targetRegion.supportingPaths.add(sourceDir);
    if (ref.referenceCount >= 2) {
      targetRegion.evidence.add(
        `strong inbound reference flow from ${sourceDir} (${ref.referenceCount} refs)`
      );
    }
  }

  for (const dep of context.moduleCoupling ?? []) {
    accumulateDependency(regions, dep, options.rootPath);
  }

  for (const cluster of context.clusters ?? []) {
    accumulateCluster(regions, cluster, options.rootPath);
  }

  for (const neighborhood of context.overlayNeighborhoods ?? []) {
    accumulateOverlayNeighborhood(regions, neighborhood, options.rootPath);
  }

  const existingExpertPaths = context.existingExperts
    .map((expert) => normalizeCandidatePath(expert.mountPath, options.rootPath))
    .filter((path): path is string => Boolean(path));

  const candidateRegions = Array.from(regions.values())
    .map((region, index) => finalizeRegion(region, existingExpertPaths, index))
    .filter((region): region is CandidateRegion => Boolean(region))
    .sort((a, b) => b.salienceScore - a.salienceScore || a.id.localeCompare(b.id))
    .slice(0, MAX_CANDIDATE_REGIONS);

  return {
    ...context,
    ...(candidateRegions.length > 0 && { candidateRegions }),
  };
};

function accumulateDependency(
  regions: Map<string, RegionAccumulator>,
  dep: ModuleDependency,
  rootPath: string
): void {
  const source = normalizeCandidatePath(dep.source_module, rootPath);
  const target = normalizeCandidatePath(dep.target_module, rootPath);
  if (!source || !target) return;

  const boost = normalizeCount(dep.reference_count, 25);

  const sourceRegion = ensureRegion(regions, source);
  sourceRegion.dependencyScore += boost;
  sourceRegion.dominantDirectories.add(source);
  sourceRegion.supportingPaths.add(target);
  sourceRegion.evidence.add(`coupled to ${target} (${dep.reference_count} dependency refs)`);

  const targetRegion = ensureRegion(regions, target);
  targetRegion.dependencyScore += boost;
  targetRegion.dominantDirectories.add(target);
  targetRegion.supportingPaths.add(source);
  targetRegion.evidence.add(`coupled to ${source} (${dep.reference_count} dependency refs)`);
}

function accumulateCluster(
  regions: Map<string, RegionAccumulator>,
  cluster: ModuleCluster,
  rootPath: string
): void {
  const members = cluster.members
    .map((member) => normalizeCandidatePath(member, rootPath))
    .filter((member): member is string => Boolean(member));

  if (members.length === 0) return;

  const clusterBoost = normalizeCount(cluster.couplingScore, 40);
  for (const member of members) {
    const region = ensureRegion(regions, member);
    region.dependencyScore += clusterBoost;
    region.dominantDirectories.add(member);
    for (const peer of members) {
      if (peer !== member) {
        region.supportingPaths.add(peer);
      }
    }
    region.evidence.add(
      `member of dependency cluster ${cluster.name} (${members.length} modules, score ${cluster.couplingScore})`
    );
  }
}

function accumulateOverlayNeighborhood(
  regions: Map<string, RegionAccumulator>,
  neighborhood: OverlayNeighborhood,
  rootPath: string
): void {
  const dominantDirectories = neighborhood.dominantDirectories
    .map((dir) => normalizeCandidatePath(dir, rootPath))
    .filter((dir): dir is string => Boolean(dir));

  if (dominantDirectories.length === 0) return;

  const overlayStrength = clamp01(
    neighborhood.trustWeight *
      Math.max(0.1, neighborhood.cohesionScore) *
      (1 - neighborhood.externalCouplingScore * 0.5)
  );

  for (const dir of dominantDirectories) {
    const region = ensureRegion(regions, dir);
    region.overlayScore += overlayStrength;
    region.dominantDirectories.add(dir);
    region.cohesionScore = Math.max(region.cohesionScore ?? 0, neighborhood.cohesionScore);
    region.externalCouplingScore = Math.max(
      region.externalCouplingScore ?? 0,
      neighborhood.externalCouplingScore
    );
    region.trustWeight = Math.max(region.trustWeight ?? 0, neighborhood.trustWeight);

    for (const anchor of neighborhood.anchorFiles) {
      const normalizedAnchor = normalizeSupportPath(anchor, rootPath);
      if (normalizedAnchor) {
        region.anchorPaths.add(normalizedAnchor);
      }
    }

    for (const peer of dominantDirectories) {
      if (peer !== dir) {
        region.supportingPaths.add(peer);
      }
    }

    region.evidence.add(
      `${neighborhood.kind} overlay neighborhood ${neighborhood.label} (trust ${neighborhood.trustState}, cohesion ${neighborhood.cohesionScore.toFixed(2)})`
    );

    for (const evidence of neighborhood.evidenceSummary.slice(0, 2)) {
      region.evidence.add(evidence);
    }
  }
}

function finalizeRegion(
  region: RegionAccumulator,
  existingExpertPaths: string[],
  index: number
): CandidateRegion | null {
  const sizeScore = clamp01(region.sizeScore);
  const symbolScore = clamp01(region.symbolScore);
  const referenceScore = clamp01(region.referenceScore);
  const dependencyScore = clamp01(region.dependencyScore);
  const overlayScore = clamp01(region.overlayScore);
  const uncoveredRegionBonus = isCoveredByExistingExpert(region.path, existingExpertPaths) ? 0 : 1;

  const salienceScore = clamp01(
    overlayScore * 0.3 +
      dependencyScore * 0.2 +
      referenceScore * 0.2 +
      symbolScore * 0.15 +
      sizeScore * 0.1 +
      uncoveredRegionBonus * 0.05
  );

  const signalCount = [overlayScore, dependencyScore, referenceScore, symbolScore].filter(
    (score) => score > 0.15
  ).length;

  if (salienceScore < 0.18 || (signalCount === 0 && sizeScore < 0.25)) {
    return null;
  }

  const basis = determineBasis(overlayScore, dependencyScore, referenceScore, symbolScore);
  const dominantDirectories = Array.from(region.dominantDirectories)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 3);
  const anchorPaths = Array.from(region.anchorPaths)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_ANCHOR_PATHS);
  const supportingPaths = Array.from(region.supportingPaths)
    .filter((path) => !dominantDirectories.includes(path))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_SUPPORTING_PATHS);
  const evidence = Array.from(region.evidence)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_EVIDENCE_LINES);

  return {
    id: `candidate-${String(index + 1).padStart(2, '0')}-${slugify(region.path)}`,
    label: buildRegionLabel(region.path),
    anchorPaths,
    dominantDirectories,
    ...(supportingPaths.length > 0 && { supportingPaths }),
    basis,
    salienceScore,
    ...(region.cohesionScore !== undefined && { cohesionScore: clamp01(region.cohesionScore) }),
    ...(region.externalCouplingScore !== undefined && {
      externalCouplingScore: clamp01(region.externalCouplingScore),
    }),
    ...(region.trustWeight !== undefined && { trustWeight: clamp01(region.trustWeight) }),
    evidence,
  };
}

function ensureRegion(regions: Map<string, RegionAccumulator>, path: string): RegionAccumulator {
  let region = regions.get(path);
  if (!region) {
    region = {
      path,
      dominantDirectories: new Set([path]),
      anchorPaths: new Set(),
      supportingPaths: new Set(),
      evidence: new Set(),
      sizeScore: 0,
      symbolScore: 0,
      referenceScore: 0,
      dependencyScore: 0,
      overlayScore: 0,
      uncoveredRegionBonus: 0,
    };
    regions.set(path, region);
  }
  return region;
}

function determineBasis(
  overlayScore: number,
  dependencyScore: number,
  referenceScore: number,
  symbolScore: number
): CandidateBasis {
  const ranked = [
    { basis: 'overlay-led' as const, score: overlayScore },
    { basis: 'dependency-led' as const, score: dependencyScore },
    { basis: 'reference-led' as const, score: referenceScore },
  ].sort((a, b) => b.score - a.score);

  const activeSignals = [overlayScore, dependencyScore, referenceScore, symbolScore].filter(
    (score) => score > 0.15
  ).length;

  if (activeSignals >= 2 && ranked[0].score - ranked[1].score < 0.15) {
    return 'hybrid';
  }

  if (ranked[0].score <= 0.15) {
    return 'hybrid';
  }

  return ranked[0].basis;
}

function normalizeCount(value: number, scale: number): number {
  if (value <= 0) return 0;
  return clamp01(Math.log1p(value) / Math.log1p(scale));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isCoveredByExistingExpert(path: string, existingExpertPaths: string[]): boolean {
  return existingExpertPaths.some(
    (expertPath) =>
      path === expertPath || path.startsWith(expertPath + '/') || expertPath.startsWith(path + '/')
  );
}

function normalizeCandidatePath(pathValue: string, rootPath?: string): string | null {
  const normalized = normalizeSupportPath(pathValue, rootPath);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function normalizeSupportPath(pathValue: string, rootPath?: string): string | null {
  const normalizedInput = pathValue.replace(/\\/g, '/');

  if (!rootPath) {
    return normalizedInput.replace(/^\.\//, '').replace(/\/+$/, '') || null;
  }

  const resolvedPath = resolve(isAbsolute(pathValue) ? pathValue : resolve(rootPath, pathValue));
  const rel = relative(resolve(rootPath), resolvedPath).replace(/\\/g, '/');

  if (!rel || rel === '') {
    return '.';
  }

  if (!rel.startsWith('../') && rel !== '..') {
    return rel.replace(/\/+$/, '');
  }

  return normalizedInput.replace(/^\.\//, '').replace(/\/+$/, '') || null;
}

function buildRegionLabel(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    return 'Root';
  }

  const last = segments[segments.length - 1];
  const prev = segments.length > 1 ? segments[segments.length - 2] : undefined;

  if (prev && GENERIC_DIRECTORY_NAMES.has(last.toLowerCase())) {
    return `${titleize(prev)} ${titleize(last)}`;
  }

  return titleize(last);
}

function titleize(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
