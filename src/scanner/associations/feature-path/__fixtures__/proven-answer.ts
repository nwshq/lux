// Reference fixture for a fully-proven feature-path answer.
//
// This fixture is the canonical example of a tranche-one answer for the
// `route-handler` intent on a Laravel-style backend repo. It compiles
// against the FeaturePathAnswer contract and is used by contract tests to
// guard the locked shape; downstream assembly code can also use it as a
// readable reference.

import { FEATURE_PATH_ANSWER_SCHEMA_VERSION, type FeaturePathAnswer } from '../contract.js';

export const provenRouteHandlerAnswer: FeaturePathAnswer = {
  schemaVersion: FEATURE_PATH_ANSWER_SCHEMA_VERSION,
  question: 'what handles POST /offers?',
  intent: 'route-handler',
  overlayTrustLevel: 'overlay-complete',
  resolution: {
    query: 'POST /offers',
    status: 'resolved',
    matchedBy: 'semantic-exact',
    candidates: [
      {
        kind: 'route-surface',
        id: 'surface:http:POST:/offers',
        label: 'POST /offers',
        filePath: 'routes/api.php',
        surfaceMethod: 'POST',
        surfacePath: '/offers',
        routeName: 'offers.store',
        trustTier: 5,
      },
    ],
  },
  target: {
    kind: 'route-surface',
    id: 'surface:http:POST:/offers',
    label: 'POST /offers',
    filePath: 'routes/api.php',
    surfaceMethod: 'POST',
    surfacePath: '/offers',
    routeName: 'offers.store',
    trustTier: 5,
  },
  primaryAnswer: {
    summary: 'POST /offers is handled by OfferController@store and belongs to Listings.',
    confidence: 'high',
  },
  ownership: {
    regionId: 'module:Listings',
    regionName: 'Listings',
    basis: 'module-boundary',
    trustTier: 5,
  },
  contracts: {
    request: {
      label: 'exact(StoreOfferRequest)',
      contractKind: 'explicit-class',
      shapeConfidence: 'exact',
      nodeId: 'symbol:php:App\\Modules\\Listings\\Http\\Requests\\StoreOfferRequest',
      filePath: 'app/Modules/Listings/Http/Requests/StoreOfferRequest.php',
    },
    response: {
      label: 'exact(OfferResource)',
      contractKind: 'explicit-class',
      shapeConfidence: 'exact',
      nodeId: 'symbol:php:App\\Modules\\Listings\\Http\\Resources\\OfferResource',
      filePath: 'app/Modules/Listings/Http/Resources/OfferResource.php',
    },
    interactionKind: 'api',
  },
  directEvidence: [
    {
      kind: 'route-declaration',
      description: 'POST /offers declared in routes/api.php targeting OfferController@store',
      nodeId: 'surface:http:POST:/offers',
      filePath: 'routes/api.php',
      trustTier: 5,
      confidenceClass: 'proven',
    },
    {
      kind: 'handler-recovery',
      description: 'OfferController@store recovered via handled_by from the route surface',
      nodeId: 'symbol:php:App\\Modules\\Listings\\Http\\Controllers\\OfferController@store',
      edgeId: 'edge:handled_by:surface:http:POST:/offers->OfferController@store',
      filePath: 'app/Modules/Listings/Http/Controllers/OfferController.php',
      trustTier: 5,
      confidenceClass: 'proven',
    },
    {
      kind: 'validator-attachment',
      description: 'StoreOfferRequest attached to OfferController@store via validates_with',
      edgeId: 'edge:validates_with:OfferController@store->StoreOfferRequest',
      trustTier: 5,
      confidenceClass: 'artifact-backed',
    },
    {
      kind: 'response-contract',
      description: 'OfferController@store returns OfferResource via returns_contract',
      edgeId: 'edge:returns_contract:OfferController@store->OfferResource',
      trustTier: 4,
      confidenceClass: 'framework-inferred',
    },
  ],
  context: [
    {
      kind: 'nearby-consumer',
      description:
        'OffersClient.create in app/Modules/Listings/Frontend calls a route shaped like /offers; not a proven cross-language association.',
      nodeId: 'symbol:ts:OffersClient.create',
      filePath: 'app/Modules/Listings/Frontend/services/offers-client.ts',
      trustTier: 2,
    },
  ],
  downstreamStep: {
    description: 'OfferController@store dispatches NotifyOfferCreated to the queue',
    edgeType: 'DISPATCHES',
    transport: 'queue',
    source: {
      id: 'symbol:php:OfferController@store',
      label: 'OfferController@store',
      filePath: 'app/Modules/Listings/Http/Controllers/OfferController.php',
    },
    target: {
      id: 'opb:job:App\\Modules\\Notifications\\Jobs\\NotifyOfferCreated',
      label: 'NotifyOfferCreated',
      filePath: 'app/Modules/Notifications/Jobs/NotifyOfferCreated.php',
    },
    trustTier: 4,
    rationale:
      'NotifyOfferCreated is the only persisted dispatch off the handler and materially completes "what does POSTing an offer trigger".',
  },
  crossLanguage: {
    status: 'refused-naming-only',
    associations: [
      {
        backendNodeId: 'surface:http:POST:/offers',
        frontendNodeId: 'symbol:ts:OffersClient.create',
        basis: 'naming-only',
        trustTier: 2,
        filePath: 'app/Modules/Listings/Frontend/services/offers-client.ts',
      },
    ],
    rationale:
      'Only a naming-based association exists between the route and the frontend call site; below the promotion threshold.',
  },
  trust: {
    targetTrustTier: 5,
    evidenceTrustTiers: [5, 5, 5, 4],
    ownershipTrustTier: 5,
    mixedTrust: true,
  },
  failures: [
    {
      failureClass: 'cross-language-below-promotion-threshold',
      detail: 'Frontend participation could not be promoted: the only association is naming-only.',
    },
  ],
};
