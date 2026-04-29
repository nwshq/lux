// Tests for tranche-one feature-path contract summarization.

import { describe, it, expect } from 'vitest';
import type { FeaturePath } from '../../surface-retrieval.js';
import type { StructuralNode } from '../../../../db/types.js';
import type { TransportContractMetadata } from '../../types.js';
import { buildContractDirectEvidence, summarizeFeaturePathContracts } from '../contracts.js';

function makeNode(
  id: string,
  symbolName: string,
  meta: Partial<TransportContractMetadata> & {
    contractKind: TransportContractMetadata['contractKind'];
  },
  filePath?: string
): StructuralNode {
  const node: StructuralNode = {
    id,
    node_type: 'contract',
    symbol_name: symbolName,
    language_id: 'php',
    metadata: JSON.stringify({
      transport: 'http',
      side: 'request',
      shapeConfidence: 'coarse',
      ...meta,
    }),
    updated_at: Math.floor(Date.now() / 1000),
  };
  if (filePath) node.file_path = filePath;
  return node;
}

function makeSurface(id: string): StructuralNode {
  return {
    id,
    node_type: 'capability-surface',
    symbol_name: id,
    language_id: 'http',
    file_path: 'routes/api.php',
    metadata: JSON.stringify({ transport: 'http', method: 'POST', path: '/offers' }),
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function makeFeaturePath(overrides: Partial<FeaturePath> = {}): FeaturePath {
  return {
    surface: makeSurface('surface:http:POST:/offers'),
    consumers: [],
    provenConsumers: [],
    providers: [],
    validators: [],
    responseContracts: [],
    artifacts: [],
    declaringFile: null,
    isClosureBacked: false,
    ...overrides,
  };
}

describe('summarizeFeaturePathContracts', () => {
  it('returns null when no validators, response contracts, or interactionKind exist', () => {
    const result = summarizeFeaturePathContracts(makeFeaturePath());
    expect(result).toBeNull();
  });

  it('returns null when given a null feature path', () => {
    expect(summarizeFeaturePathContracts(null)).toBeNull();
  });

  it('summarizes an exact request validator with shapeConfidence and contractKind', () => {
    const requestNode = makeNode('contract:schema:StoreOfferRequest', 'StoreOfferRequest', {
      contractKind: 'explicit-class',
      shapeConfidence: 'exact',
      side: 'request',
    });
    const result = summarizeFeaturePathContracts(makeFeaturePath({ validators: [requestNode] }));
    expect(result?.request?.label).toBe('exact(StoreOfferRequest)');
    expect(result?.request?.shapeConfidence).toBe('exact');
    expect(result?.request?.contractKind).toBe('explicit-class');
    expect(result?.request?.nodeId).toBe('contract:schema:StoreOfferRequest');
  });

  it('summarizes an exact response contract', () => {
    const responseNode = makeNode(
      'contract:schema:OfferResource',
      'OfferResource',
      { contractKind: 'explicit-class', shapeConfidence: 'exact', side: 'response' },
      'app/Http/Resources/OfferResource.php'
    );
    const result = summarizeFeaturePathContracts(
      makeFeaturePath({ responseContracts: [responseNode] })
    );
    expect(result?.response?.label).toBe('exact(OfferResource)');
    expect(result?.response?.filePath).toBe('app/Http/Resources/OfferResource.php');
  });

  it('picks the best-scoring contract when multiple candidates exist', () => {
    // empty-ack scores 1, explicit-class scores 5
    const weak = makeNode('contract:weak', 'weak', {
      contractKind: 'empty-ack',
      shapeConfidence: 'coarse',
      side: 'response',
    });
    const strong = makeNode('contract:strong', 'OfferResource', {
      contractKind: 'explicit-class',
      shapeConfidence: 'exact',
      side: 'response',
    });
    const result = summarizeFeaturePathContracts(
      makeFeaturePath({ responseContracts: [weak, strong] })
    );
    expect(result?.response?.nodeId).toBe('contract:strong');
  });

  it('extracts interactionKind when contracts carry it', () => {
    const responseNode = makeNode('contract:page', 'PageResponse', {
      contractKind: 'page-response',
      shapeConfidence: 'coarse',
      side: 'response',
      interactionKind: 'page',
    });
    const result = summarizeFeaturePathContracts(
      makeFeaturePath({ responseContracts: [responseNode] })
    );
    expect(result?.interactionKind).toBe('page');
  });
});

describe('buildContractDirectEvidence', () => {
  it('returns an empty array for a null feature path', () => {
    expect(buildContractDirectEvidence(null)).toEqual([]);
  });

  it('returns an empty array when no contracts are recovered', () => {
    expect(buildContractDirectEvidence(makeFeaturePath())).toEqual([]);
  });

  it('emits validator-attachment with tier 4 for an exact request validator', () => {
    const requestNode = makeNode('contract:schema:StoreOfferRequest', 'StoreOfferRequest', {
      contractKind: 'explicit-class',
      shapeConfidence: 'exact',
      side: 'request',
    });
    const items = buildContractDirectEvidence(makeFeaturePath({ validators: [requestNode] }));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('validator-attachment');
    expect(items[0].trustTier).toBe(4);
    expect(items[0].confidenceClass).toBe('artifact-backed');
    expect(items[0].description).toContain('StoreOfferRequest');
  });

  it('emits response-contract with tier 3 for a coarse response contract', () => {
    const responseNode = makeNode('contract:empty', 'empty', {
      contractKind: 'empty-ack',
      shapeConfidence: 'coarse',
      side: 'response',
    });
    const items = buildContractDirectEvidence(
      makeFeaturePath({ responseContracts: [responseNode] })
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('response-contract');
    expect(items[0].trustTier).toBe(3);
    expect(items[0].confidenceClass).toBe('framework-inferred');
  });

  it('emits both validator and response evidence when both are present', () => {
    const requestNode = makeNode('contract:req', 'StoreOfferRequest', {
      contractKind: 'explicit-class',
      shapeConfidence: 'exact',
      side: 'request',
    });
    const responseNode = makeNode('contract:res', 'OfferResource', {
      contractKind: 'explicit-class',
      shapeConfidence: 'exact',
      side: 'response',
    });
    const items = buildContractDirectEvidence(
      makeFeaturePath({ validators: [requestNode], responseContracts: [responseNode] })
    );
    expect(items.map((item) => item.kind).sort()).toEqual([
      'response-contract',
      'validator-attachment',
    ]);
  });
});
