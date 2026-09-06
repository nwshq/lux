// Framework resolver pack — exports the default framework-aware resolvers.
//
// Import this module to get all built-in framework resolvers as an array
// suitable for passing to AssociationEngine.

export { LaravelBoundaryEvidenceResolver } from './laravel-boundary-evidence.js';

import { LaravelBoundaryEvidenceResolver } from './laravel-boundary-evidence.js';
import {
  VueComponentAssociationResolver,
  VueComposableAssociationResolver,
  VueStoreAssociationResolver,
  VueEventAssociationResolver,
} from '../../vue/association-wrapper.js';
import { InertiaAssociationResolver } from './laravel/inertia-resolver.js';
import type { FrontendFrameworkConfigV1 } from '../../config.js';
import type { AssociationResolver } from '../types.js';

/**
 * Returns all built-in framework resolver instances.
 * Pass the result to AssociationEngine to run the full default pack.
 */
export function createDefaultResolvers(
  frameworks?: FrontendFrameworkConfigV1
): AssociationResolver[] {
  return [
    new LaravelBoundaryEvidenceResolver(),
    new VueComponentAssociationResolver(),
    new VueComposableAssociationResolver(),
    new VueStoreAssociationResolver(),
    new VueEventAssociationResolver(),
    new InertiaAssociationResolver({
      config: frameworks
        ? {
            pageRoots: frameworks.inertia.pageRoots,
            namespaces: frameworks.inertia.namespaces,
            sourceFile: 'lux.yaml',
          }
        : undefined,
    }),
  ];
}
