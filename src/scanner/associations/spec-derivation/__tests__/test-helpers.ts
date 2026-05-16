import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LuxDatabase } from '../../../../db/index.js';
import {
  markOverlayTrustAfterSync,
  persistRebuildTrustState,
} from '../../../overlay-trust-state.js';

export const REPO_ROOT = '/app';

export function makeSpecDb(
  trust: {
    mode?: 'overlay-complete' | 'degraded-overlay' | 'content-only';
    sourceAction?: 'index-rebuild' | 'index-sync';
    warnings?: string[];
  } = {}
): LuxDatabase {
  const testRoot = mkdtempSync(join(tmpdir(), 'lux-spec-derivation-test-'));
  const db = new LuxDatabase(join(testRoot, 'test.db'));
  persistRebuildTrustState(
    db,
    {
      mode: trust.mode ?? 'overlay-complete',
      repoPath: REPO_ROOT,
      configSource: 'lux.yaml',
      configLspEnabled: true,
      surfaceCount: 1,
      detectorEdgeCount: 1,
      propagatedEdgeCount: 0,
      fileNodeCount: 2,
      symbolNodeCount: 2,
      controllerBackedCount: 1,
      closureBackedCount: 0,
      unknownProviderKindCount: 0,
      enrichmentStatus: 'active',
      propagationStatus: 'ran',
      warnings: trust.warnings ?? [],
    },
    { sourceAction: 'index-rebuild' }
  );
  if (trust.sourceAction === 'index-sync') {
    markOverlayTrustAfterSync(db, {
      overlayRelevantPaths: ['app/Changed.php'],
      addedCount: 0,
      modifiedCount: 1,
      deletedCount: 0,
      indexedCount: 0,
      deletedEntryCount: 0,
    });
  }
  Object.defineProperty(db, '__specTestRoot', { value: testRoot });
  return db;
}

export function cleanupSpecDb(db: LuxDatabase | undefined): void {
  if (!db) return;
  const testRoot = (db as unknown as { __specTestRoot?: string }).__specTestRoot;
  db.close();
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
}

export function seedRoute(db: LuxDatabase): void {
  const now = Math.floor(Date.now() / 1000);
  db.upsertStructuralNode({
    id: 'file:routes/api.php',
    node_type: 'file',
    file_path: 'routes/api.php',
    updated_at: now,
  });
  db.upsertStructuralNode({
    id: 'surface:http:POST:/orders',
    node_type: 'capability-surface',
    symbol_name: 'POST /orders',
    language_id: 'http',
    file_path: 'routes/api.php',
    metadata: JSON.stringify({
      transport: 'http',
      method: 'POST',
      path: '/orders',
      routeName: 'orders.store',
    }),
    updated_at: now,
  });
  db.upsertStructuralNode({
    id: 'symbol:php:App\\Http\\Controllers\\OrderController@store',
    node_type: 'symbol',
    symbol_name: 'OrderController@store',
    qualified_name: 'App\\Http\\Controllers\\OrderController@store',
    file_path: 'app/Http/Controllers/OrderController.php',
    language_id: 'php',
    updated_at: now,
  });
  db.upsertStructuralEdge({
    id: 'edge:route-declares-orders',
    source_node_id: 'file:routes/api.php',
    target_node_id: 'surface:http:POST:/orders',
    edge_type: 'declares_surface',
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now,
  });
  db.upsertStructuralEdge({
    id: 'edge:orders-handled-by',
    source_node_id: 'surface:http:POST:/orders',
    target_node_id: 'symbol:php:App\\Http\\Controllers\\OrderController@store',
    edge_type: 'handled_by',
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now,
  });
}

