import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHECK_GATES,
  KNOWN_GATE_CATEGORIES,
  evaluateGates,
  resolveGateCategories,
  type GateInputs,
} from '../gate.js';
import type { BaselineDiff, DeltaRefusal, OwnershipProjection } from '../types.js';

function isRefusal(v: string[] | DeltaRefusal): v is DeltaRefusal {
  return !Array.isArray(v);
}

const UNAVAILABLE: OwnershipProjection = {
  kernelConfigured: false,
  kernelResolved: false,
  source: 'unavailable',
  kernelDrift: null,
  transitions: [],
};

function inputs(overrides: Partial<GateInputs> = {}): GateInputs {
  return {
    categories: [],
    trustLevel: 'overlay-complete',
    ownership: UNAVAILABLE,
    deletedHandlerSymbols: new Set<string>(),
    handlerFiles: new Map<string, string>(),
    downstreamTruncated: false,
    ...overrides,
  };
}

describe('resolveGateCategories (spec 14 Part B)', () => {
  it('defaults to ["overlay-not-complete"] with neither --fail-on nor config', () => {
    expect(resolveGateCategories(undefined, undefined)).toEqual([...DEFAULT_CHECK_GATES]);
  });

  it('--fail-on overrides lux.yaml delta.gates', () => {
    expect(resolveGateCategories(['budget-truncated'], ['overlay-not-complete'])).toEqual([
      'budget-truncated',
    ]);
  });

  it('falls back to config gates when --fail-on is absent', () => {
    expect(resolveGateCategories(undefined, ['client-gap-created'])).toEqual([
      'client-gap-created',
    ]);
  });

  it('dedups repeated categories', () => {
    expect(
      resolveGateCategories(
        ['budget-truncated', 'budget-truncated', 'overlay-not-complete'],
        undefined
      )
    ).toEqual(['budget-truncated', 'overlay-not-complete']);
  });

  it('hard-errors (config-error) on an unknown token from --fail-on', () => {
    const res = resolveGateCategories(['not-a-category'], undefined);
    expect(isRefusal(res)).toBe(true);
    if (isRefusal(res)) {
      expect(res.reason).toBe('config-error');
      expect(res.message).toContain('not-a-category');
    }
  });

  it('hard-errors on an unknown token from lux.yaml delta.gates (same check)', () => {
    const res = resolveGateCategories(undefined, ['overlay-not-complete', 'bogus']);
    expect(isRefusal(res)).toBe(true);
    if (isRefusal(res)) expect(res.reason).toBe('config-error');
  });

  it('accepts every KNOWN_GATE_CATEGORIES member', () => {
    const res = resolveGateCategories([...KNOWN_GATE_CATEGORIES], undefined);
    expect(isRefusal(res)).toBe(false);
  });
});

