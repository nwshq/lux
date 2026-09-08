import type { ProjectResolutionContextV1, SourceDiagnosticV1 } from '../contracts/program.js';
import type { StructuralRelationEdge } from '../associations/types.js';
import { resolveReactComponents } from './components.js';
import { resolveReactContexts } from './context.js';
import { resolveReactHooks } from './hooks.js';
import type { FrameworkNodeV1, ReactFactV1, ReactRelationshipResolverV1 } from './types.js';

/** Compose the component, custom-hook, and context relationship leaves. */
export class ReactRelationshipResolver implements ReactRelationshipResolverV1 {
  resolve(
    facts: readonly ReactFactV1[],
    project: ProjectResolutionContextV1
  ): Promise<{
    nodes: FrameworkNodeV1[];
    edges: StructuralRelationEdge[];
    diagnostics: SourceDiagnosticV1[];
  }> {
    const parts = [
      resolveReactComponents(facts, project),
      resolveReactHooks(facts, project),
      resolveReactContexts(facts, project),
    ];
    return Promise.resolve({
      nodes: uniqueById(parts.flatMap((part) => part.nodes)),
      edges: uniqueById(parts.flatMap((part) => part.edges)),
      diagnostics: parts.flatMap((part) => part.diagnostics),
    });
  }
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  const result = new Map<string, T>();
  for (const value of values) if (!result.has(value.id)) result.set(value.id, value);
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}
