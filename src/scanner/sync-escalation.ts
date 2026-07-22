import type { LuxDatabase } from '../db/index.js';
import { loadLspConfig, DEFAULT_REFRESH_CONFIG } from './config.js';
import { structuralConfigFingerprintMatches } from './config-fingerprint.js';
import { deriveOverlayTrustLevel } from './overlay-trust-state.js';

export type ScopedDecision =
  | { path: 'scoped'; maxScopedFiles: number; lspBudgetMs: number }
  | {
      path: 'full';
      reason:
        | 'no-overlay' // precondition: refresh repairs, never bootstraps
        | 'pending-migration' // schema not current
        | 'first-party' // Decision 9 — cross-area freshness is Arc 3
        | 'config-changed' // Decision 7 — fingerprint mismatch
        | 'over-budget'; // Decision 7 — changed count above maxScopedFiles
    };

/**
 * Route a structural sync to scoped-vs-full (Phase 3b default). The four runtime escalation
 * triggers + the two preconditions, in cheap-and-definitive-first order (Decisions 7/9). Scoped
 * must never silently skip a structural change that needs a full rebuild (config change / migration
 * / over-budget / first-party promotion).
 */
export function decideScopedEligibility(
  db: LuxDatabase,
  rootPath: string,
  changedStructuralCount: number
): ScopedDecision {
  const config = loadLspConfig(rootPath);
  const refresh = config.refresh ?? DEFAULT_REFRESH_CONFIG; // Part-B constant (OQ1's 100 is one edit site)

  // Precondition: an overlay must exist to repair (no-overlay/content-only ⇒ full bootstrap).
  const level = deriveOverlayTrustLevel(db);
  if (level === 'no-overlay' || level === 'content-only')
    return { path: 'full', reason: 'no-overlay' };

  // Schema must be current (a scoped pass over a pre-migration overlay mixes regimes).
  if (!db.isSchemaUpToDate()) return { path: 'full', reason: 'pending-migration' };

  // Decision 9 — firstParty promotion is cross-area freshness (Arc 3), out of scope for v1.
  if (config.firstParty && config.firstParty.packages.length > 0) {
    return { path: 'full', reason: 'first-party' };
  }

  // Decision 7 — structural config changed since the last full rebuild.
  if (!structuralConfigFingerprintMatches(rootPath, db))
    return { path: 'full', reason: 'config-changed' };

  // Decision 7 — changed set too large to be "scoped".
  if (changedStructuralCount > refresh.maxScopedFiles)
    return { path: 'full', reason: 'over-budget' };

  return {
    path: 'scoped',
    maxScopedFiles: refresh.maxScopedFiles,
    lspBudgetMs: refresh.lspBudgetMs,
  };
}

/**
 * `--scoped` operator override: return `scoped` for everything except the two HARD preconditions
 * (`no-overlay`, `pending-migration`). An operator's `--scoped` may override the
 * fingerprint/first-party/budget *policy*, but never the preconditions that would make scoped
 * unsound (there is no overlay to repair, or the schema is stale).
 */
export function decideForcedScoped(db: LuxDatabase, rootPath: string): ScopedDecision {
  const level = deriveOverlayTrustLevel(db);
  if (level === 'no-overlay' || level === 'content-only')
    return { path: 'full', reason: 'no-overlay' };
  if (!db.isSchemaUpToDate()) return { path: 'full', reason: 'pending-migration' };
  const refresh = loadLspConfig(rootPath).refresh ?? DEFAULT_REFRESH_CONFIG; // Part-B constant (one edit site)
  return {
    path: 'scoped',
    maxScopedFiles: refresh.maxScopedFiles,
    lspBudgetMs: refresh.lspBudgetMs,
  };
}
