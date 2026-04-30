import type { LuxDatabase } from '../db/index.js';
import {
  describeOverlayTrustInspection,
  inspectOverlayTrustState,
  type OverlayTrustDiagnostics,
  type PersistedOverlayTrustState,
} from '../scanner/overlay-trust-state.js';

export type OverlayStatusPayload =
  | (PersistedOverlayTrustState & {
      trustLevel: OverlayTrustDiagnostics['trustLevel'];
      trustSource: OverlayTrustDiagnostics['trustSource'];
      warnings: string[];
    })
  | OverlayTrustDiagnostics;

export interface IndexStatusPayload {
  stats: ReturnType<LuxDatabase['getStats']>;
  overlay: OverlayStatusPayload;
}

export function buildOverlayStatusPayload(db: LuxDatabase): OverlayStatusPayload {
  const inspection = inspectOverlayTrustState(db);
  const diagnostics = describeOverlayTrustInspection(inspection);

  return inspection.state
    ? {
        ...inspection.state,
        trustLevel: diagnostics.trustLevel,
        trustSource: diagnostics.trustSource,
        warnings: diagnostics.warnings,
      }
    : diagnostics;
}

export function buildIndexStatusPayload(db: LuxDatabase): IndexStatusPayload {
  return {
    stats: db.getStats(),
    overlay: buildOverlayStatusPayload(db),
  };
}
