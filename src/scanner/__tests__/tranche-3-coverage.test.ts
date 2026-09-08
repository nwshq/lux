import { describe, expect, it } from 'vitest';
import { deriveCapability } from '../coverage/index.js';
describe('Tranche3 coverage states', () => {
  it('distinguishes active partial unsupported and not-applicable', () => {
    expect(
      deriveCapability({
        producer: 'framework',
        candidates: 1,
        configured: true,
        ran: true,
        failures: 0,
        nodes: 1,
        edges: 1,
        documentedSubset: false,
      }).state
    ).toBe('active');
    expect(
      deriveCapability({
        producer: 'framework',
        candidates: 1,
        configured: true,
        ran: true,
        failures: 1,
        nodes: 1,
        edges: 0,
        documentedSubset: false,
      }).state
    ).toBe('partial');
    expect(
      deriveCapability({
        producer: 'framework',
        candidates: 1,
        configured: false,
        ran: false,
        failures: 0,
        nodes: 0,
        edges: 0,
        documentedSubset: false,
      }).state
    ).toBe('unsupported');
    expect(
      deriveCapability({
        producer: 'framework',
        candidates: 0,
        configured: false,
        ran: false,
        failures: 0,
        nodes: 0,
        edges: 0,
        documentedSubset: false,
      }).state
    ).toBe('not_applicable');
  });
});
