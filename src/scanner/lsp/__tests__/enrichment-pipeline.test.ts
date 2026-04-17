import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { loadLspConfig } from '../../config.js';
import {
  EnricherRegistry,
  toEnrichedSymbol,
  toEnrichedDiagnostic,
  toEnrichedDefinition,
} from '../index.js';
import type { EnrichmentResult, LspEnricher } from '../index.js';
import { generalScan, attachEnrichment } from '../../general.js';
import { LuxDatabase } from '../../../db/index.js';
import {
  buildAugmentedQuery,
  extractLspRelationships,
  type FtsHit,
} from '../../../experts/router.js';
import type { DocumentSymbol, Diagnostic, Location } from 'vscode-languageserver-protocol';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testDir = join(import.meta.dirname, 'fixtures', 'enrichment-test');
const corpusDir = join(testDir, 'corpus');
const clientsDir = join(corpusDir, 'knowledge', '10_clients');

function setupCorpus() {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }

  // Create CORPUS structure with client and project
  const clientDir = join(clientsDir, 'test-client');
  const projectDir = join(clientDir, 'test-project');
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(clientDir, 'README.md'),
    `---
name: Test Client
type: client
status: active
---
# Test Client
`
  );

  writeFileSync(
    join(projectDir, 'README.md'),
    `---
name: Test Project
status: active
---
# Test Project

A PHP Laravel project.
`
  );
}

