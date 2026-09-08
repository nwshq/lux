import { describe, expect, it } from 'vitest';
import { identitySnapshot } from '../identity-snapshot.js';
import { scopedEqualsFull } from '../scoped-refresh.js';
describe('Tranche3 identity gate', () => {
  it('is order independent and detects differences', () => {
    const a = [{ id: 'b' }, { id: 'a', evidence: ['z', 'a'] }];
    expect(identitySnapshot(a).digest).toBe(identitySnapshot([...a].reverse()).digest);
    expect(scopedEqualsFull(a, a)).toBe(true);
    expect(scopedEqualsFull(a, [{ id: 'a' }])).toBe(false);
  });
});
