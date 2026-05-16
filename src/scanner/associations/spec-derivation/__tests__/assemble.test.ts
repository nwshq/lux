import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LuxDatabase } from '../../../../db/index.js';
import {
  REPO_ROOT,
  cleanupSpecDb,
  makeSpecDb,
  seedOperational,
  seedRoute,
  seedSupportingContextOperationalEdge,
} from './test-helpers.js';
import { assembleSpecDerivationEvidencePacket } from '../assemble.js';

describe('spec-derivation packet assembly', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeSpecDb();
    seedRoute(db);
    seedOperational(db);
  });

  afterEach(() => cleanupSpecDb(db));

  it('assembles a route packet with evidence-first contract fields', () => {
    const packet = assembleSpecDerivationEvidencePacket(db, {
      question: 'What source evidence supports this operation?',
      target: 'POST /orders',
      kind: 'route',
      corpusPath: REPO_ROOT,
    });

    expect(packet.schemaVersion).toBe(1);
    expect(packet.surface).toBe('spec-derivation-evidence');
    expect(packet.target.kind).toBe('route');
    expect(packet.candidateOperation.entrySurfaces.length).toBeGreaterThan(0);
    expect(packet.operationalEffects.length).toBeGreaterThan(0);
    expect(packet.sufficiency.overall).toBe('partial');
    expect(packet.candidateOperation.entrySurfaces[0].sourceFact).toBeTruthy();
  });

  it('assembles an operational job packet with contracts and effects', () => {
    const packet = assembleSpecDerivationEvidencePacket(db, {
      question: 'What source evidence supports this job?',
      target: 'App\\Jobs\\SyncOrders',
      kind: 'job',
      corpusPath: REPO_ROOT,
    });

    expect(packet.target.kind).toBe('job');
    expect(packet.dataFlow.length).toBeGreaterThan(0);
    expect(packet.operationalEffects.length).toBeGreaterThan(0);
    expect(packet.coverage.operationalEffectSignals.operational_handler).toBe('found');
  });

  it('returns an insufficient packet for unresolved targets', () => {
    const packet = assembleSpecDerivationEvidencePacket(db, {
      question: 'What source evidence supports this route?',
      target: 'POST /missing',
      kind: 'route',
      corpusPath: REPO_ROOT,
    });

    expect(packet.target.resolutionState).toBe('unresolved');
    expect(packet.sufficiency.overall).toBe('insufficient');
  });

  it('keeps docs and naming as weak supporting context', () => {
    seedSupportingContextOperationalEdge(db);

    const packet = assembleSpecDerivationEvidencePacket(db, {
      question: 'What source evidence supports this job?',
      target: 'App\\Jobs\\SyncOrders',
      kind: 'job',
      corpusPath: REPO_ROOT,
    });

    expect(packet.supportingContext.length).toBeGreaterThan(0);
    expect(packet.supportingContext.every((claim) => claim.support !== 'direct')).toBe(true);
    expect(packet.coverage.supportingContextSignals.naming_evidence).toBe('found');
  });

  it('reports trust-state variations from persisted overlay metadata', () => {
    cleanupSpecDb(db);
    db = makeSpecDb({
      mode: 'degraded-overlay',
      sourceAction: 'index-sync',
      warnings: ['Overlay-relevant files changed after rebuild.'],
    });
    seedRoute(db);
    seedOperational(db);

    const packet = assembleSpecDerivationEvidencePacket(db, {
      question: 'What source evidence supports this route?',
      target: 'POST /orders',
      kind: 'route',
      corpusPath: REPO_ROOT,
    });

    expect(packet.sourceScope.trustState).toBe('stale');
    expect(packet.sourceScope.warnings.join('\n')).toContain('Overlay-relevant files changed');
  });

  it('keeps full data-flow coverage keys visible when signals are unsupported or missing', () => {
    const packet = assembleSpecDerivationEvidencePacket(db, {
      question: 'What source evidence supports this job?',
      target: 'App\\Jobs\\SyncOrders',
      kind: 'job',
      corpusPath: REPO_ROOT,
    });

    expect(packet.coverage.dataFlowSignals.event_or_job_payload).toBe('found');
    expect(packet.coverage.dataFlowSignals.response_or_resource_field).toBe('missing');
    expect(packet.coverage.dataFlowSignals.database_column_touched).toBe('unsupported');
    expect(packet.coverage.dataFlowSignals.derived_or_computed_field).toBe('unsupported');
  });
});
