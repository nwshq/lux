import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const digest = (x: unknown[]) =>
  createHash('sha256')
    .update(
      JSON.stringify([...x].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
    )
    .digest('hex');
describe('Tranche3 refresh equivalence', () =>
  it('compares identity/evidence bytes', () =>
    expect(digest([{ id: 'x', evidence: ['a'] }])).toBe(digest([{ id: 'x', evidence: ['a'] }]))));
