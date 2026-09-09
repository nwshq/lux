import { posix } from 'node:path';
import type { StructuralNode } from '../../../db/types.js';
import type { StructuralRelationEdge } from '../../associations/types.js';
import type { SourceLocationV1 } from '../../contracts/program.js';
import {
  lambdaHandlerId,
  terraformModuleId,
  terraformProviderId,
  terraformRemoteStateId,
  terraformResourceId,
} from '../../identity/program-identity.js';
import { frameworkEdge } from '../../react/edge-factory.js';
import type {
  InfrastructureFactV1,
  HclAttributeFactV1,
  HclBlockFactV1,
  HclTraversalFactV1,
} from '../../adapters/infrastructure-types.js';

export interface TerraformGraphV1 {
  nodes: StructuralNode[];
  edges: StructuralRelationEdge[];
  diagnostics: Array<{ code: string; message: string }>;
}

/** Resolve only declaration-backed, same-module or literal-local-module Terraform relationships. */
export function resolveTerraformGraph(
  facts: readonly InfrastructureFactV1[],
  now = 0
): TerraformGraphV1 {
  const blocks = facts.filter((fact): fact is HclBlockFactV1 => fact.family === 'hcl-block');
  const attributes = facts.filter(
    (fact): fact is HclAttributeFactV1 => fact.family === 'hcl-attribute'
  );
  const traversals = facts.filter(
    (fact): fact is HclTraversalFactV1 => fact.family === 'hcl-traversal'
  );
  const nodes = new Map<string, StructuralNode>();
  const edges = new Map<string, StructuralRelationEdge>();
  const diagnostics: Array<{ code: string; message: string }> = [];
  const declarations = new Map<string, { id: string; address: string; fact: HclBlockFactV1 }>();
  const attributesByOwner = groupAttributes(attributes);

  for (const block of blocks) {
    const modulePath = dirnameOf(block.filePath);
    const moduleId = terraformModuleId(modulePath);
    nodes.set(moduleId, artifactNode(moduleId, modulePath, 'terraform-module', now));

    if (block.blockKind === 'locals') {
      for (const attribute of attributesByOwner.get(block.localId) ?? []) {
        const address = `local.${attribute.name}`;
        const id = terraformResourceId(modulePath, address);
        nodes.set(id, artifactNode(id, block.filePath, 'terraform-local', now, address));
        declarations.set(`${modulePath}\0${address}`, { id, address, fact: block });
        addEdge(edges, 'declares_resource', moduleId, id, [block.range, attribute.range]);
      }
      continue;
    }

    const address = addressOf(block);
    if (!address) continue;
    let id = terraformResourceId(modulePath, address);
    let symbolKind = kindOf(block);

    if (block.blockKind === 'provider') {
      const values = attributesByOwner.get(block.localId) ?? [];
      const alias = staticAttribute(values, 'alias') ?? 'default';
      const source = staticAttribute(values, 'source') ?? block.labels[0] ?? 'unknown';
      id = terraformProviderId(source, alias);
      symbolKind = 'terraform-provider';
    }

    if (block.blockKind === 'data' && block.labels[0] === 'terraform_remote_state') {
      const values = attributesByOwner.get(block.localId) ?? [];
      const backend = staticAttribute(values, 'backend');
      const key = staticAttribute(values, 'key');
      if (backend && key) {
        id = terraformRemoteStateId(backend, key);
        symbolKind = 'terraform-remote-state';
      }
    }

    nodes.set(id, artifactNode(id, block.filePath, symbolKind, now, address));
    declarations.set(`${modulePath}\0${address}`, { id, address, fact: block });
    declarations.set(`${modulePath}\0${block.localId}`, { id, address, fact: block });
    addEdge(edges, 'declares_resource', moduleId, id, [block.range]);

    if (block.blockKind === 'module') {
      const source = staticAttribute(attributesByOwner.get(block.localId) ?? [], 'source');
      if (source?.startsWith('./') || source?.startsWith('../')) {
        const childPath = posix.normalize(posix.join(modulePath || '.', source));
        if (childPath !== '..' && !childPath.startsWith('../')) {
          const childId = terraformModuleId(childPath === '.' ? '' : childPath);
          nodes.set(childId, artifactNode(childId, childPath, 'terraform-module', now));
          addEdge(edges, 'references_resource', id, childId, [block.range]);
        } else diagnostics.push({ code: 'terraform-module-path-escape', message: source });
      }
    }

    if (block.blockKind === 'resource' && block.labels[0] === 'aws_lambda_function') {
      const values = attributesByOwner.get(block.localId) ?? [];
      const runtime = staticAttribute(values, 'runtime');
      const handler = staticAttribute(values, 'handler');
      const filename = staticAttribute(values, 'filename');
      if (runtime && handler && filename) {
        const handlerId = lambdaHandlerId(runtime, handler);
        nodes.set(
          handlerId,
          artifactNode(handlerId, block.filePath, 'lambda-handler', now, handler)
        );
        addEdge(edges, 'references_resource', id, handlerId, [block.range]);
      }
    }
  }

  for (const traversal of traversals) {
    const modulePath = dirnameOf(traversal.filePath);
    const owner = declarations.get(`${modulePath}\0${traversal.ownerLocalId}`);
    const target = traversal.baseAddress
      ? declarations.get(`${modulePath}\0${traversal.baseAddress}`)
      : undefined;
    if (owner && target && owner.id !== target.id) {
      addEdge(edges, 'references_resource', owner.id, target.id, [traversal.range]);
    }
  }

  return {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics,
  };
}

