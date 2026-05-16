import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LuxDatabase } from '../../../../db/index.js';
import {
  REPO_ROOT,
  cleanupSpecDb,
  makeSpecDb,
  seedAmbiguousRoutes,
  seedOperational,
  seedRoute,
} from './test-helpers.js';
import { resolveSpecDerivationTarget } from '../resolve.js';

describe('spec-derivation target resolution', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeSpecDb();
    seedRoute(db);
    seedOperational(db);
  });

  afterEach(() => cleanupSpecDb(db));

  it('resolves route targets through feature-path surfaces', () => {
    const resolved = resolveSpecDerivationTarget(db, {
      kind: 'route',
      identifier: 'POST /orders',
      corpusPath: REPO_ROOT,
    });

    expect(resolved.target.resolutionState).toBe('resolved');
    expect(resolved.target.resolvedNodeId).toBe('surface:http:POST:/orders');
    expect(resolved.featurePath?.providers[0]?.id).toContain('OrderController');
  });

  it('resolves job targets through operational boundaries', () => {
    const resolved = resolveSpecDerivationTarget(db, {
      kind: 'job',
      identifier: 'SyncOrders',
      corpusPath: REPO_ROOT,
    });

    expect(resolved.target.resolutionState).toBe('resolved');
    expect(resolved.operationalBoundary?.kind).toBe('job');
  });

  it('resolves listener targets as listener handlers with event context', () => {
    const resolved = resolveSpecDerivationTarget(db, {
      kind: 'listener',
      identifier: 'UpdateOrderProjection',
      corpusPath: REPO_ROOT,
    });

    expect(resolved.target.resolutionState).toBe('resolved');
    expect(resolved.target.resolvedNodeId).toContain('UpdateOrderProjection');
    expect(resolved.target.candidates.some((candidate) => candidate.kind === 'event-context')).toBe(
      true
    );
  });

  it('returns ambiguous resolution with candidates when multiple targets match', () => {
    seedAmbiguousRoutes(db);

    const resolved = resolveSpecDerivationTarget(db, {
      kind: 'route',
      identifier: 'GET /reports',
      corpusPath: REPO_ROOT,
    });

    expect(resolved.target.resolutionState).toBe('ambiguous');
    expect(resolved.target.candidates.length).toBe(2);
    expect(resolved.target.candidates.map((candidate) => candidate.id)).toEqual([
      'surface:http:GET:/reports-alpha',
      'surface:http:GET:/reports-beta',
    ]);
  });
});
