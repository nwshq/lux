import { describe, expect, it } from 'vitest';
import { deriveCapability } from '../index.js';

const ACTIVE_INPUT = {
  producer: 'tree-sitter-typescript',
  candidates: 3,
  configured: true,
  ran: true,
  failures: 0,
  nodes: 7,
  edges: 4,
  documentedSubset: false,
} as const;

describe('deriveCapability', () => {
  it('reports no candidates as not applicable when no producer is configured', () => {
    expect(
      deriveCapability({
        ...ACTIVE_INPUT,
        candidates: 0,
        configured: false,
        ran: false,
        nodes: 0,
        edges: 0,
      })
    ).toEqual({
      state: 'not_applicable',
      producer: 'tree-sitter-typescript',
      nodes: 0,
      edges: 0,
      failures: 0,
      reason: 'no applicable candidates',
    });
  });

  it('reports candidates without a configured producer as unsupported', () => {
    expect(deriveCapability({ ...ACTIVE_INPUT, configured: false, ran: false })).toMatchObject({
      state: 'unsupported',
      reason: 'no producer configured',
    });
  });

  it('reports a configured producer that did not run as failed', () => {
    expect(deriveCapability({ ...ACTIVE_INPUT, ran: false })).toMatchObject({
      state: 'failed',
      reason: 'configured producer did not run',
    });
  });

  it('reports producer failures as partial and preserves emitted counts', () => {
    expect(deriveCapability({ ...ACTIVE_INPUT, failures: 2 })).toEqual({
      state: 'partial',
      producer: 'tree-sitter-typescript',
      nodes: 7,
      edges: 4,
      failures: 2,
      reason: '2 producer failure(s)',
    });
  });

  it('reports a documented subset as partial', () => {
    expect(deriveCapability({ ...ACTIVE_INPUT, documentedSubset: true })).toMatchObject({
      state: 'partial',
      reason: 'documented subset',
    });
  });

  it('reports applicable candidates with zero structural output as partial', () => {
    expect(deriveCapability({ ...ACTIVE_INPUT, nodes: 0, edges: 0 })).toMatchObject({
      state: 'partial',
      reason: 'applicable candidates produced no structural output',
    });
  });

  it('reports a successful producer with structural output as active without a reason', () => {
    const result = deriveCapability(ACTIVE_INPUT);

    expect(result).toEqual({
      state: 'active',
      producer: 'tree-sitter-typescript',
      nodes: 7,
      edges: 4,
      failures: 0,
    });
    expect(result).not.toHaveProperty('reason');
  });

  it('applies configured and ran precedence before partial reasons', () => {
    expect(
      deriveCapability({
        ...ACTIVE_INPUT,
        configured: false,
        ran: false,
        failures: 2,
        documentedSubset: true,
        nodes: 0,
        edges: 0,
      })
    ).toMatchObject({ state: 'unsupported', reason: 'no producer configured' });

    expect(
      deriveCapability({
        ...ACTIVE_INPUT,
        ran: false,
        failures: 2,
        documentedSubset: true,
        nodes: 0,
        edges: 0,
      })
    ).toMatchObject({ state: 'failed', reason: 'configured producer did not run' });
  });

  it('prioritizes failures, then documented subset, then zero output', () => {
    expect(
      deriveCapability({
        ...ACTIVE_INPUT,
        failures: 2,
        documentedSubset: true,
        nodes: 0,
        edges: 0,
      })
    ).toMatchObject({ reason: '2 producer failure(s)' });

    expect(
      deriveCapability({
        ...ACTIVE_INPUT,
        documentedSubset: true,
        nodes: 0,
        edges: 0,
      })
    ).toMatchObject({ reason: 'documented subset' });
  });

  it.each(['candidates', 'failures', 'nodes', 'edges'] as const)(
    'rejects invalid %s counts rather than reporting untruthful evidence',
    (field) => {
      for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        expect(() => deriveCapability({ ...ACTIVE_INPUT, [field]: value })).toThrow(
          new RangeError(`${field} must be a non-negative safe integer`)
        );
      }
    }
  );
});