function groupAttributes(facts: readonly HclAttributeFactV1[]) {
  const grouped = new Map<string, HclAttributeFactV1[]>();
  for (const fact of facts)
    grouped.set(fact.ownerLocalId, [...(grouped.get(fact.ownerLocalId) ?? []), fact]);
  return grouped;
}
function staticAttribute(facts: readonly HclAttributeFactV1[], name: string) {
  const matches = facts.filter((fact) => fact.name === name && fact.staticString !== undefined);
  return matches.length === 1 ? matches[0].staticString : undefined;
}
function dirnameOf(path: string) {
  const directory = posix.dirname(path);
  return directory === '.' ? '' : directory;
}
function addressOf(block: HclBlockFactV1): string | undefined {
  const labels = block.labels;
  if (block.blockKind === 'resource' && labels.length >= 2) return `${labels[0]}.${labels[1]}`;
  if (block.blockKind === 'data' && labels.length >= 2) return `data.${labels[0]}.${labels[1]}`;
  if (block.blockKind === 'variable' && labels[0]) return `var.${labels[0]}`;
  if (block.blockKind === 'output' && labels[0]) return `output.${labels[0]}`;
  if (block.blockKind === 'module' && labels[0]) return `module.${labels[0]}`;
  if (block.blockKind === 'provider' && labels[0]) return `provider.${labels[0]}`;
  return undefined;
}
function kindOf(block: HclBlockFactV1) {
  if (block.blockKind === 'data') return 'terraform-data';
  if (block.blockKind === 'variable') return 'terraform-variable';
  if (block.blockKind === 'output') return 'terraform-output';
  if (block.blockKind === 'provider') return 'terraform-provider';
  if (block.blockKind === 'module') return 'terraform-module-call';
  return 'terraform-resource';
}
function artifactNode(
  id: string,
  file_path: string,
  symbol_kind: string,
  updated_at: number,
  symbol_name?: string
): StructuralNode {
  return {
    id,
    node_type: 'artifact',
    file_path,
    language_id: 'hcl',
    symbol_kind,
    symbol_name,
    origin: 'local',
    updated_at,
  };
}
function addEdge(
  edges: Map<string, StructuralRelationEdge>,
  edgeType: 'declares_resource' | 'references_resource',
  sourceNodeId: string,
  targetNodeId: string,
  locations: SourceLocationV1[]
) {
  const edge = frameworkEdge({
    resolver: 'terraform-static',
    edgeType,
    sourceNodeId,
    targetNodeId,
    sourceLanguage: 'hcl',
    targetLanguage: 'hcl',
    confidence: 1,
    confidenceClass: 'artifact-backed',
    evidenceKind: 'terraform-static-fact',
    locations,
  });
  edges.set(edge.id, edge);
}
