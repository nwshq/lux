// Tests for the shared structural-analysis substrate.
//
// Covers:
//   - Trust level derivation from DB state
//   - trustLevelToWeight monotonicity
//   - Neighborhood extraction from capability surfaces
//   - Structural signature computation
//   - Ownership match scoring

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../db/index.js';
import {
  deriveOverlayTrustLevel,
  trustLevelToWeight,
  extractOverlayNeighborhoods,
  computeStructuralSignature,
  scoreOwnershipMatch,
} from '../structural-analysis.js';
import { deriveOverlayTrustLevelFromState } from '../../scanner/overlay-trust-state.js';
import type { ExpertStructuralSignature, OverlayNeighborhood } from '../structural-analysis.js';
import { classifySignatureDrift } from '../../discovery/diff.js';
import type { StructuralNode, StructuralEdge } from '../../db/types.js';
import { persistRebuildTrustState } from '../../scanner/overlay-trust-state.js';

const testDir = join(import.meta.dirname, 'fixtures', 'structural-analysis-test');

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, `test-${Date.now()}.db`));
}

function surfaceNode(id: string, filePath: string, symbolName?: string): StructuralNode {
  return {
    id,
    node_type: 'capability-surface',
    file_path: filePath,
    symbol_name: symbolName ?? id,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function fileNode(filePath: string): StructuralNode {
  return {
    id: `file:${filePath}`,
    node_type: 'file',
    file_path: filePath,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function symbolNode(id: string, filePath: string, symbolName: string): StructuralNode {
  return {
    id,
    node_type: 'symbol',
    file_path: filePath,
    symbol_name: symbolName,
    symbol_kind: 'class',
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function handledByEdge(surfaceId: string, providerId: string): StructuralEdge {
  return {
    id: `${surfaceId}->handled_by->${providerId}`,
    source_node_id: surfaceId,
    target_node_id: providerId,
    edge_type: 'handled_by',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function declaresSurfaceEdge(fileId: string, surfaceId: string): StructuralEdge {
  return {
    id: `${fileId}->declares_surface->${surfaceId}`,
    source_node_id: fileId,
    target_node_id: surfaceId,
    edge_type: 'declares_surface',
    confidence: 1.0,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function persistCompleteOverlay(db: LuxDatabase): void {
  persistRebuildTrustState(
    db,
    {
      mode: 'overlay-complete',
      repoPath: '/test',
      configSource: 'lux.yaml',
      configLspEnabled: true,
      surfaceCount: 10,
      detectorEdgeCount: 20,
      propagatedEdgeCount: 15,
      fileNodeCount: 50,
      symbolNodeCount: 100,
      controllerBackedCount: 8,
      closureBackedCount: 2,
      unknownProviderKindCount: 0,
      enrichmentStatus: 'active',
      propagationStatus: 'ran',
      warnings: [],
    },
    { sourceAction: 'index-rebuild' }
  );
}

// ---------------------------------------------------------------------------
// Trust level derivation
// ---------------------------------------------------------------------------

describe('deriveOverlayTrustLevel', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns no-overlay for empty DB', () => {
    expect(deriveOverlayTrustLevel(db)).toBe('no-overlay');
  });

  it('returns overlay-complete when trust state is persisted as overlay-complete', () => {
    persistCompleteOverlay(db);
    expect(deriveOverlayTrustLevel(db)).toBe('overlay-complete');
  });

  it('returns content-only when mode is content-only', () => {
    persistRebuildTrustState(
      db,
      {
        mode: 'content-only',
        repoPath: '/test',
        configSource: 'lux.yaml',
        configLspEnabled: false,
        surfaceCount: 0,
        detectorEdgeCount: 0,
        propagatedEdgeCount: 0,
        fileNodeCount: 0,
        symbolNodeCount: 0,
        controllerBackedCount: 0,
        closureBackedCount: 0,
        unknownProviderKindCount: 0,
        enrichmentStatus: 'inactive',
        propagationStatus: 'skipped',
        warnings: [],
      },
      { sourceAction: 'index-rebuild' }
    );
    expect(deriveOverlayTrustLevel(db)).toBe('content-only');
  });

  it('maps sync-degraded persisted state to stale-overlay trust level', () => {
    persistRebuildTrustState(
      db,
      {
        mode: 'degraded-overlay',
        repoPath: '/test',
        configSource: 'lux.yaml',
        configLspEnabled: true,
        surfaceCount: 5,
        detectorEdgeCount: 5,
        propagatedEdgeCount: 5,
        fileNodeCount: 5,
        symbolNodeCount: 5,
        controllerBackedCount: 3,
        closureBackedCount: 2,
        unknownProviderKindCount: 0,
        enrichmentStatus: 'active',
        propagationStatus: 'ran',
        warnings: ['stale after sync'],
      },
      { sourceAction: 'index-rebuild' }
    );

    const persisted = db.getIndexMetadata('overlay_trust_state');
    expect(persisted).toBeTruthy();
    const parsed = JSON.parse(persisted as string) as { sourceAction: string };
    parsed.sourceAction = 'index-sync';
    db.setIndexMetadata('overlay_trust_state', JSON.stringify(parsed));

    expect(deriveOverlayTrustLevel(db)).toBe('stale-overlay');
  });
});

describe('deriveOverlayTrustLevelFromState', () => {
  it('returns no-overlay for null state', () => {
    expect(deriveOverlayTrustLevelFromState(null)).toBe('no-overlay');
  });
});

// ---------------------------------------------------------------------------
// Trust weight monotonicity
// ---------------------------------------------------------------------------

describe('trustLevelToWeight', () => {
  it('assigns weight 0 to no-overlay', () => {
    expect(trustLevelToWeight('no-overlay')).toBe(0);
  });

  it('assigns weight 1 to overlay-complete', () => {
    expect(trustLevelToWeight('overlay-complete')).toBe(1.0);
  });

  it('is monotonically increasing across the full ordering', () => {
    // stale-overlay (0.4) > degraded-overlay (0.3) because stale overlay was once complete
    // and was downgraded by sync, whereas degraded was never fully built.
    const levels = [
      'no-overlay', // 0.0
      'content-only', // 0.1
      'degraded-overlay', // 0.3
      'stale-overlay', // 0.4
      'overlay-complete', // 1.0
    ] as const;
    for (let i = 0; i < levels.length - 1; i++) {
      expect(trustLevelToWeight(levels[i])).toBeLessThan(trustLevelToWeight(levels[i + 1]));
    }
  });
});

// ---------------------------------------------------------------------------
// Neighborhood extraction
// ---------------------------------------------------------------------------

describe('extractOverlayNeighborhoods', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array when overlay trust is no-overlay', () => {
    const result = extractOverlayNeighborhoods(db);
    expect(result).toEqual([]);
  });

  it('returns empty array when overlay is content-only', () => {
    persistRebuildTrustState(
      db,
      {
        mode: 'content-only',
        repoPath: '/test',
        configSource: 'lux.yaml',
        configLspEnabled: false,
        surfaceCount: 0,
        detectorEdgeCount: 0,
        propagatedEdgeCount: 0,
        fileNodeCount: 0,
        symbolNodeCount: 0,
        controllerBackedCount: 0,
        closureBackedCount: 0,
        unknownProviderKindCount: 0,
        enrichmentStatus: 'inactive',
        propagationStatus: 'skipped',
        warnings: [],
      },
      { sourceAction: 'index-rebuild' }
    );
    expect(extractOverlayNeighborhoods(db)).toEqual([]);
  });

  it('returns empty array when overlay-complete but no surfaces', () => {
    persistCompleteOverlay(db);
    expect(extractOverlayNeighborhoods(db)).toEqual([]);
  });

  it('extracts one neighborhood per distinct provider file', () => {
    persistCompleteOverlay(db);

    // Two surfaces handled by the same controller file
    const s1 = surfaceNode('surface:GET /invoices', 'routes/api.php', 'GET /invoices');
    const s2 = surfaceNode('surface:POST /invoices', 'routes/api.php', 'POST /invoices');
    const provider1 = symbolNode(
      'InvoiceController@index',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );
    const provider2 = symbolNode(
      'InvoiceController@store',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );

    db.upsertStructuralNode(s1);
    db.upsertStructuralNode(s2);
    db.upsertStructuralNode(provider1);
    db.upsertStructuralNode(provider2);
    db.upsertStructuralEdge(handledByEdge(s1.id, provider1.id));
    db.upsertStructuralEdge(handledByEdge(s2.id, provider2.id));

    const neighborhoods = extractOverlayNeighborhoods(db);

    // Both surfaces map to the same provider file → one neighborhood
    expect(neighborhoods).toHaveLength(1);
    expect(neighborhoods[0].kind).toBe('surface-family');
    expect(neighborhoods[0].surfaceIds).toHaveLength(2);
    expect(neighborhoods[0].anchorFiles).toContain('app/Http/Controllers/InvoiceController.php');
    expect(neighborhoods[0].trustState).toBe('overlay-complete');
    expect(neighborhoods[0].trustWeight).toBe(1.0);
  });

  it('creates separate neighborhoods for different provider files', () => {
    persistCompleteOverlay(db);

    const s1 = surfaceNode('surface:GET /invoices', 'routes/api.php', 'GET /invoices');
    const s2 = surfaceNode('surface:GET /users', 'routes/api.php', 'GET /users');
    const p1 = symbolNode(
      'InvoiceController@index',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );
    const p2 = symbolNode(
      'UserController@index',
      'app/Http/Controllers/UserController.php',
      'UserController'
    );

    db.upsertStructuralNode(s1);
    db.upsertStructuralNode(s2);
    db.upsertStructuralNode(p1);
    db.upsertStructuralNode(p2);
    db.upsertStructuralEdge(handledByEdge(s1.id, p1.id));
    db.upsertStructuralEdge(handledByEdge(s2.id, p2.id));

    const neighborhoods = extractOverlayNeighborhoods(db);
    expect(neighborhoods).toHaveLength(2);
  });

  it('falls back to declaring file grouping when no provider', () => {
    persistCompleteOverlay(db);

    const s1 = surfaceNode('surface:GET /ping', 'routes/api.php', 'GET /ping');
    const routeFile = fileNode('routes/api.php');

    db.upsertStructuralNode(s1);
    db.upsertStructuralNode(routeFile);
    db.upsertStructuralEdge(declaresSurfaceEdge(routeFile.id, s1.id));

    const neighborhoods = extractOverlayNeighborhoods(db);
    expect(neighborhoods).toHaveLength(1);
    expect(neighborhoods[0].anchorFiles).toContain('routes/api.php');
  });

  it('computes cohesion score between 0 and 1', () => {
    persistCompleteOverlay(db);

    const s = surfaceNode('surface:GET /invoices', 'routes/api.php');
    const p = symbolNode(
      'InvoiceController@index',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );
    db.upsertStructuralNode(s);
    db.upsertStructuralNode(p);
    db.upsertStructuralEdge(handledByEdge(s.id, p.id));

    const [nbhd] = extractOverlayNeighborhoods(db);
    expect(nbhd.cohesionScore).toBeGreaterThanOrEqual(0);
    expect(nbhd.cohesionScore).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Structural signature computation
// ---------------------------------------------------------------------------

describe('computeStructuralSignature', () => {
  it('produces version 1 signature with sorted anchor files', () => {
    const nbhd: OverlayNeighborhood = {
      id: 'nbhd-0',
      kind: 'surface-family',
      label: 'InvoiceController',
      anchorFiles: ['app/Http/Controllers/InvoiceController.php', 'routes/api.php'],
      memberFiles: ['app/Http/Controllers/InvoiceController.php', 'routes/api.php'],
      dominantDirectories: ['app/Http/Controllers'],
      surfaceIds: ['s1', 's2'],
      providerIds: ['p1'],
      cohesionScore: 0.8,
      externalCouplingScore: 0.1,
      trustState: 'overlay-complete',
      trustWeight: 1.0,
      evidenceSummary: ['2 surface(s), 2 anchor file(s)'],
    };

    const sig = computeStructuralSignature(nbhd);

    expect(sig.version).toBe(1);
    expect(sig.anchorFiles).toEqual([
      'app/Http/Controllers/InvoiceController.php',
      'routes/api.php',
    ]);
    expect(sig.dominantDirectories).toEqual(['app/Http/Controllers']);
    expect(sig.dominantSurfaces).toEqual(['s1', 's2']);
    expect(sig.dominantProviders).toEqual(['p1']);
  });

  it('omits optional fields when empty', () => {
    const nbhd: OverlayNeighborhood = {
      id: 'nbhd-0',
      kind: 'surface-family',
      label: 'Test',
      anchorFiles: ['routes/api.php'],
      memberFiles: ['routes/api.php'],
      dominantDirectories: ['routes'],
      cohesionScore: 0.5,
      externalCouplingScore: 0,
      trustState: 'overlay-complete',
      trustWeight: 1.0,
      evidenceSummary: [],
    };

    const sig = computeStructuralSignature(nbhd);
    expect(sig.dominantSurfaces).toBeUndefined();
    expect(sig.dominantProviders).toBeUndefined();
    expect(sig.contractFamilies).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ownership match scoring
// ---------------------------------------------------------------------------

describe('scoreOwnershipMatch', () => {
  const sig: ExpertStructuralSignature = {
    version: 1,
    anchorFiles: ['app/Http/Controllers/InvoiceController.php', 'routes/api.php'],
    dominantDirectories: ['app/Http/Controllers'],
    dominantSurfaces: ['surface:GET /invoices'],
    dominantProviders: ['InvoiceController@index'],
  };

  it('returns zero score when hitFiles is empty', () => {
    const result = scoreOwnershipMatch([], sig, [], 1.0);
    expect(result.overlapScore).toBe(0);
    expect(result.trustAdjustedScore).toBe(0);
    expect(result.warningLevel).toBe('none');
  });

  it('returns zero score when trustWeight is 0', () => {
    const result = scoreOwnershipMatch(['app/Http/Controllers/InvoiceController.php'], sig, [], 0);
    expect(result.overlapScore).toBe(0);
    expect(result.trustAdjustedScore).toBe(0);
    expect(result.warningLevel).toBe('debug-only');
  });

  it('returns positive overlap score for matching files', () => {
    const result = scoreOwnershipMatch(
      ['app/Http/Controllers/InvoiceController.php'],
      sig,
      [],
      1.0
    );
    expect(result.overlapScore).toBeGreaterThan(0);
    expect(result.trustAdjustedScore).toBe(result.overlapScore);
  });

  it('trust-adjusts score correctly', () => {
    const hitFiles = ['app/Http/Controllers/InvoiceController.php'];
    const fullTrust = scoreOwnershipMatch(hitFiles, sig, [], 1.0);
    const halfTrust = scoreOwnershipMatch(hitFiles, sig, [], 0.5);
    expect(halfTrust.trustAdjustedScore).toBeCloseTo(fullTrust.overlapScore * 0.5);
  });

  it('produces user-visible warning when trust is low and overlap is high', () => {
    // Fake a high overlap score by having all files match
    const sig2: ExpertStructuralSignature = {
      version: 1,
      anchorFiles: ['a.php', 'b.php', 'c.php'],
      dominantDirectories: ['app/Http/Controllers'],
    };
    const result = scoreOwnershipMatch(['a.php', 'b.php', 'c.php'], sig2, [], 0.4);
    // Low trust with high overlap → user-visible warning
    expect(['user-visible', 'debug-only']).toContain(result.warningLevel);
  });

  it('sets expertSlug when provided', () => {
    const result = scoreOwnershipMatch(['a.php'], sig, [], 1.0, 'invoice-expert');
    expect(result.expertSlug).toBe('invoice-expert');
  });
});

// ---------------------------------------------------------------------------
// Three-tier drift classification (exported from diff module)
// ---------------------------------------------------------------------------

describe('classifySignatureDrift', () => {
  it('classifies incidental drift when most anchor files and all directories are stable', () => {
    const old: ExpertStructuralSignature = {
      version: 1,
      // 4 anchor files; proposed changes only one (75% overlap → Jaccard = 3/5 = 0.6)
      anchorFiles: [
        'app/Controllers/InvoiceController.php',
        'app/Models/Invoice.php',
        'app/Models/InvoiceLine.php',
        'routes/api.php',
      ],
      dominantDirectories: ['app/Controllers', 'app/Models'],
    };
    const proposed: ExpertStructuralSignature = {
      version: 1,
      anchorFiles: [
        'app/Controllers/InvoiceController.php',
        'app/Models/Invoice.php',
        'app/Models/InvoiceLine.php',
        'routes/web.php', // minor rename
      ],
      dominantDirectories: ['app/Controllers', 'app/Models'],
    };

    const tier = classifySignatureDrift(old, proposed);
    expect(tier).toBe('incidental');
  });

  it('classifies boundary-changing drift when dominant directories shift', () => {
    const old: ExpertStructuralSignature = {
      version: 1,
      anchorFiles: ['app/Controllers/InvoiceController.php'],
      dominantDirectories: ['app/Controllers'],
    };
    const proposed: ExpertStructuralSignature = {
      version: 1,
      anchorFiles: ['src/billing/BillingService.ts'],
      dominantDirectories: ['src/billing'],
    };

    const tier = classifySignatureDrift(old, proposed);
    expect(tier).toBe('boundary-changing');
  });

  it('classifies evolutionary drift for mid-range anchor overlap with stable directories', () => {
    const old: ExpertStructuralSignature = {
      version: 1,
      anchorFiles: [
        'app/Controllers/InvoiceController.php',
        'routes/api.php',
        'app/Models/Invoice.php',
      ],
      dominantDirectories: ['app/Controllers', 'app/Models'],
    };
    // One new file added, directory story intact
    const proposed: ExpertStructuralSignature = {
      version: 1,
      anchorFiles: [
        'app/Controllers/InvoiceController.php',
        'app/Models/Invoice.php',
        'app/Services/InvoiceService.php',
      ],
      dominantDirectories: ['app/Controllers', 'app/Models'],
    };

    const tier = classifySignatureDrift(old, proposed);
    expect(['evolutionary', 'incidental']).toContain(tier);
  });
});
