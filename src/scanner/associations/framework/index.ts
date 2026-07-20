// Framework resolver pack — exports the default framework-aware resolvers.
//
// Import this module to get all built-in framework resolvers as an array
// suitable for passing to AssociationEngine.

export { LaravelBoundaryEvidenceResolver } from './laravel-boundary-evidence.js';

import { LaravelBoundaryEvidenceResolver } from './laravel-boundary-evidence.js';
import type { AssociationResolver } from '../types.js';

/**
 * Returns all built-in framework resolver instances.
 * Pass the result to AssociationEngine to run the full default pack.
 */
export function createDefaultResolvers(): AssociationResolver[] {
  return [new LaravelBoundaryEvidenceResolver()];
}
