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
import { LivewireAssociationResolver } from './laravel/livewire-resolver.js';
import { NovaAssociationResolver } from './laravel/nova-resolver.js';
import { ReactAssociationResolver } from '../../react/association-wrapper.js';
import type { FrontendFrameworkConfigV1 } from '../../config.js';
import type { AssociationResolver } from '../types.js';

/**
 * Returns all built-in framework resolver instances.
 * Pass the result to AssociationEngine to run the full default pack.
 */
export function createDefaultResolvers(
  frameworks?: FrontendFrameworkConfigV1,
  options: { firstPartyRoots?: readonly string[] } = {}
): AssociationResolver[] {
  const resolvers: AssociationResolver[] = [
    new LaravelBoundaryEvidenceResolver(),
    new VueComponentAssociationResolver(),
    new VueComposableAssociationResolver(),
    new VueStoreAssociationResolver(),
    new VueEventAssociationResolver(),
    new ReactAssociationResolver(),
    new InertiaAssociationResolver({
      config: frameworks
        ? {
            pageRoots: frameworks.inertia.pageRoots,
            namespaces: frameworks.inertia.namespaces,
            sourceFile: 'lux.yaml',
          }
        : undefined,
    }),
    new LivewireAssociationResolver({
      config: frameworks
        ? {
            classRoots: frameworks.livewire.classRoots,
            viewRoots: frameworks.livewire.viewRoots,
            viewNamespaces: frameworks.livewire.viewNamespaces,
          }
        : undefined,
    }),
  ];
  // Keep established precedence intact: Nova is an opt-in tail resolver after Livewire.
  if (frameworks?.nova.enabled) {
    resolvers.push(new NovaAssociationResolver({ firstPartyRoots: options.firstPartyRoots }));
  }
  return resolvers;
}
