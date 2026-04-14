// Framework resolver pack — exports the default framework-aware resolvers.
//
// Import this module to get all built-in framework resolvers as an array
// suitable for passing to AssociationEngine.

export { LaravelRoutesResolver } from './laravel-routes.js';
export { GeneratedTypesResolver } from './generated-types.js';

import { LaravelRoutesResolver } from './laravel-routes.js';
import { GeneratedTypesResolver } from './generated-types.js';
import type { AssociationResolver } from '../types.js';

/**
 * Returns all built-in framework resolver instances.
 * Pass the result to AssociationEngine to run the full default pack.
 */
export function createDefaultResolvers(): AssociationResolver[] {
  return [new LaravelRoutesResolver(), new GeneratedTypesResolver()];
}
