// Tranche-one contract summarization for feature-path answers.
//
// Pulls the validators and response contracts that surface-retrieval already
// recovers and produces a `FeaturePathContracts` block. We reuse the existing
// label/score helpers exported from surface-retrieval so the contract surface
// stays in lockstep with the rest of Lux's contract vocabulary (T6, R3, R9).

import type { ConfidenceClass, StructuralNode, TrustTier } from '../../../db/types.js';
import {
  formatContractLabel,
  inferSurfaceInteractionKind,
  parseContractMeta,
  scoreContract,
  type FeaturePath,
} from '../surface-retrieval.js';
import type {
  FeaturePathContractFragment,
  FeaturePathContracts,
  FeaturePathDirectEvidenceItem,
} from './contract.js';

/**
 * Pick the strongest contract for display. surface-retrieval already sorts
 * validators and responseContracts by score, so the first element is the
 * preferred candidate, but we re-score defensively to stay correct if a caller
 * passes an unsorted list.
 */
function pickBestContract(nodes: StructuralNode[]): StructuralNode | null {
  if (nodes.length === 0) return null;
  let best = nodes[0];
  let bestScore = scoreContract(best);
  for (const node of nodes.slice(1)) {
    const score = scoreContract(node);
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function toFragment(node: StructuralNode): FeaturePathContractFragment {
  const meta = parseContractMeta(node);
  const fragment: FeaturePathContractFragment = {
    label: formatContractLabel(node),
    nodeId: node.id,
  };
  if (meta?.contractKind) fragment.contractKind = meta.contractKind;
  if (meta?.shapeConfidence) fragment.shapeConfidence = meta.shapeConfidence;
  if (node.file_path) fragment.filePath = node.file_path;
  return fragment;
}

/**
 * Summarize the request, response, and interactionKind contracts that the
 * structural overlay has already recovered for this feature path.
 *
 * Returns `null` when nothing structurally recoverable exists — the assembler
 * uses that as the trigger for the `insufficient-contract-recovery` failure
 * when the question implied a contract dimension.
 */
export function summarizeFeaturePathContracts(
  featurePath: FeaturePath | null
): FeaturePathContracts | null {
  if (!featurePath) return null;

  const bestRequest = pickBestContract(featurePath.validators);
  const bestResponse = pickBestContract(featurePath.responseContracts);
  const interactionKind = inferSurfaceInteractionKind(
    featurePath.validators,
    featurePath.responseContracts
  );

  if (!bestRequest && !bestResponse && !interactionKind) return null;

  const summary: FeaturePathContracts = {};
  if (bestRequest) summary.request = toFragment(bestRequest);
  if (bestResponse) summary.response = toFragment(bestResponse);
  if (interactionKind) summary.interactionKind = interactionKind;
  return summary;
}

/**
 * Map a contract's shapeConfidence to the direct-evidence trust tier we expose
 * in the answer. Exact contracts are artifact-backed (4); coarse contracts are
 * framework-inferred (3).
 */
function shapeToTrustTier(node: StructuralNode): {
  trustTier: TrustTier;
  confidenceClass: ConfidenceClass;
} {
  const meta = parseContractMeta(node);
  if (meta?.shapeConfidence === 'exact') {
    return { trustTier: 4, confidenceClass: 'artifact-backed' };
  }
  return { trustTier: 3, confidenceClass: 'framework-inferred' };
}

/**
 * Build direct-evidence items for the request validator and response contract
 * recovered for this feature path. These are first-class proof of contract
 * structure for the answer (kinds `validator-attachment` and `response-contract`),
 * and complement the higher-level `FeaturePathContracts` summary block.
 */
export function buildContractDirectEvidence(
  featurePath: FeaturePath | null
): FeaturePathDirectEvidenceItem[] {
  if (!featurePath) return [];

  const items: FeaturePathDirectEvidenceItem[] = [];

  const bestRequest = pickBestContract(featurePath.validators);
  if (bestRequest) {
    const { trustTier, confidenceClass } = shapeToTrustTier(bestRequest);
    items.push({
      kind: 'validator-attachment',
      description: `Request shape recovered: ${formatContractLabel(bestRequest)}`,
      nodeId: bestRequest.id,
      ...(bestRequest.file_path ? { filePath: bestRequest.file_path } : {}),
      trustTier,
      confidenceClass,
    });
  }

  const bestResponse = pickBestContract(featurePath.responseContracts);
  if (bestResponse) {
    const { trustTier, confidenceClass } = shapeToTrustTier(bestResponse);
    items.push({
      kind: 'response-contract',
      description: `Response shape recovered: ${formatContractLabel(bestResponse)}`,
      nodeId: bestResponse.id,
      ...(bestResponse.file_path ? { filePath: bestResponse.file_path } : {}),
      trustTier,
      confidenceClass,
    });
  }

  return items;
}
