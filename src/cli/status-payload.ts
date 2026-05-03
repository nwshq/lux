import type { LuxDatabase } from '../db/index.js';
import type { RuntimePathResolution } from '../utils/runtime-paths.js';
import {
  describeOverlayTrustInspection,
  inspectOverlayTrustState,
  type OverlayTrustDiagnostics,
  type PersistedOverlayTrustState,
} from '../scanner/overlay-trust-state.js';

export type OverlayTrustPayload =
  | (PersistedOverlayTrustState & {
      trustLevel: OverlayTrustDiagnostics['trustLevel'];
      trustSource: OverlayTrustDiagnostics['trustSource'];
      warnings: string[];
    })
  | OverlayTrustDiagnostics;

export type OverlayStatusPayload = OverlayTrustPayload | OverlayStatusPayloadWithRuntime;

export interface OverlayStatusPayloadWithRuntime {
  overlay: OverlayTrustPayload;
  runtime: RuntimeStatusPayload;
}

export interface IndexStatusPayload {
  stats: ReturnType<LuxDatabase['getStats']>;
  overlay: OverlayTrustPayload;
  runtime?: RuntimeStatusPayload;
}

export interface RuntimeStatusPayload {
  corpusPath: string;
  corpusSource: RuntimePathResolution['corpusSource'];
  dbPath: string;
  dbSource: RuntimePathResolution['dbSource'];
}

function buildRuntimeStatusPayload(runtime: RuntimePathResolution): RuntimeStatusPayload {
  return {
    corpusPath: runtime.corpusPath,
    corpusSource: runtime.corpusSource,
    dbPath: runtime.dbPath,
    dbSource: runtime.dbSource,
  };
}

function buildOverlayTrustPayload(db: LuxDatabase): OverlayTrustPayload {
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

export function buildOverlayStatusPayload(
  db: LuxDatabase,
  runtime?: RuntimePathResolution
): OverlayStatusPayload {
  const overlay = buildOverlayTrustPayload(db);
  return runtime ? { overlay, runtime: buildRuntimeStatusPayload(runtime) } : overlay;
}

export function buildIndexStatusPayload(
  db: LuxDatabase,
  runtime?: RuntimePathResolution
): IndexStatusPayload {
  return {
    stats: db.getStats(),
    overlay: buildOverlayTrustPayload(db),
    ...(runtime ? { runtime: buildRuntimeStatusPayload(runtime) } : {}),
  };
}
