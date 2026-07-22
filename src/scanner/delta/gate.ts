import type {
  BaselineDiff,
  DeltaRefusal,
  GateResult,
  GateViolation,
  OwnershipProjection,
} from './types.js';

/** Every gate category delta knows. A token outside this set hard-errors (never a skipped gate). */
export const KNOWN_GATE_CATEGORIES: ReadonlySet<string> = new Set([
  'overlay-not-complete',
  'client-gap-created',
  'budget-truncated',
  'boundary-edge-added', // Phase 4 — requires --baseline-db
  'surface-removed', // Phase 4 — requires --baseline-db
]);

/** Default gate when --check is passed with neither --fail-on nor lux.yaml delta.gates. */
export const DEFAULT_CHECK_GATES: readonly string[] = ['overlay-not-complete'];

/**
 * Resolve the active gate set: `--fail-on` overrides `lux.yaml delta.gates`, which overrides the
 * default. Any unknown token aborts with a config error (Decision, §"No silent passes") — the same
 * check for both sources.
 */
export function resolveGateCategories(
  failOn: string[] | undefined,
  configGates: string[] | undefined
): string[] | DeltaRefusal {
  const raw = failOn ?? configGates ?? [...DEFAULT_CHECK_GATES];
  const unknown = raw.filter((c) => !KNOWN_GATE_CATEGORIES.has(c));
  if (unknown.length) {
    return {
      reason: 'config-error',
      message: `Unknown delta gate categor${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(
        ', '
      )}. Known: ${[...KNOWN_GATE_CATEGORIES].join(', ')}.`,
    };
  }
  return [...new Set(raw)];
}

export interface GateInputs {
  categories: string[];
  /** Primary overlay trust level (deriveOverlayTrustLevelFromState). */
  trustLevel: string;
  ownership: OwnershipProjection;
  /** Touched handler symbols whose declaring file is DELETED in the change-set. */
  deletedHandlerSymbols: Set<string>;
  /** symbol id → declaring file path, for violation evidence. */
  handlerFiles: Map<string, string>;
  /** `downstream.budget.truncated` (incl. the index-absent-hub blind spot). */
  downstreamTruncated: boolean;
  baselineDiff?: BaselineDiff;
}

/**
 * Evaluate active gates into blocking violations. Never silent-passes: a configured-but-unevaluable
 * gate (unconfigured/stale kernel; no baseline) emits a blocking violation rather than skipping.
 */
export function evaluateGates(inp: GateInputs): GateResult {
  const violations: GateViolation[] = [];
  const active = new Set(inp.categories);

  if (active.has('overlay-not-complete') && inp.trustLevel !== 'overlay-complete') {
    violations.push({
      category: 'overlay-not-complete',
      severity: 'blocking',
      subject: `overlay:${inp.trustLevel}`,
      detail: `overlay trust is ${inp.trustLevel}, not overlay-complete — blast radius may be under-reported.`,
    });
  }

  if (active.has('client-gap-created')) {
    if (!inp.ownership.kernelConfigured) {
      violations.push({
        category: 'client-gap-created',
        severity: 'blocking',
        subject: 'overlay.kernel',
        detail:
          'client-gap-created is active but overlay.kernel.package is not configured — cannot evaluate (fail-loud, Decision 15).',
      });
    } else if (!inp.ownership.kernelResolved) {
      violations.push({
        category: 'client-gap-created',
        severity: 'blocking',
        subject: 'kernel',
        detail:
          inp.ownership.warning ??
          'kernel index unresolvable/stale — cannot evaluate client-gap-created (fail-loud).',
      });
    } else {
      for (const t of inp.ownership.transitions) {
        if (t.label === 'client-override' && inp.deletedHandlerSymbols.has(t.changedHandler)) {
          const file = inp.handlerFiles.get(t.changedHandler);
          violations.push({
            category: 'client-gap-created',
            severity: 'blocking',
            subject: t.route,
            detail:
              'diff removes the client handler for a kernel route with no other client implementation',
            evidence: file ? { file } : undefined,
          });
        }
      }
    }
  }

  if (active.has('budget-truncated') && inp.downstreamTruncated) {
    violations.push({
      category: 'budget-truncated',
      severity: 'blocking',
      subject: 'downstream',
      detail:
        'reverse walk exhausted its budget (or a new/unindexed hub contributed zero nodes) — blast radius is unknown.',
    });
  }

  for (const cat of ['boundary-edge-added', 'surface-removed'] as const) {
    if (!active.has(cat)) continue;
    if (!inp.baselineDiff) {
      violations.push({
        category: cat,
        severity: 'blocking',
        subject: 'baseline',
        detail: `${cat} is active but no baseline overlay was provided (--baseline-db) — cannot evaluate (fail-loud, Decision 15).`,
      });
      continue;
    }
    if (cat === 'surface-removed') {
      for (const id of inp.baselineDiff.surfacesRemoved) {
        violations.push({
          category: cat,
          severity: 'blocking',
          subject: id,
          detail: 'surface present in the baseline overlay is absent at HEAD.',
        });
      }
    } else {
      for (const e of inp.baselineDiff.crossModuleEdgesAdded) {
        violations.push({
          category: cat,
          severity: 'blocking',
          subject: `${e.source}->${e.target}`,
          detail: `new cross-module ${e.edgeType} edge vs the baseline overlay.`,
        });
      }
    }
  }

  return { mode: 'check', exitCode: violations.length ? 1 : 0, violations };
}