function cleanupCorpus() {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Config loading tests
// ---------------------------------------------------------------------------

describe('LSP config loading', () => {
  beforeEach(setupCorpus);
  afterEach(cleanupCorpus);

  it('should return defaults when no lux.yaml exists', () => {
    const config = loadLspConfig(corpusDir);
    expect(config.lsp.enabled).toBe(false);
    expect(config.lsp.enrichers).toEqual([]);
  });

  it('should parse lux.yaml with LSP enabled and enrichers', () => {
    writeFileSync(
      join(corpusDir, 'lux.yaml'),
      `lsp:
  enabled: true
  workspace_root: /path/to/project
  enrichers:
    - language_id: php
      enabled: true
      server_command: intelephense
      server_args:
        - "--stdio"
      max_concurrency: 2
      request_timeout_ms: 10000
    - language_id: typescript
      enabled: false
`
    );

    const config = loadLspConfig(corpusDir);
    expect(config.lsp.enabled).toBe(true);
    expect(config.lsp.workspaceRoot).toBe('/path/to/project');
    expect(config.lsp.enrichers).toHaveLength(2);

    const php = config.lsp.enrichers[0];
    expect(php.languageId).toBe('php');
    expect(php.enabled).toBe(true);
    expect(php.serverCommand).toBe('intelephense');
    expect(php.serverArgs).toEqual(['--stdio']);
    expect(php.maxConcurrency).toBe(2);
    expect(php.requestTimeoutMs).toBe(10000);

    const ts = config.lsp.enrichers[1];
    expect(ts.languageId).toBe('typescript');
    expect(ts.enabled).toBe(false);
  });

  it('should handle malformed lux.yaml gracefully', () => {
    writeFileSync(join(corpusDir, 'lux.yaml'), 'not: valid: yaml: [[[');
    expect(() => loadLspConfig(corpusDir)).toThrow('Failed to parse lux.yaml');
  });

  it('should handle empty lux.yaml', () => {
    writeFileSync(join(corpusDir, 'lux.yaml'), '');
    const config = loadLspConfig(corpusDir);
    expect(config.lsp.enabled).toBe(false);
  });

  it('should skip enrichers with missing language_id', () => {
    writeFileSync(
      join(corpusDir, 'lux.yaml'),
      `lsp:
  enabled: true
  enrichers:
    - enabled: true
      server_command: some-server
    - language_id: php
`
    );

    const config = loadLspConfig(corpusDir);
    expect(config.lsp.enrichers).toHaveLength(1);
    expect(config.lsp.enrichers[0].languageId).toBe('php');
  });
});

// ---------------------------------------------------------------------------
// EnricherRegistry tests
// ---------------------------------------------------------------------------

describe('EnricherRegistry', () => {
  function createMockEnricher(languageId: string, extensions: string[]): LspEnricher {
    return {
      languageId,
      fileExtensions: extensions,
      config: { serverCommand: 'mock', serverArgs: [] },
      isReady: false,
      initialize: () => Promise.resolve(),
      enrich: () => Promise.resolve(null),
      enrichBatch: () => Promise.resolve([]),
      shutdown: () => Promise.resolve(),
    };
  }

  it('should register and retrieve enrichers by language ID', () => {
    const registry = new EnricherRegistry();
    const php = createMockEnricher('php', ['.php']);
    registry.register(php);

    expect(registry.get('php')).toBe(php);
    expect(registry.size).toBe(1);
  });

  it('should look up enrichers by file extension', () => {
    const registry = new EnricherRegistry();
    const php = createMockEnricher('php', ['.php', '.phtml']);
    registry.register(php);

    expect(registry.getByExtension('.php')).toBe(php);
    expect(registry.getByExtension('.phtml')).toBe(php);
    expect(registry.getByExtension('.ts')).toBeUndefined();
  });

  it('should throw on duplicate registration', () => {
    const registry = new EnricherRegistry();
    registry.register(createMockEnricher('php', ['.php']));
    expect(() => registry.register(createMockEnricher('php', ['.php']))).toThrow(
      'already registered'
    );
  });

  it('should unregister enrichers', () => {
    const registry = new EnricherRegistry();
    registry.register(createMockEnricher('php', ['.php']));
    expect(registry.unregister('php')).toBe(true);
    expect(registry.get('php')).toBeUndefined();
    expect(registry.getByExtension('.php')).toBeUndefined();
  });

  it('should list all supported extensions', () => {
    const registry = new EnricherRegistry();
    registry.register(createMockEnricher('php', ['.php', '.phtml']));
    registry.register(createMockEnricher('typescript', ['.ts', '.tsx']));

    const extensions = registry.getSupportedExtensions();
    expect(extensions).toContain('.php');
    expect(extensions).toContain('.phtml');
    expect(extensions).toContain('.ts');
    expect(extensions).toContain('.tsx');
  });
});

// ---------------------------------------------------------------------------
// Conversion helpers tests
// ---------------------------------------------------------------------------

describe('LSP type conversion helpers', () => {
  it('should convert DocumentSymbol to EnrichedSymbol', () => {
    const symbol: DocumentSymbol = {
      name: 'UserController',
      kind: 5, // Class
      range: { start: { line: 10, character: 0 }, end: { line: 50, character: 1 } },
      selectionRange: { start: { line: 10, character: 6 }, end: { line: 10, character: 20 } },
      children: [
        {
          name: 'index',
          kind: 6, // Method
          range: { start: { line: 12, character: 4 }, end: { line: 20, character: 5 } },
          selectionRange: { start: { line: 12, character: 21 }, end: { line: 12, character: 26 } },
        },
      ],
    };

    const enriched = toEnrichedSymbol(symbol);
    expect(enriched.name).toBe('UserController');
    expect(enriched.kind).toBe(5);
    expect(enriched.kindLabel).toBe('Class');
    expect(enriched.startLine).toBe(10);
    expect(enriched.endLine).toBe(50);
    expect(enriched.children).toHaveLength(1);
    expect(enriched.children![0].name).toBe('index');
    expect(enriched.children![0].kindLabel).toBe('Method');
  });

  it('should convert Diagnostic to EnrichedDiagnostic', () => {
    const diagnostic: Diagnostic = {
      range: { start: { line: 15, character: 0 }, end: { line: 15, character: 10 } },
      message: 'Undefined variable $user',
      severity: 1,
      source: 'intelephense',
      code: 1003,
    };

    const enriched = toEnrichedDiagnostic(diagnostic);
    expect(enriched.line).toBe(15);
    expect(enriched.severity).toBe(1);
    expect(enriched.severityLabel).toBe('Error');
    expect(enriched.message).toBe('Undefined variable $user');
    expect(enriched.source).toBe('intelephense');
    expect(enriched.code).toBe(1003);
  });

  it('should convert Location to EnrichedDefinition', () => {
    const location: Location = {
      uri: 'file:///app/Models/User.php',
      range: { start: { line: 8, character: 0 }, end: { line: 8, character: 20 } },
    };

    const enriched = toEnrichedDefinition('User', location);
    expect(enriched.symbolName).toBe('User');
    expect(enriched.targetUri).toBe('file:///app/Models/User.php');
    expect(enriched.targetStartLine).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// extractLspRelationships tests
// ---------------------------------------------------------------------------

describe('extractLspRelationships', () => {
  it('should return null for undefined metadata', () => {
    expect(extractLspRelationships(undefined)).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    expect(extractLspRelationships('not-json{{{')).toBeNull();
  });

  it('should return null for metadata without lsp field', () => {
    expect(extractLspRelationships(JSON.stringify({ name: 'test' }))).toBeNull();
  });

  it('should return null for empty lsp data', () => {
    expect(extractLspRelationships(JSON.stringify({ lsp: {} }))).toBeNull();
  });

  it('should extract extends relationships from type hierarchy', () => {
    const metadata = JSON.stringify({
      lsp: {
        typeHierarchy: [
          { name: 'UserController', supertypes: [{ name: 'Controller' }], subtypes: [] },
        ],
      },
    });
    const result = extractLspRelationships(metadata);
    expect(result).toContain('**extends**');
    expect(result).toContain('UserController');
    expect(result).toContain('Controller');
  });

  it('should extract implements relationships from subtypes', () => {
    const metadata = JSON.stringify({
      lsp: {
        typeHierarchy: [
          { name: 'PaymentGateway', supertypes: [], subtypes: [{ name: 'StripeGateway' }] },
        ],
      },
    });
    const result = extractLspRelationships(metadata);
    expect(result).toContain('**implements**');
    expect(result).toContain('StripeGateway');
  });

  it('should extract dependencies from definitions', () => {
    const metadata = JSON.stringify({
      lsp: {
        definitions: [{ symbolName: 'User', targetUri: 'file:///app/Models/User.php' }],
      },
    });
    const result = extractLspRelationships(metadata);
    expect(result).toContain('**dependencies**');
    expect(result).toContain('User.php');
  });

  it('should extract referenced_by from references', () => {
    const metadata = JSON.stringify({
      lsp: {
        references: [
          {
            symbolName: 'User',
            referenceCount: 2,
            referenceLocations: [
              { uri: 'file:///app/Controllers/UserController.php' },
              { uri: 'file:///app/Services/AuthService.php' },
            ],
          },
        ],
      },
    });
    const result = extractLspRelationships(metadata);
    expect(result).toContain('**referenced_by**');
    expect(result).toContain('UserController.php');
    expect(result).toContain('AuthService.php');
  });

  it('should extract symbol outline', () => {
    const metadata = JSON.stringify({
      lsp: {
        symbols: [
          { name: 'User', kindLabel: 'Class' },
          { name: 'getFullName', kindLabel: 'Method' },
        ],
      },
    });
    const result = extractLspRelationships(metadata);
    expect(result).toContain('**symbols**');
    expect(result).toContain('Class `User`');
    expect(result).toContain('Method `getFullName`');
  });
});

// ---------------------------------------------------------------------------
// buildAugmentedQuery with LSP relationship data
// ---------------------------------------------------------------------------

describe('buildAugmentedQuery with LSP metadata', () => {
  it('should include LSP extends relationships from metadata', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/app/Http/Controllers/UserController.php',
        rank: 0,
        content: 'Controller code here',
        title: 'UserController',
        metadata: JSON.stringify({
          lsp: {
            typeHierarchy: [
              {
                name: 'UserController',
                supertypes: [{ name: 'Controller' }, { name: 'AuthorizesRequests' }],
                subtypes: [],
              },
            ],
          },
        }),
      },
    ];

    const result = buildAugmentedQuery('How does user authentication work?', hits);
    expect(result).toContain('**extends**');
    expect(result).toContain('UserController');
    expect(result).toContain('Controller');
    expect(result).toContain('AuthorizesRequests');
  });

  it('should include LSP implements relationships from metadata', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/app/Contracts/PaymentGateway.php',
        rank: 0,
        content: 'Interface code',
        title: 'PaymentGateway',
        metadata: JSON.stringify({
          lsp: {
            typeHierarchy: [
              {
                name: 'PaymentGateway',
                supertypes: [],
                subtypes: [{ name: 'StripeGateway' }, { name: 'PayPalGateway' }],
              },
            ],
          },
        }),
      },
    ];

    const result = buildAugmentedQuery('What payment gateways exist?', hits);
    expect(result).toContain('**implements**');
    expect(result).toContain('StripeGateway');
    expect(result).toContain('PayPalGateway');
  });

  it('should include cross-module dependencies from definitions', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/app/Services/OrderService.php',
        rank: 0,
        content: 'Order processing service',
        title: 'OrderService',
        metadata: JSON.stringify({
          lsp: {
            definitions: [
              { symbolName: 'User', targetUri: 'file:///app/Models/User.php' },
              { symbolName: 'Invoice', targetUri: 'file:///app/Models/Invoice.php' },
              {
                symbolName: 'PaymentGateway',
                targetUri: 'file:///app/Contracts/PaymentGateway.php',
              },
            ],
          },
        }),
      },
    ];

    const result = buildAugmentedQuery('How does order processing work?', hits);
    expect(result).toContain('**dependencies**');
    expect(result).toContain('User.php');
    expect(result).toContain('Invoice.php');
    expect(result).toContain('PaymentGateway.php');
  });

  it('should include referenced_by data from references', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/app/Models/User.php',
        rank: 0,
        content: 'User model',
        title: 'User',
        metadata: JSON.stringify({
          lsp: {
            references: [
              {
                symbolName: 'User',
                referenceCount: 3,
                referenceLocations: [
                  { uri: 'file:///app/Http/Controllers/UserController.php' },
                  { uri: 'file:///app/Services/AuthService.php' },
                  { uri: 'file:///app/Services/OrderService.php' },
                ],
              },
            ],
          },
        }),
      },
    ];

    const result = buildAugmentedQuery('Where is the User model used?', hits);
    expect(result).toContain('**referenced_by**');
    expect(result).toContain('UserController.php');
    expect(result).toContain('AuthService.php');
    expect(result).toContain('OrderService.php');
  });

  it('should include symbol outline from LSP data', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/app/Models/User.php',
        rank: 0,
        content: 'User model code',
        title: 'User',
        metadata: JSON.stringify({
          lsp: {
            symbols: [
              { name: 'User', kindLabel: 'Class' },
              { name: 'getFullName', kindLabel: 'Method' },
              { name: 'orders', kindLabel: 'Method' },
            ],
          },
        }),
      },
    ];

    const result = buildAugmentedQuery('What methods does User have?', hits);
    expect(result).toContain('**symbols**');
    expect(result).toContain('Class `User`');
    expect(result).toContain('Method `getFullName`');
    expect(result).toContain('Method `orders`');
  });

  it('should combine LSP data with document content', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/app/Services/PaymentService.php',
        rank: 0,
        content:
          '<?php\nclass PaymentService extends BaseService\n{\n    public function charge() {}\n}',
        title: 'PaymentService',
        metadata: JSON.stringify({
          lsp: {
            typeHierarchy: [
              {
                name: 'PaymentService',
                supertypes: [{ name: 'BaseService' }],
                subtypes: [],
              },
            ],
            definitions: [
              {
                symbolName: 'PaymentGateway',
                targetUri: 'file:///app/Contracts/PaymentGateway.php',
              },
            ],
            references: [
              {
                symbolName: 'PaymentService',
                referenceCount: 2,
                referenceLocations: [
                  { uri: 'file:///app/Http/Controllers/CheckoutController.php' },
                  { uri: 'file:///app/Jobs/ProcessPayment.php' },
                ],
              },
            ],
            symbols: [
              { name: 'PaymentService', kindLabel: 'Class' },
              { name: 'charge', kindLabel: 'Method' },
            ],
          },
        }),
      },
    ];

    const result = buildAugmentedQuery('How does payment processing work?', hits);

    // LSP relationship data should appear
    expect(result).toContain('LSP Relationships');
    expect(result).toContain('**extends**');
    expect(result).toContain('BaseService');
    expect(result).toContain('**dependencies**');
    expect(result).toContain('PaymentGateway.php');
    expect(result).toContain('**referenced_by**');
    expect(result).toContain('CheckoutController.php');
    expect(result).toContain('ProcessPayment.php');
    expect(result).toContain('**symbols**');
    expect(result).toContain('Class `PaymentService`');

    // Document content should also appear
    expect(result).toContain('class PaymentService');
    expect(result).toContain('## Question');
  });

  it('should handle hits with metadata but no LSP data', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/doc.md',
        rank: 0,
        content: 'Regular doc content',
        title: 'Doc',
        metadata: JSON.stringify({ name: 'Just frontmatter' }),
      },
    ];

    const result = buildAugmentedQuery('Q?', hits);
    expect(result).toContain('Regular doc content');
    expect(result).not.toContain('LSP Relationships');
  });

  it('should handle malformed metadata JSON gracefully', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/doc.md',
        rank: 0,
        content: 'Content here',
        title: 'Doc',
        metadata: 'not-valid-json{{{',
      },
    ];

    const result = buildAugmentedQuery('Q?', hits);
    expect(result).toContain('Content here');
    expect(result).not.toContain('LSP Relationships');
  });

  it('should use 150KB default context budget', () => {
    // Create a hit with ~100KB of content — should fit in the new 150KB budget
    const bigContent = 'x'.repeat(100_000);
    const hits: FtsHit[] = [
      { filePath: '/big.md', rank: 0, content: bigContent, title: 'Big Doc' },
    ];

    const result = buildAugmentedQuery('Q?', hits);
    // With the old 30KB budget this would be truncated
    // With 150KB it should fit
    expect(result).not.toContain('[...truncated]');
    expect(result).toContain('Big Doc');
  });
});