describe('evaluateGates (spec 14 Part B)', () => {
  it('passes (exit 0) when no active gate produces a violation', () => {
    const result = evaluateGates(inputs({ categories: ['overlay-not-complete'] }));
    expect(result).toEqual({ mode: 'check', exitCode: 0, violations: [] });
  });

  it('fires overlay-not-complete on a degraded trust level', () => {
    const result = evaluateGates(
      inputs({ categories: ['overlay-not-complete'], trustLevel: 'degraded-overlay' })
    );
    expect(result.exitCode).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].category).toBe('overlay-not-complete');
  });

  it('fires budget-truncated when downstreamTruncated is set', () => {
    const result = evaluateGates(
      inputs({ categories: ['budget-truncated'], downstreamTruncated: true })
    );
    expect(result.exitCode).toBe(1);
    expect(result.violations[0].category).toBe('budget-truncated');
  });

  it('does not fire budget-truncated when the category is inactive', () => {
    const result = evaluateGates(inputs({ categories: [], downstreamTruncated: true }));
    expect(result.exitCode).toBe(0);
  });

  it('fires client-gap-created on a deleted client-override handler (with evidence.file)', () => {
    const ownership: OwnershipProjection = {
      kernelConfigured: true,
      kernelResolved: true,
      source: 'cross-area-recompute',
      kernelDrift: { indexedCommit: 'abc', headCommit: 'abc', stale: false },
      transitions: [
        { route: 'surface:http:GET:/k2', label: 'client-override', changedHandler: 'sym:App\\C2' },
      ],
    };
    const result = evaluateGates(
      inputs({
        categories: ['client-gap-created'],
        ownership,
        deletedHandlerSymbols: new Set(['sym:App\\C2']),
        handlerFiles: new Map([['sym:App\\C2', 'app/Http/C2.php']]),
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.violations[0]).toMatchObject({
      category: 'client-gap-created',
      subject: 'surface:http:GET:/k2',
      evidence: { file: 'app/Http/C2.php' },
    });
  });

  it('does not fire client-gap-created for a client-override handler that was NOT deleted', () => {
    const ownership: OwnershipProjection = {
      kernelConfigured: true,
      kernelResolved: true,
      source: 'cross-area-recompute',
      kernelDrift: null,
      transitions: [
        { route: 'surface:http:GET:/k2', label: 'client-override', changedHandler: 'sym:App\\C2' },
      ],
    };
    const result = evaluateGates(inputs({ categories: ['client-gap-created'], ownership }));
    expect(result.exitCode).toBe(0);
  });

  it('FAILS LOUD when client-gap-created is active but the kernel is unconfigured', () => {
    const result = evaluateGates(
      inputs({ categories: ['client-gap-created'], ownership: UNAVAILABLE })
    );
    expect(result.exitCode).toBe(1);
    expect(result.violations[0]).toMatchObject({
      category: 'client-gap-created',
      subject: 'overlay.kernel',
    });
  });

  it('FAILS LOUD when client-gap-created is active but the kernel is unresolved (stale/unindexed)', () => {
    const ownership: OwnershipProjection = {
      kernelConfigured: true,
      kernelResolved: false,
      source: 'unavailable',
      kernelDrift: null,
      transitions: [],
      warning: 'kernel index unresolvable',
    };
    const result = evaluateGates(inputs({ categories: ['client-gap-created'], ownership }));
    expect(result.exitCode).toBe(1);
    expect(result.violations[0]).toMatchObject({
      category: 'client-gap-created',
      subject: 'kernel',
    });
    expect(result.violations[0].detail).toContain('kernel index unresolvable');
  });

  it('FAILS LOUD when a Phase-4 gate is active with no baselineDiff', () => {
    for (const cat of ['boundary-edge-added', 'surface-removed'] as const) {
      const result = evaluateGates(inputs({ categories: [cat] }));
      expect(result.exitCode).toBe(1);
      expect(result.violations[0]).toMatchObject({ category: cat, subject: 'baseline' });
    }
  });

  it('fires surface-removed / boundary-edge-added from a provided baselineDiff', () => {
    const baselineDiff: BaselineDiff = {
      surfacesRemoved: ['surface:http:GET:/gone'],
      surfacesAdded: [],
      crossModuleEdgesAdded: [{ source: 'A', target: 'B', edgeType: 'calls' }],
    };
    const removed = evaluateGates(inputs({ categories: ['surface-removed'], baselineDiff }));
    expect(removed.violations.map((v) => v.subject)).toEqual(['surface:http:GET:/gone']);

    const added = evaluateGates(inputs({ categories: ['boundary-edge-added'], baselineDiff }));
    expect(added.violations.map((v) => v.subject)).toEqual(['A->B']);
  });

  it('accumulates violations across categories; exitCode is 1 iff >= 1 violation', () => {
    const result = evaluateGates(
      inputs({
        categories: ['overlay-not-complete', 'budget-truncated'],
        trustLevel: 'content-only',
        downstreamTruncated: true,
      })
    );
    expect(result.violations).toHaveLength(2);
    expect(result.exitCode).toBe(1);
    expect(new Set(result.violations.map((v) => v.category))).toEqual(
      new Set(['overlay-not-complete', 'budget-truncated'])
    );
  });
});
