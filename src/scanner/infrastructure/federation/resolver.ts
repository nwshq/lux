import type { FederationExportV1, FederationMappingV1, MappedFederationEdgeV1 } from './types.js';
const ELIGIBLE =
  /^(?:package:npm:|artifact:(?:container-image|lambda-handler):|resource:terraform:)/u;
interface FederationResolverInput {
  exportsByRepo: ReadonlyMap<string, readonly FederationExportV1[]>;
  mappings: readonly FederationMappingV1[];
  nodeExists(repo: string, id: string): boolean;
  evidenceExists(repo: string, path: string): boolean;
  repositoryState?: ReadonlyMap<
    string,
    { commit: string; schemaVersion: number; configFingerprint: string; clean: boolean }
  >;
}
export function resolveInfrastructureFederation(input: FederationResolverInput): {
  edges: MappedFederationEdgeV1[];
  diagnostics: string[];
} {
  const edges: MappedFederationEdgeV1[] = [],
    diagnostics: string[] = [];
  const mappingGroups = new Map<string, FederationMappingV1[]>();
  for (const mapping of input.mappings) {
    const key = [
      mapping.fromRepo,
      mapping.fromId,
      mapping.toRepo,
      mapping.toId,
      mapping.edgeType,
    ].join('\0');
    mappingGroups.set(key, [...(mappingGroups.get(key) ?? []), mapping]);
  }
  const graph = new Map<string, string[]>();
  for (const [key, group] of mappingGroups) {
    if (group.length !== 1) {
      diagnostics.push('duplicate-mapping');
      continue;
    }
    const mapping = group[0];
    if (
      !safeEvidence(mapping.evidenceFile) ||
      !input.evidenceExists(mapping.fromRepo, mapping.evidenceFile)
    ) {
      diagnostics.push('mapping-evidence-invalid');
      continue;
    }
    if (
      !input.nodeExists(mapping.fromRepo, mapping.fromId) ||
      !input.nodeExists(mapping.toRepo, mapping.toId)
    ) {
      diagnostics.push('mapping-endpoint-missing');
      continue;
    }
    const sourceKey = `${mapping.fromRepo}\0${mapping.fromId}`,
      targetKey = `${mapping.toRepo}\0${mapping.toId}`;
    graph.set(sourceKey, [...(graph.get(sourceKey) ?? []), targetKey]);
    if (reachable(graph, targetKey, sourceKey)) {
      graph.set(
        sourceKey,
        (graph.get(sourceKey) ?? []).filter((x) => x !== targetKey)
      );
      diagnostics.push('mapping-cycle');
      continue;
    }
    edges.push({
      schemaVersion: 1,
      source: { repo: mapping.fromRepo, id: mapping.fromId },
      target: { repo: mapping.toRepo, id: mapping.toId },
      edgeType: mapping.edgeType,
      confidenceClass: 'artifact-backed',
      authorization: 'explicit-mapping',
      evidence: [{ repo: mapping.fromRepo, filePath: mapping.evidenceFile }],
    });
    void key;
  }
  const repositories = [...input.exportsByRepo];
  for (let left = 0; left < repositories.length; left++)
    for (let right = left + 1; right < repositories.length; right++) {
      const [leftRepo, leftExports] = repositories[left],
        [rightRepo, rightExports] = repositories[right];
      const rightById = new Map(rightExports.map((entry) => [entry.id, entry]));
      for (const source of leftExports) {
        const target = rightById.get(source.id);
        if (
          !target ||
          !validExport(leftRepo, source, input) ||
          !validExport(rightRepo, target, input) ||
          !eligibleExact(source.id)
        )
          continue;
        edges.push({
          schemaVersion: 1,
          source: { repo: leftRepo, id: source.id },
          target: { repo: rightRepo, id: target.id },
          edgeType: 'references_resource',
          confidenceClass: 'artifact-backed',
          authorization: 'mutual-exact-export',
          evidence: [
            { repo: leftRepo, filePath: source.evidenceFile },
            { repo: rightRepo, filePath: target.evidenceFile },
          ],
        });
      }
    }
  return {
    edges: edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    diagnostics,
  };
}
function validExport(repo: string, item: FederationExportV1, input: FederationResolverInput) {
  const state = input.repositoryState?.get(repo);
  return (
    item.schemaVersion === 1 &&
    item.repo === repo &&
    safeEvidence(item.evidenceFile) &&
    input.evidenceExists(repo, item.evidenceFile) &&
    input.nodeExists(repo, item.id) &&
    (!state ||
      (state.clean &&
        item.repoCommit === state.commit &&
        item.indexSchemaVersion === state.schemaVersion &&
        item.configFingerprint === state.configFingerprint))
  );
}
function reachable(
  graph: ReadonlyMap<string, readonly string[]>,
  start: string,
  goal: string,
  seen = new Set<string>()
): boolean {
  if (start === goal) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  return (graph.get(start) ?? []).some((next) => reachable(graph, next, goal, seen));
}
function eligibleExact(id: string) {
  return (
    ELIGIBLE.test(id) &&
    (!id.startsWith('artifact:container-image:') || id.includes('%40sha256%3A'))
  );
}
function safeEvidence(path: string) {
  return (
    !!path &&
    !path.startsWith('/') &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(path) &&
    !path.split(/[\\/]+/u).includes('..') &&
    ![...path].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  );
}