// ---------------------------------------------------------------------------
// generalScan pipeline tests
// ---------------------------------------------------------------------------

describe('generalScan pipeline', () => {
  beforeEach(setupCorpus);
  afterEach(cleanupCorpus);

  it('should scan CORPUS without enrichment when LSP is disabled', async () => {
    const result = await generalScan(corpusDir);

    expect(result.scan.knowledge.length).toBeGreaterThan(0);
    expect(result.enrichments.size).toBe(0);
    expect(result.stats.activeEnrichers).toBe(0);
    expect(result.stats.enrichedFiles).toBe(0);
  });

  it('should report zero enrichers when config has LSP enabled but no known enrichers', async () => {
    const progress: string[] = [];
    const result = await generalScan(corpusDir, {
      config: {
        lsp: {
          enabled: true,
          enrichers: [{ languageId: 'unknown-lang', enabled: true }],
        },
        deps: { enabled: true },
      },
      onProgress: (msg) => progress.push(msg),
    });

    expect(result.stats.activeEnrichers).toBe(0);
    expect(progress.some((m) => m.includes('No LSP enrichers configured'))).toBe(true);
  });

  it('should still rebuild overlay when LSP is disabled', async () => {
    writeFileSync(join(corpusDir, 'package.json'), '{}');
    writeFileSync(join(corpusDir, 'ExampleController.php'), '<?php\nclass ExampleController {}\n');

    const dbPath = join(corpusDir, 'overlay-no-lsp.db');
    const db = new LuxDatabase(dbPath);

    try {
      const result = await generalScan(corpusDir, {
        config: {
          lsp: { enabled: false, enrichers: [] },
          deps: { enabled: true },
        },
        db,
        overlayEnabled: true,
      });

      expect(result.overlay).toBeDefined();
      expect(result.overlay!.fileNodes).toBeGreaterThan(0);
      expect(db.getStructuralNodesByType('file').length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('should still rebuild overlay when no known enrichers are configured', async () => {
    writeFileSync(join(corpusDir, 'package.json'), '{}');
    writeFileSync(join(corpusDir, 'ExampleController.php'), '<?php\nclass ExampleController {}\n');

    const dbPath = join(corpusDir, 'overlay-no-known-enrichers.db');
    const db = new LuxDatabase(dbPath);

    try {
      const result = await generalScan(corpusDir, {
        config: {
          lsp: {
            enabled: true,
            enrichers: [{ languageId: 'unknown-lang', enabled: true }],
          },
          deps: { enabled: true },
        },
        db,
        overlayEnabled: true,
      });

      expect(result.overlay).toBeDefined();
      expect(result.overlay!.fileNodes).toBeGreaterThan(0);
      expect(db.getStructuralNodesByType('file').length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// attachEnrichment tests
// ---------------------------------------------------------------------------

describe('attachEnrichment', () => {
  it('should merge enrichment data into frontmatter.lsp', () => {
    const entry = {
      type: 'code',
      title: 'UserController',
      filePath: '/app/Http/Controllers/UserController.php',
      frontmatter: { name: 'UserController' },
    };

    const enrichment: EnrichmentResult = {
      filePath: '/app/Http/Controllers/UserController.php',
      languageId: 'php',
      symbols: [
        { name: 'UserController', kind: 5, kindLabel: 'Class', startLine: 10, endLine: 50 },
      ],
      diagnostics: [],
      definitions: [
        {
          symbolName: 'Controller',
          targetUri: 'file:///app/Http/Controller.php',
          targetStartLine: 5,
        },
      ],
      enrichedAt: 1700000000,
    };

    const enrichments = new Map([[entry.filePath, enrichment]]);
    const result = attachEnrichment(entry, enrichments);

    expect(result.frontmatter).toBeDefined();
    const lsp = (result.frontmatter as Record<string, unknown>).lsp as Record<string, unknown>;
    expect(lsp).toBeDefined();
    expect(lsp.languageId).toBe('php');
    expect(lsp.enrichedAt).toBe(1700000000);
    expect((lsp.symbols as unknown[]).length).toBe(1);
    expect((lsp.definitions as unknown[]).length).toBe(1);
  });

  it('should preserve references and typeHierarchy from PHP enrichment', () => {
    const entry = {
      type: 'source-code',
      title: 'InvoiceService',
      filePath: '/app/Services/InvoiceService.php',
      frontmatter: { language: 'php' },
    };

    const phpEnrichment = {
      filePath: '/app/Services/InvoiceService.php',
      languageId: 'php',
      symbols: [{ name: 'InvoiceService', kind: 5, kindLabel: 'Class', startLine: 5, endLine: 40 }],
      diagnostics: [],
      definitions: [],
      references: [
        {
          symbolName: 'InvoiceService',
          symbolKind: 5,
          referenceCount: 3,
          referenceLocations: [{ uri: 'file:///app/Controllers/InvoiceController.php', line: 10 }],
        },
      ],
      typeHierarchy: [
        {
          name: 'InvoiceService',
          kind: 5,
          uri: 'file:///app/Services/InvoiceService.php',
          startLine: 5,
          supertypes: [{ name: 'BaseService', uri: 'file:///app/Services/BaseService.php', kind: 5 }],
          subtypes: [],
        },
      ],
      enrichedAt: 1700000001,
    };

    const enrichments = new Map([[entry.filePath, phpEnrichment]]);
    const result = attachEnrichment(entry, enrichments);
    const lsp = (result.frontmatter as Record<string, unknown>).lsp as Record<string, unknown>;

    expect(lsp.references).toBeDefined();
    expect((lsp.references as unknown[]).length).toBe(1);
    const ref = (lsp.references as Record<string, unknown>[])[0];
    expect(ref.symbolName).toBe('InvoiceService');
    expect(ref.referenceCount).toBe(3);

    expect(lsp.typeHierarchy).toBeDefined();
    expect((lsp.typeHierarchy as unknown[]).length).toBe(1);
    const th = (lsp.typeHierarchy as Record<string, unknown>[])[0];
    expect(th.name).toBe('InvoiceService');
    const supertypes = th.supertypes as Array<Record<string, unknown>>;
    expect(supertypes[0].name).toBe('BaseService');
  });

  it('should return entry unchanged when no enrichment exists', () => {
    const entry = {
      type: 'doc',
      title: 'README',
      filePath: '/docs/README.md',
    };

    const enrichments = new Map<string, EnrichmentResult>();
    const result = attachEnrichment(entry, enrichments);
    expect(result).toBe(entry);
  });
});

// ---------------------------------------------------------------------------
// Cross-module dependency tracing validation
// ---------------------------------------------------------------------------

describe('cross-module dependency tracing', () => {
  it('should trace a full dependency chain across multiple modules', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/app/Http/Controllers/CheckoutController.php',
        rank: 0,
        content: 'Handles checkout flow',
        title: 'CheckoutController',
        metadata: JSON.stringify({
          lsp: {
            typeHierarchy: [
              { name: 'CheckoutController', supertypes: [{ name: 'Controller' }], subtypes: [] },
            ],
            definitions: [
              { symbolName: 'OrderService', targetUri: 'file:///app/Services/OrderService.php' },
              { symbolName: 'Request', targetUri: 'file:///vendor/laravel/framework/Request.php' },
            ],
            symbols: [
              { name: 'CheckoutController', kindLabel: 'Class' },
              { name: 'store', kindLabel: 'Method' },
            ],
          },
        }),
      },
      {
        filePath: '/app/Services/OrderService.php',
        rank: 0,
        content: 'Processes orders with payment',
        title: 'OrderService',
        metadata: JSON.stringify({
          lsp: {
            definitions: [
              {
                symbolName: 'PaymentGateway',
                targetUri: 'file:///app/Contracts/PaymentGateway.php',
              },
              { symbolName: 'Order', targetUri: 'file:///app/Models/Order.php' },
              { symbolName: 'User', targetUri: 'file:///app/Models/User.php' },
            ],
            references: [
              {
                symbolName: 'OrderService',
                referenceCount: 2,
                referenceLocations: [
                  { uri: 'file:///app/Http/Controllers/CheckoutController.php' },
                  { uri: 'file:///app/Http/Controllers/OrderController.php' },
                ],
              },
            ],
            symbols: [
              { name: 'OrderService', kindLabel: 'Class' },
              { name: 'createOrder', kindLabel: 'Method' },
              { name: 'processPayment', kindLabel: 'Method' },
            ],
          },
        }),
      },
      {
        filePath: '/app/Contracts/PaymentGateway.php',
        rank: 0,
        content: 'Payment gateway interface',
        title: 'PaymentGateway',
        metadata: JSON.stringify({
          lsp: {
            typeHierarchy: [
              {
                name: 'PaymentGateway',
                supertypes: [],
                subtypes: [{ name: 'StripeGateway' }, { name: 'PayPalGateway' }],
              },
            ],
            references: [
              {
                symbolName: 'PaymentGateway',
                referenceCount: 3,
                referenceLocations: [
                  { uri: 'file:///app/Services/OrderService.php' },
                  { uri: 'file:///app/Providers/AppServiceProvider.php' },
                  { uri: 'file:///app/Services/RefundService.php' },
                ],
              },
            ],
          },
        }),
      },
    ];

    const result = buildAugmentedQuery('How does the checkout flow process payments?', hits);

    // Verify the full dependency chain is visible in the augmented query:
    // 1. CheckoutController extends Controller
    expect(result).toContain('CheckoutController');
    expect(result).toContain('Controller');

    // 2. CheckoutController depends on OrderService
    expect(result).toContain('OrderService.php');

    // 3. OrderService depends on PaymentGateway, Order, User
    expect(result).toContain('PaymentGateway.php');
    expect(result).toContain('Order.php');
    expect(result).toContain('User.php');

    // 4. OrderService is referenced by controllers
    expect(result).toContain('CheckoutController.php');
    expect(result).toContain('OrderController.php');

    // 5. PaymentGateway is implemented by StripeGateway and PayPalGateway
    expect(result).toContain('StripeGateway');
    expect(result).toContain('PayPalGateway');

    // 6. PaymentGateway is referenced across modules
    expect(result).toContain('AppServiceProvider.php');
    expect(result).toContain('RefundService.php');
  });

  it('should trace bidirectional relationships (who uses me + what I use)', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/app/Models/User.php',
        rank: 0,
        content: 'Eloquent User model',
        title: 'User',
        metadata: JSON.stringify({
          lsp: {
            typeHierarchy: [
              { name: 'User', supertypes: [{ name: 'Authenticatable' }], subtypes: [] },
            ],
            definitions: [
              {
                symbolName: 'HasFactory',
                targetUri: 'file:///vendor/laravel/framework/HasFactory.php',
              },
              { symbolName: 'Order', targetUri: 'file:///app/Models/Order.php' },
            ],
            references: [
              {
                symbolName: 'User',
                referenceCount: 5,
                referenceLocations: [
                  { uri: 'file:///app/Http/Controllers/UserController.php' },
                  { uri: 'file:///app/Services/AuthService.php' },
                  { uri: 'file:///app/Services/OrderService.php' },
                  { uri: 'file:///app/Policies/UserPolicy.php' },
                  { uri: 'file:///database/seeders/UserSeeder.php' },
                ],
              },
            ],
            symbols: [
              { name: 'User', kindLabel: 'Class' },
              { name: 'orders', kindLabel: 'Method' },
              { name: 'getFullName', kindLabel: 'Method' },
            ],
          },
        }),
      },
    ];

    const result = buildAugmentedQuery('What are the User model relationships?', hits);

    // What User extends
    expect(result).toContain('Authenticatable');

    // What User depends on (outbound)
    expect(result).toContain('Order.php');
    expect(result).toContain('HasFactory.php');

    // Who depends on User (inbound)
    expect(result).toContain('UserController.php');
    expect(result).toContain('AuthService.php');
    expect(result).toContain('OrderService.php');
    expect(result).toContain('UserPolicy.php');
    expect(result).toContain('UserSeeder.php');

    // Symbol outline
    expect(result).toContain('Class `User`');
    expect(result).toContain('Method `orders`');
  });
});
