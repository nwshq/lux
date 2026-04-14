// Tests for symbolic propagation passes (provider, consumer, artifact).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import { propagateSurfaces } from '../propagation.js';
import type { AssociationContext } from '../types.js';
import type { StructuralNode, StructuralEdge } from '../../../db/types.js';

const testDir = join(import.meta.dirname, 'fixtures', 'propagation-test');
const ROOT = '/app';

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function makeContext(
  entries: Array<{ filePath: string; languageId?: string; content?: string; lsp?: unknown }>
): AssociationContext {
  return {
    rootPath: ROOT,
    nodes: [],
    entries: entries.map((e) => ({
      filePath: e.filePath,
      languageId: e.languageId,
      metadata: {
        ...(e.content ? { content: e.content } : {}),
        ...(e.lsp ? { lsp: e.lsp } : {}),
      },
    })),
    dirtyFiles: [],
  };
}

function upsertNode(db: LuxDatabase, id: string, nodeType: StructuralNode['node_type'], filePath?: string): void {
  db.upsertStructuralNode({
    id,
    node_type: nodeType,
    symbol_name: id,
    language_id: 'php',
    file_path: filePath,
    metadata: '{}',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function upsertEdge(db: LuxDatabase, id: string, edgeType: StructuralEdge['edge_type'], sourceNodeId: string, targetNodeId: string): void {
  db.upsertStructuralEdge({
    id,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    edge_type: edgeType,
    confidence: 0.95,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    provenance_summary: 'test',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function upsertSurface(db: LuxDatabase, surfaceId: string, path: string, controllerNodeId?: string): void {
  db.upsertStructuralNode({
    id: surfaceId,
    node_type: 'capability-surface',
    symbol_name: `GET ${path}`,
    language_id: 'http',
    file_path: 'routes/api.php',
    metadata: JSON.stringify({ transport: 'http', method: 'GET', path }),
    updated_at: Math.floor(Date.now() / 1000),
  });

  if (controllerNodeId) {
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );
  }
}

// ---------------------------------------------------------------------------
// propagateSurfaces — early exit
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — no surfaces', () => {
  let db: LuxDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); rmSync(testDir, { recursive: true, force: true }); });

  it('returns zero counts when no surfaces exist', async () => {
    const ctx = makeContext([]);
    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(0);
    expect(result.consumerEdgesAdded).toBe(0);
    expect(result.artifactEdgesAdded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provider propagation
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — provider propagation', () => {
  let db: LuxDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); rmSync(testDir, { recursive: true, force: true }); });

  it('emits validates_with edge when controller file has FormRequest sibling in LSP hierarchy', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const requestNodeId = 'symbol:php:ListInvoicesRequest';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/ListInvoicesRequest.php');

    const lspData = {
      typeHierarchy: [
        { name: 'ListInvoicesRequest', supertypes: [{ name: 'FormRequest' }] },
      ],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    // Provider edges go from controllerNode → siblingNode (not from surface)
    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const edgeTypes = controllerEdges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('validates_with');
  });

  it('emits returns_contract edge when controller file has JsonResource sibling', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, resourceNodeId, 'symbol', 'app/Http/Resources/InvoiceResource.php');

    const lspData = {
      typeHierarchy: [
        { name: 'InvoiceResource', supertypes: [{ name: 'JsonResource' }] },
      ],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const edgeTypes = controllerEdges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('returns_contract');
  });

  it('emits both validates_with and returns_contract when both sibling types present', async () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/StoreInvoiceRequest.php');
    upsertNode(db, resourceNodeId, 'symbol', 'app/Http/Resources/InvoiceResource.php');

    const lspData = {
      typeHierarchy: [
        { name: 'StoreInvoiceRequest', supertypes: [{ name: 'FormRequest' }] },
        { name: 'InvoiceResource', supertypes: [{ name: 'JsonResource' }] },
      ],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(2);
  });

  it('skips propagation when controller node does not exist in DB', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    // Surface has handled_by edge pointing to a controller node that was never persisted
    upsertSurface(db, surfaceId, '/api/users', 'symbol:php:UserController@index');
    // Note: UserController@index is NOT inserted into DB

    const ctx = makeContext([]);
    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(0);
  });

  it('skips propagation when controller node has no file_path', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    const controllerNodeId = 'symbol:php:UserController@index';

    upsertSurface(db, surfaceId, '/api/users', controllerNodeId);
    // Controller node without file_path
    db.upsertStructuralNode({
      id: controllerNodeId,
      node_type: 'symbol',
      symbol_name: 'UserController',
      language_id: 'php',
      file_path: undefined,
      metadata: '{}',
      updated_at: Math.floor(Date.now() / 1000),
    });

    const ctx = makeContext([]);
    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(0);
  });

  it('skips sibling symbols that do not exist in DB', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    // requestNodeId is NOT inserted into DB

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');

    const lspData = {
      typeHierarchy: [
        { name: 'ListInvoicesRequest', supertypes: [{ name: 'FormRequest' }] },
      ],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(0);
  });

  // Patch A — class-level provider node resolution

  it('resolves class-level handled_by target (Patch A: materializer compatibility)', async () => {
    // The detector now emits handled_by to symbol:php:InvoiceController (class-level),
    // not symbol:php:InvoiceController@index. This test verifies that provider
    // propagation correctly resolves and expands from the class-level node.
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController'; // class-level
    const requestNodeId = 'symbol:php:ListInvoicesRequest';

    // Surface with controllerMethod in metadata (as detector now emits)
    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /api/invoices',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http', method: 'GET', path: '/api/invoices',
        explicitProvider: 'InvoiceController', controllerMethod: 'index',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertEdge(db, `${surfaceId}→${controllerNodeId}:handled_by`, 'handled_by', surfaceId, controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/ListInvoicesRequest.php');

    const phpContent = [
      '<?php',
      'class InvoiceController extends Controller',
      '{',
      '    public function index(ListInvoicesRequest $request)',
      '    {',
      "        return response()->json(Invoice::all());",
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'app/Http/Controllers/InvoiceController.php', languageId: 'php', content: phpContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBeGreaterThanOrEqual(1);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(edges.some((e) => e.edge.edge_type === 'validates_with')).toBe(true);
  });

  it('is idempotent — re-running does not duplicate provider edges', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const requestNodeId = 'symbol:php:ListInvoicesRequest';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/ListInvoicesRequest.php');

    const lspData = {
      typeHierarchy: [
        { name: 'ListInvoicesRequest', supertypes: [{ name: 'FormRequest' }] },
      ],
    };
    const ctx = makeContext([
      { filePath: 'app/Http/Controllers/InvoiceController.php', languageId: 'php', lsp: lspData },
    ]);

    await propagateSurfaces(db, ctx);
    await propagateSurfaces(db, ctx); // second run

    // Provider edges are on the controller node, not the surface
    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const validateEdges = controllerEdges.filter((e) => e.edge.edge_type === 'validates_with');
    expect(validateEdges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Provider propagation — Phase 3 handler-centered expansion (PHP content path)
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — provider propagation (PHP content analysis)', () => {
  let db: LuxDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); rmSync(testDir, { recursive: true, force: true }); });

  it('emits validates_with via typed method parameter when no LSP data present', async () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/StoreInvoiceRequest.php');

    const phpContent = [
      '<?php',
      'namespace App\\Http\\Controllers;',
      '',
      'class InvoiceController extends Controller',
      '{',
      '    public function store(StoreInvoiceRequest $request): JsonResponse',
      '    {',
      '        $invoice = Invoice::create($request->validated());',
      "        return response()->json(['id' => $invoice->id], 201);",
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
        // no lsp data
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(controllerEdges.some((e) => e.edge.edge_type === 'validates_with')).toBe(true);
  });

  it('emits returns_contract via new XResource() in method body', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, resourceNodeId, 'symbol', 'app/Http/Resources/InvoiceResource.php');

    const phpContent = [
      '<?php',
      'class InvoiceController extends Controller',
      '{',
      '    public function index(): JsonResponse',
      '    {',
      '        $invoice = Invoice::findOrFail(1);',
      '        return new InvoiceResource($invoice);',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'app/Http/Controllers/InvoiceController.php', languageId: 'php', content: phpContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(controllerEdges.some((e) => e.edge.edge_type === 'returns_contract')).toBe(true);
  });

  it('emits returns_contract via XResource::collection() static factory', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, resourceNodeId, 'symbol', 'app/Http/Resources/InvoiceResource.php');

    const phpContent = [
      '<?php',
      'class InvoiceController extends Controller',
      '{',
      '    public function index(): JsonResponse',
      '    {',
      '        return InvoiceResource::collection(Invoice::paginate());',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'app/Http/Controllers/InvoiceController.php', languageId: 'php', content: phpContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(edges.some((e) => e.edge.edge_type === 'returns_contract')).toBe(true);
  });

  it('resolves qualified name via use import and falls back to short name for DB lookup', async () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    // Node stored with short name (as many indexers produce)
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/StoreInvoiceRequest.php');

    const phpContent = [
      '<?php',
      'use App\\Http\\Requests\\StoreInvoiceRequest;',
      '',
      'class InvoiceController extends Controller',
      '{',
      '    public function store(StoreInvoiceRequest $request): JsonResponse',
      '    {',
      '        Invoice::create($request->validated());',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'app/Http/Controllers/InvoiceController.php', languageId: 'php', content: phpContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);
  });

  it('does NOT emit validates_with for bare Request base class', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');

    // No FormRequest node, only uses base Request
    const phpContent = [
      '<?php',
      'use Illuminate\\Http\\Request;',
      '',
      'class InvoiceController extends Controller',
      '{',
      '    public function index(Request $request): JsonResponse',
      '    {',
      "        return response()->json(['data' => []]);",
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'app/Http/Controllers/InvoiceController.php', languageId: 'php', content: phpContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(0);
  });

  it('combines LSP and PHP content analysis — emits both edges when each source finds a different symbol', async () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol');
    upsertNode(db, resourceNodeId, 'symbol');

    // PHP content finds the request param; LSP finds the resource type
    const phpContent = [
      '<?php',
      'class InvoiceController extends Controller',
      '{',
      '    public function store(StoreInvoiceRequest $request): JsonResponse',
      '    {',
      '        $invoice = Invoice::create($request->validated());',
      '        return new InvoiceResource($invoice);',
      '    }',
      '}',
    ].join('\n');

    const lspData = {
      typeHierarchy: [
        { name: 'InvoiceResource', supertypes: [{ name: 'JsonResource' }] },
      ],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(2);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(edges.some((e) => e.edge.edge_type === 'validates_with')).toBe(true);
    expect(edges.some((e) => e.edge.edge_type === 'returns_contract')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Consumer propagation
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — consumer propagation', () => {
  let db: LuxDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); rmSync(testDir, { recursive: true, force: true }); });

  it('emits calls_surface edge when TS wrapper function references surface path', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');

    const tsContent = [
      "import axios from 'axios';",
      '',
      "export async function fetchInvoices(params: InvoiceParams) {",
      "  return axios.get('/api/invoices', { params });",
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(1);

    const ctx2 = db.getSurfaceCenteredContext(surfaceId);
    const edgeTypes = ctx2!.edges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('calls_surface');
  });

  it('emits calls_surface for arrow function export referencing path', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    const wrapperNodeId = 'symbol:ts:src/api/users.ts#getUsers';

    upsertSurface(db, surfaceId, '/api/users');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/users.ts');

    const tsContent = [
      "export const getUsers = async (page: number) => {",
      "  const response = await fetch('/api/users?page=' + page);",
      '  return response.json();',
      '};',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/users.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(1);
  });

  it('does NOT emit calls_surface when TS file references path but wrapper node absent from DB', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    // wrapperNodeId NOT in DB

    upsertSurface(db, surfaceId, '/api/invoices');

    const tsContent = [
      "export async function fetchInvoices() {",
      "  return fetch('/api/invoices');",
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(0);
  });

  it('does NOT emit calls_surface when surface has no path in metadata', async () => {
    // Surface with no path (malformed metadata)
    db.upsertStructuralNode({
      id: 'surface:http:unknown',
      node_type: 'capability-surface',
      symbol_name: 'unknown',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({ transport: 'http' }), // no path
      updated_at: Math.floor(Date.now() / 1000),
    });

    const ctx = makeContext([
      { filePath: 'src/api/foo.ts', languageId: 'typescript', content: 'export function foo() {}' },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(0);
  });

  it('is idempotent — re-running does not duplicate consumer edges', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');

    const tsContent = "export async function fetchInvoices() { return fetch('/api/invoices'); }";
    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    await propagateSurfaces(db, ctx);
    await propagateSurfaces(db, ctx);

    const ctx2 = db.getSurfaceCenteredContext(surfaceId);
    const callsEdges = ctx2!.edges.filter((e) => e.edge.edge_type === 'calls_surface');
    expect(callsEdges).toHaveLength(1);
  });

  // Phase 2 — two-stage consumer propagation hardening

  it('does NOT emit calls_surface when function references path but has no transport callsite', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'symbol:ts:src/utils/paths.ts#invoicesPath';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/utils/paths.ts');

    // Function mentions the path but never calls fetch / axios / HTTP method
    const tsContent = [
      "export function invoicesPath() {",
      "  return '/api/invoices';",
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/utils/paths.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(0);
  });

  it('does NOT emit calls_surface when path static skeleton is shorter than 4 characters', async () => {
    // Skeleton of '/ab' is 'ab' (2 chars) — too short to be a meaningful discriminator
    db.upsertStructuralNode({
      id: 'surface:http:GET:/ab',
      node_type: 'capability-surface',
      symbol_name: 'GET /ab',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({ transport: 'http', method: 'GET', path: '/ab' }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    const wrapperNodeId = 'symbol:ts:src/api/ab.ts#getAb';
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/ab.ts');

    const tsContent = "export const getAb = () => fetch('/ab');";
    const ctx = makeContext([
      { filePath: 'src/api/ab.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(0);
  });

  it('matches static path skeleton after stripping dynamic segments', async () => {
    // Surface path '/api/invoices/{id}' should match a wrapper referencing '/api/invoices/'
    db.upsertStructuralNode({
      id: 'surface:http:GET:/api/invoices/{id}',
      node_type: 'capability-surface',
      symbol_name: 'GET /api/invoices/{id}',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({ transport: 'http', method: 'GET', path: '/api/invoices/{id}' }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoice';
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');

    const tsContent = [
      "export async function fetchInvoice(id: number) {",
      "  return fetch('/api/invoices/' + id);",
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(1);
  });

  it('emits calls_surface with confidence 0.75 for a transport-proven wrapper', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');

    const tsContent = "export async function fetchInvoices() { return fetch('/api/invoices'); }";
    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    await propagateSurfaces(db, ctx);

    const surfaceCtx = db.getSurfaceCenteredContext(surfaceId);
    const callsEdge = surfaceCtx!.edges.find((e) => e.edge.edge_type === 'calls_surface');
    expect(callsEdge).toBeDefined();
    expect(callsEdge!.edge.confidence).toBeCloseTo(0.75);
  });
});

// ---------------------------------------------------------------------------
// Artifact propagation
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — artifact propagation', () => {
  let db: LuxDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); rmSync(testDir, { recursive: true, force: true }); });

  it('emits derived_from edge for a generated openapi file referencing surface path', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/generated/openapi-client.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, artifactNodeId, 'file', 'src/generated/openapi-client.ts');

    const artifactContent = [
      '// Auto-generated. Do not edit.',
      "export function getApiInvoices(params: InvoiceParams): Promise<Invoice[]> {",
      "  return request({ method: 'GET', path: '/api/invoices', params });",
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'src/generated/openapi-client.ts',
        languageId: 'typescript',
        content: artifactContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(1);

    const ctx2 = db.getSurfaceCenteredContext(surfaceId);
    const edgeTypes = ctx2!.edges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('derived_from');
  });

  // Phase 4: .client.ts in /api/ without a generation header is 'handwritten-wrapper'
  // — it should NOT receive a derived_from edge; consumer propagation handles it instead.
  it('does NOT emit derived_from for .client.ts in /api/ without generation header', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    const artifactNodeId = 'file:src/api/users.client.ts';

    upsertSurface(db, surfaceId, '/api/users');
    upsertNode(db, artifactNodeId, 'file', 'src/api/users.client.ts');

    // No generation header — classified as handwritten-wrapper
    const content = "export const usersClientGet = () => fetch('/api/users');";

    const ctx = makeContext([
      { filePath: 'src/api/users.client.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('does NOT emit derived_from for a regular TS file (non-artifact)', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const fileNodeId = 'file:src/components/InvoiceList.tsx';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, fileNodeId, 'file', 'src/components/InvoiceList.tsx');

    const content = "// References /api/invoices in a comment";

    const ctx = makeContext([
      { filePath: 'src/components/InvoiceList.tsx', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('does NOT emit derived_from when artifact file node absent from DB', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    // artifact file node NOT in DB

    upsertSurface(db, surfaceId, '/api/invoices');

    const artifactContent = "// references /api/invoices";

    const ctx = makeContext([
      {
        filePath: 'src/generated/openapi-client.ts',
        languageId: 'typescript',
        content: artifactContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('is idempotent — re-running does not duplicate artifact edges', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/generated/openapi-client.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, artifactNodeId, 'file', 'src/generated/openapi-client.ts');

    const content = "// /api/invoices endpoint";
    const ctx = makeContext([
      { filePath: 'src/generated/openapi-client.ts', languageId: 'typescript', content },
    ]);

    await propagateSurfaces(db, ctx);
    await propagateSurfaces(db, ctx);

    const ctx2 = db.getSurfaceCenteredContext(surfaceId);
    const derivedEdges = ctx2!.edges.filter((e) => e.edge.edge_type === 'derived_from');
    expect(derivedEdges).toHaveLength(1);
  });

  // Phase 4 — artifact role classification

  it('emits derived_from for a .client.ts file WITH a generation header', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    // Even though it is in /api/, the generation header makes it a generated-client
    const artifactNodeId = 'file:src/api/users.client.ts';

    upsertSurface(db, surfaceId, '/api/users');
    upsertNode(db, artifactNodeId, 'file', 'src/api/users.client.ts');

    const content = [
      '// Auto-generated. Do not edit.',
      "export const usersClientGet = () => fetch('/api/users');",
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/users.client.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(1);
  });

  it('does NOT emit derived_from for a file in /services/ without generation evidence', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const fileNodeId = 'file:src/services/invoice-service.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, fileNodeId, 'file', 'src/services/invoice-service.ts');

    const content = "export class InvoiceService { async getAll() { return fetch('/api/invoices'); } }";

    const ctx = makeContext([
      { filePath: 'src/services/invoice-service.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('classifies @generated marker in file header as generated-client', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/client/invoices.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, artifactNodeId, 'file', 'src/client/invoices.ts');

    const content = [
      '/* @generated */',
      "export function getInvoices() { return fetch('/api/invoices'); }",
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/client/invoices.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(1);
  });

  it('classifies openapi-named file outside /api/ as schema-derived and emits derived_from', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/openapi-types.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, artifactNodeId, 'file', 'src/openapi-types.ts');

    const content = "export type GetInvoicesPath = '/api/invoices';";

    const ctx = makeContext([
      { filePath: 'src/openapi-types.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PropagationResult aggregation
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — result aggregation', () => {
  let db: LuxDatabase;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); rmSync(testDir, { recursive: true, force: true }); });

  it('returns correct counts across all three pass types simultaneously', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const requestNodeId = 'symbol:php:ListInvoicesRequest';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';
    const artifactNodeId = 'file:src/generated/openapi-client.ts';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/ListInvoicesRequest.php');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');
    upsertNode(db, artifactNodeId, 'file', 'src/generated/openapi-client.ts');

    const lspData = {
      typeHierarchy: [
        { name: 'ListInvoicesRequest', supertypes: [{ name: 'FormRequest' }] },
      ],
    };

    const ctx = makeContext([
      { filePath: 'app/Http/Controllers/InvoiceController.php', languageId: 'php', lsp: lspData },
      {
        filePath: 'src/api/invoices.ts',
        languageId: 'typescript',
        content: "export async function fetchInvoices() { return fetch('/api/invoices'); }",
      },
      {
        filePath: 'src/generated/openapi-client.ts',
        languageId: 'typescript',
        content: "// generated: /api/invoices",
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);
    expect(result.consumerEdgesAdded).toBe(1);
    expect(result.artifactEdgesAdded).toBe(1);
  });
});