export function seedAmbiguousRoutes(db: LuxDatabase): void {
  const now = Math.floor(Date.now() / 1000);
  for (const suffix of ['alpha', 'beta']) {
    db.upsertStructuralNode({
      id: `surface:http:GET:/reports-${suffix}`,
      node_type: 'capability-surface',
      symbol_name: `GET /reports-${suffix}`,
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: `/reports-${suffix}`,
        routeName: `reports.${suffix}`,
      }),
      updated_at: now,
    });
    db.upsertStructuralNode({
      id: `symbol:php:App\\Http\\Controllers\\Reports${suffix}Controller@index`,
      node_type: 'symbol',
      symbol_name: `Reports${suffix}Controller@index`,
      qualified_name: `App\\Http\\Controllers\\Reports${suffix}Controller@index`,
      file_path: `app/Http/Controllers/Reports${suffix}Controller.php`,
      language_id: 'php',
      updated_at: now,
    });
    db.upsertStructuralEdge({
      id: `edge:reports-${suffix}-handled-by`,
      source_node_id: `surface:http:GET:/reports-${suffix}`,
      target_node_id: `symbol:php:App\\Http\\Controllers\\Reports${suffix}Controller@index`,
      edge_type: 'handled_by',
      confidence: 1,
      confidence_class: 'proven',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: now,
    });
  }
}

export function seedOperational(db: LuxDatabase): void {
  db.upsertOperationalBoundary({
    id: 'opb:command:orders:sync',
    repo_root: REPO_ROOT,
    kind: 'command',
    name: 'orders:sync',
    trust_tier: 5,
    file_path: 'app/Console/Commands/SyncOrders.php',
  });
  db.upsertOperationalBoundary({
    id: 'opb:job:App\\Jobs\\SyncOrders',
    repo_root: REPO_ROOT,
    kind: 'job',
    name: 'App\\Jobs\\SyncOrders',
    trust_tier: 5,
    file_path: 'app/Jobs/SyncOrders.php',
  });
  db.upsertOperationalBoundary({
    id: 'opb:event:App\\Events\\OrderPlaced',
    repo_root: REPO_ROOT,
    kind: 'event',
    name: 'App\\Events\\OrderPlaced',
    trust_tier: 5,
    file_path: 'app/Providers/EventServiceProvider.php',
  });
  db.upsertOperationalHandler({
    id: 'oph:job-sync-orders',
    boundary_id: 'opb:job:App\\Jobs\\SyncOrders',
    symbol_id: 'symbol:php:App\\Jobs\\SyncOrders',
    trust_tier: 5,
  });
  db.upsertOperationalHandler({
    id: 'oph:event-order-placed',
    boundary_id: 'opb:event:App\\Events\\OrderPlaced',
    symbol_id: 'symbol:php:App\\Listeners\\UpdateOrderProjection',
    trust_tier: 5,
  });
  db.upsertOperationalEdge({
    id: 'ope:command-dispatches-job',
    source_id: 'opb:command:orders:sync',
    target_id: 'opb:job:App\\Jobs\\SyncOrders',
    edge_type: 'DISPATCHES',
    transport: 'queue',
    trust_tier: 5,
  });
  db.upsertOperationalEdge({
    id: 'ope:job-handled-by',
    source_id: 'opb:job:App\\Jobs\\SyncOrders',
    target_id: 'symbol:php:App\\Jobs\\SyncOrders',
    edge_type: 'HANDLED_BY',
    transport: 'queue',
    trust_tier: 5,
  });
  db.upsertOperationalEdge({
    id: 'ope:event-listener',
    source_id: 'opb:event:App\\Events\\OrderPlaced',
    target_id: 'symbol:php:App\\Listeners\\UpdateOrderProjection',
    edge_type: 'HANDLED_BY',
    transport: 'event-bus',
    trust_tier: 5,
  });
  db.upsertOperationalContract({
    id: 'opc:sync-orders-payload',
    boundary_id: 'opb:job:App\\Jobs\\SyncOrders',
    payload_schema: JSON.stringify({ maxArity: 1 }),
    trust_tier: 5,
  });
}

export function seedSupportingContextOperationalEdge(db: LuxDatabase): void {
  db.upsertOperationalEdge({
    id: 'ope:job-doc-context',
    source_id: 'opb:job:App\\Jobs\\SyncOrders',
    target_id: 'doc:jobs-sync-orders-runbook',
    edge_type: 'PRODUCES',
    transport: 'sync',
    trust_tier: 1,
  });
}
