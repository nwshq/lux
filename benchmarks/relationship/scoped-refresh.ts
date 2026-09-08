import { identitySnapshot, type IdentityRowV1 } from './identity-snapshot.js';
export function scopedEqualsFull(scoped: readonly IdentityRowV1[], full: readonly IdentityRowV1[]) {
  return identitySnapshot(scoped).digest === identitySnapshot(full).digest;
}
