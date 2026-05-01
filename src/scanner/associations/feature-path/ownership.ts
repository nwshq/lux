// Tranche-one ownership attribution for feature-path answers.
//
// Wraps the existing module-boundary detection so the assembler can integrate
// ownership directly into the retrieval view instead of treating it as a side
// report (T5, R7, R9).
//
// Reuses `detectModuleBoundaries` and `resolveModule` from the imports scanner;
// no new ontology is introduced. The trust tier mapping is deliberately
// conservative so the answer's `mixedTrust` flag stays meaningful.

import { join } from 'node:path';
import { detectModuleBoundaries, resolveModule } from '../../imports/module-boundary.js';
import type { ModuleBoundaryConfig } from '../../imports/types.js';
import type { TrustTier } from '../../../db/types.js';
import type {
  FeaturePathDirectEvidenceItem,
  FeaturePathOwnership,
  FeaturePathTarget,
  OwnershipBasis,
} from './contract.js';

/**
 * Trust tiers for each ownership basis. Mirrors the spirit of the
 * confidenceClass → trustTier mapping in assemble.ts: configured patterns are
 * treated as proven (5), auto-detected known patterns as artifact-backed (4),
 * directory-led fallbacks as framework-inferred (3).
 */
const OWNERSHIP_BASIS_TRUST_TIER: Record<OwnershipBasis, TrustTier> = {
  'module-boundary': 4,
  'directory-led': 3,
  'overlay-led': 4,
  hybrid: 4,
  unresolved: 1,
};

/** When a config-driven pattern resolves the file, we lift the tier to 5. */
const CONFIG_DRIVEN_BASIS_TRUST_TIER: TrustTier = 5;

export interface AttributeFeaturePathOwnershipInput {
  target: FeaturePathTarget | null;
  /**
   * Direct evidence already assembled for the answer. The handler-recovery item
   * is preferred over the route-declaration item because controllers live
   * inside module directories while route files often sit at the project root.
   */
  directEvidence?: FeaturePathDirectEvidenceItem[];
  /** Absolute repo root used to anchor module-boundary detection. */
  repoRoot: string;
  /** Optional config to override or pin module-boundary patterns. */
  moduleBoundaryConfig?: ModuleBoundaryConfig;
}

/**
 * Pick the best file path for ownership attribution. Handler-recovery wins
 * when present; route-declaration is the fallback so closure-backed surfaces
 * still produce ownership when the route file lives inside a module.
 */
function pickOwnershipFilePath(
  target: FeaturePathTarget | null,
  directEvidence: FeaturePathDirectEvidenceItem[]
): string | null {
  const handlerItem = directEvidence.find((item) => item.kind === 'handler-recovery');
  if (handlerItem?.filePath) return handlerItem.filePath;

  const routeItem = directEvidence.find((item) => item.kind === 'route-declaration');
  if (routeItem?.filePath) return routeItem.filePath;

  if (target?.filePath) return target.filePath;
  return null;
}

function regionId(name: string): string {
  return `module:${name}`;
}

/**
 * Attribute ownership for a feature-path answer.
 *
 * Returns `null` when no file path is available — ownership cannot be
 * fabricated. Returns a `FeaturePathOwnership` with `basis: 'unresolved'`
 * (and tier 1) when a path exists but no boundary pattern matches; this lets
 * the failure classifier emit `weak-ownership` instead of silently dropping
 * the slot.
 */
export function attributeFeaturePathOwnership(
  input: AttributeFeaturePathOwnershipInput
): FeaturePathOwnership | null {
  const directEvidence = input.directEvidence ?? [];
  const filePath = pickOwnershipFilePath(input.target, directEvidence);
  if (!filePath) return null;

  const configPatterns = input.moduleBoundaryConfig?.patterns ?? [];
  const hasConfig = configPatterns.length > 0;

  const patterns = detectModuleBoundaries(input.repoRoot, input.moduleBoundaryConfig);
  if (patterns.length === 0) {
    return {
      regionId: 'unresolved',
      regionName: 'unresolved',
      basis: 'unresolved',
      trustTier: OWNERSHIP_BASIS_TRUST_TIER.unresolved,
      rationale: 'no module-boundary patterns detected for repo root',
    };
  }

  const absoluteFilePath = join(input.repoRoot, filePath);
  const region = resolveModule(absoluteFilePath, input.repoRoot, patterns);

  if (region) {
    const matchedConfigPattern =
      hasConfig &&
      configPatterns.some((pattern) => {
        const prefix = pattern.split('{name}')[0] ?? '';
        return prefix.length > 0 && filePath.startsWith(prefix);
      });

    const isFallbackPattern = patterns.length === 1 && patterns[0] === '{name}';
    const basis: OwnershipBasis = isFallbackPattern ? 'directory-led' : 'module-boundary';

    const trustTier =
      matchedConfigPattern && basis === 'module-boundary'
        ? CONFIG_DRIVEN_BASIS_TRUST_TIER
        : OWNERSHIP_BASIS_TRUST_TIER[basis];

    const ownership: FeaturePathOwnership = {
      regionId: regionId(region),
      regionName: region,
      basis,
      trustTier,
    };

    if (matchedConfigPattern) {
      ownership.rationale = 'resolved via configured module-boundary pattern';
    } else if (basis === 'directory-led') {
      ownership.rationale = 'resolved via top-level directory fallback';
    }

    return ownership;
  }

  return {
    regionId: 'unresolved',
    regionName: 'unresolved',
    basis: 'unresolved',
    trustTier: OWNERSHIP_BASIS_TRUST_TIER.unresolved,
    rationale: `no module-boundary pattern matched ${filePath}`,
  };
}
