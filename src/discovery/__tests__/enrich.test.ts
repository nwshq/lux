import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import {
  enrichContext,
  aggregateFileCountsByDirectory,
  extractSymbolSummaries,
  extractCrossReferences,
} from '../enrich.js';
import type { KnowledgeEntryInsert } from '../../db/types.js';

/** Helper to create knowledge entry with all required named params. */
function makeEntry(
  overrides: Partial<KnowledgeEntryInsert> &
    Pick<KnowledgeEntryInsert, 'type' | 'title' | 'file_path'>
): KnowledgeEntryInsert {
  return {
    tags: undefined,
    metadata: undefined,
    content: undefined,
    ...overrides,
  };
}

// ── Test Setup ─────────────────────────────────────────────

let dbDir: string;
let db: LuxDatabase;
const contentRoot = '/project';

beforeEach(() => {
  dbDir = join(tmpdir(), `lux-enrich-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dbDir, { recursive: true });
  db = new LuxDatabase(join(dbDir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// aggregateFileCountsByDirectory
// ---------------------------------------------------------------------------

describe('aggregateFileCountsByDirectory', () => {
  it('should count files per directory', () => {
    db.insertKnowledgeEntry(
      makeEntry({ type: 'source', title: 'A', file_path: '/project/modules/Auth/User.php' })
    );
    db.insertKnowledgeEntry(
      makeEntry({ type: 'source', title: 'B', file_path: '/project/modules/Auth/Login.php' })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'C',
        file_path: '/project/modules/Billing/Invoice.php',
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const counts = aggregateFileCountsByDirectory(entries, contentRoot);

    expect(counts['modules/Auth']).toBe(2);
    expect(counts['modules/Billing']).toBe(1);
  });

  it('should return "." for files at content root', () => {
    db.insertKnowledgeEntry(
      makeEntry({ type: 'doc', title: 'Root', file_path: '/project/README.md' })
    );

    const entries = db.getAllKnowledgeEntries();
    const counts = aggregateFileCountsByDirectory(entries, contentRoot);

    expect(counts['.']).toBe(1);
  });

  it('should return empty record for no entries', () => {
    const entries = db.getAllKnowledgeEntries();
    const counts = aggregateFileCountsByDirectory(entries, contentRoot);

    expect(Object.keys(counts)).toHaveLength(0);
  });

  it('should handle deeply nested directories', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'A',
        file_path: '/project/src/app/models/User.ts',
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'B',
        file_path: '/project/src/app/models/Post.ts',
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'C',
        file_path: '/project/src/app/controllers/UserController.ts',
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const counts = aggregateFileCountsByDirectory(entries, contentRoot);

    expect(counts['src/app/models']).toBe(2);
    expect(counts['src/app/controllers']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractSymbolSummaries
// ---------------------------------------------------------------------------

describe('extractSymbolSummaries', () => {
  it('should extract class and method names from LSP metadata', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'User Model',
        file_path: '/project/app/Models/User.php',
        metadata: {
          lsp: {
            symbols: [
              {
                name: 'User',
                kind: 5,
                kindLabel: 'Class',
                children: [
                  { name: 'getFullName', kind: 6, kindLabel: 'Method' },
                  { name: 'isAdmin', kind: 6, kindLabel: 'Method' },
                ],
              },
            ],
            definitions: [],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const summaries = extractSymbolSummaries(entries, contentRoot);

    expect(summaries['app/Models']).toBeDefined();
    expect(summaries['app/Models']).toContain('User');
    expect(summaries['app/Models']).toContain('getFullName');
    expect(summaries['app/Models']).toContain('isAdmin');
  });

  it('should prioritize classes and interfaces over methods', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Service',
        file_path: '/project/app/Services/PaymentService.php',
        metadata: {
          lsp: {
            symbols: [
              { name: 'processPayment', kind: 6, kindLabel: 'Method' },
              { name: 'PaymentService', kind: 5, kindLabel: 'Class' },
              { name: 'PaymentGateway', kind: 11, kindLabel: 'Interface' },
            ],
            definitions: [],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const summaries = extractSymbolSummaries(entries, contentRoot);

    const symbols = summaries['app/Services'];
    expect(symbols).toBeDefined();

    const classIdx = symbols.indexOf('PaymentService');
    const ifaceIdx = symbols.indexOf('PaymentGateway');
    const methodIdx = symbols.indexOf('processPayment');

    expect(classIdx).toBeLessThan(methodIdx);
    expect(ifaceIdx).toBeLessThan(methodIdx);
  });

  it('should skip entries without LSP metadata', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'doc',
        title: 'README',
        file_path: '/project/README.md',
        content: 'Just a readme',
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const summaries = extractSymbolSummaries(entries, contentRoot);

    expect(Object.keys(summaries)).toHaveLength(0);
  });

  it('should aggregate symbols across files in the same directory', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'User',
        file_path: '/project/app/Models/User.php',
        metadata: {
          lsp: {
            symbols: [{ name: 'User', kind: 5, kindLabel: 'Class' }],
            definitions: [],
          },
        },
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Post',
        file_path: '/project/app/Models/Post.php',
        metadata: {
          lsp: {
            symbols: [{ name: 'Post', kind: 5, kindLabel: 'Class' }],
            definitions: [],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const summaries = extractSymbolSummaries(entries, contentRoot);

    expect(summaries['app/Models']).toContain('User');
    expect(summaries['app/Models']).toContain('Post');
  });

  it('should return empty record for entries with metadata but no lsp field', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Bad',
        file_path: '/project/bad.php',
        metadata: { some_other_field: 'value' },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const summaries = extractSymbolSummaries(entries, contentRoot);

    expect(Object.keys(summaries)).toHaveLength(0);
  });

  it('should limit symbols per directory to MAX_SYMBOLS_PER_DIR', () => {
    const symbols = Array.from({ length: 25 }, (_, i) => ({
      name: `Symbol${i}`,
      kind: 5,
      kindLabel: 'Class',
    }));

    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Many Symbols',
        file_path: '/project/app/Large/File.php',
        metadata: { lsp: { symbols, definitions: [] } },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const summaries = extractSymbolSummaries(entries, contentRoot);

    expect(summaries['app/Large'].length).toBeLessThanOrEqual(15);
  });

  it('should traverse deeply nested symbol children (multi-level recursion)', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Module',
        file_path: '/project/app/Modules/Core.ts',
        metadata: {
          lsp: {
            symbols: [
              {
                name: 'CoreModule',
                kind: 5,
                kindLabel: 'Class',
                children: [
                  {
                    name: 'configure',
                    kind: 6,
                    kindLabel: 'Method',
                    children: [{ name: 'InnerHelper', kind: 12, kindLabel: 'Function' }],
                  },
                ],
              },
            ],
            definitions: [],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const summaries = extractSymbolSummaries(entries, contentRoot);

    expect(summaries['app/Modules']).toContain('CoreModule');
    expect(summaries['app/Modules']).toContain('configure');
    expect(summaries['app/Modules']).toContain('InnerHelper');
  });

  it('should handle empty symbols array in LSP metadata', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Empty',
        file_path: '/project/app/Empty/File.ts',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const summaries = extractSymbolSummaries(entries, contentRoot);

    expect(summaries['app/Empty']).toBeUndefined();
  });

  it('should upgrade priority when same symbol appears as both method and class', () => {
    // First file has 'Shared' as a method (low priority)
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'A',
        file_path: '/project/app/Shared/A.ts',
        metadata: {
          lsp: {
            symbols: [{ name: 'Shared', kind: 6, kindLabel: 'Method' }],
            definitions: [],
          },
        },
      })
    );
    // Second file has 'Shared' as a class (high priority)
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'B',
        file_path: '/project/app/Shared/B.ts',
        metadata: {
          lsp: {
            symbols: [
              { name: 'Shared', kind: 5, kindLabel: 'Class' },
              { name: 'helper', kind: 6, kindLabel: 'Method' },
            ],
            definitions: [],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const summaries = extractSymbolSummaries(entries, contentRoot);

    // 'Shared' should appear before 'helper' because class priority beats method
    const sharedIdx = summaries['app/Shared'].indexOf('Shared');
    const helperIdx = summaries['app/Shared'].indexOf('helper');
    expect(sharedIdx).toBeLessThan(helperIdx);
  });
});

// ---------------------------------------------------------------------------
// extractCrossReferences
// ---------------------------------------------------------------------------

describe('extractCrossReferences', () => {
  it('should extract cross-directory references from definitions', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'InvoiceController',
        file_path: '/project/app/Controllers/InvoiceController.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              {
                symbolName: 'Invoice',
                targetUri: 'file:///project/app/Models/Invoice.php',
                targetStartLine: 10,
              },
              {
                symbolName: 'InvoiceService',
                targetUri: 'file:///project/app/Services/InvoiceService.php',
                targetStartLine: 5,
              },
            ],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    expect(refs).toHaveLength(2);

    const toModels = refs.find((r) => r.targetDir === 'app/Models');
    expect(toModels).toBeDefined();
    expect(toModels!.sourceDir).toBe('app/Controllers');
    expect(toModels!.referenceCount).toBe(1);

    const toServices = refs.find((r) => r.targetDir === 'app/Services');
    expect(toServices).toBeDefined();
    expect(toServices!.sourceDir).toBe('app/Controllers');
  });

  it('should skip self-references within the same directory', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'User',
        file_path: '/project/app/Models/User.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              {
                symbolName: 'Post',
                targetUri: 'file:///project/app/Models/Post.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    expect(refs).toHaveLength(0);
  });

  it('should aggregate reference counts between same directory pairs', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Controller A',
        file_path: '/project/app/Controllers/A.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              {
                symbolName: 'User',
                targetUri: 'file:///project/app/Models/User.php',
                targetStartLine: 1,
              },
              {
                symbolName: 'Post',
                targetUri: 'file:///project/app/Models/Post.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Controller B',
        file_path: '/project/app/Controllers/B.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              {
                symbolName: 'User',
                targetUri: 'file:///project/app/Models/User.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    const controllerToModel = refs.find(
      (r) => r.sourceDir === 'app/Controllers' && r.targetDir === 'app/Models'
    );
    expect(controllerToModel).toBeDefined();
    expect(controllerToModel!.referenceCount).toBe(3);
  });

  it('should sort references by count descending', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Main',
        file_path: '/project/app/Main.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              { symbolName: 'A', targetUri: 'file:///project/lib/A.php', targetStartLine: 1 },
              { symbolName: 'B', targetUri: 'file:///project/vendor/B.php', targetStartLine: 1 },
              { symbolName: 'C', targetUri: 'file:///project/vendor/C.php', targetStartLine: 1 },
              { symbolName: 'D', targetUri: 'file:///project/vendor/D.php', targetStartLine: 1 },
            ],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    expect(refs[0].targetDir).toBe('vendor');
    expect(refs[0].referenceCount).toBe(3);
    expect(refs[1].targetDir).toBe('lib');
    expect(refs[1].referenceCount).toBe(1);
  });

  it('should handle file:// URIs with encoded characters', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Test',
        file_path: '/project/src/Test.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              {
                symbolName: 'Helper',
                targetUri: 'file:///project/lib%20utils/Helper.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    expect(refs).toHaveLength(1);
    expect(refs[0].targetDir).toBe('lib utils');
  });

  it('should handle plain absolute paths as target URIs', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Test',
        file_path: '/project/src/Test.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              {
                symbolName: 'Util',
                targetUri: '/project/lib/Util.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    expect(refs).toHaveLength(1);
    expect(refs[0].sourceDir).toBe('src');
    expect(refs[0].targetDir).toBe('lib');
  });

  it('should skip relative target URIs', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Test',
        file_path: '/project/src/Test.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              {
                symbolName: 'Rel',
                targetUri: 'relative/path.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    expect(refs).toHaveLength(0);
  });

  it('should return empty array for entries without definitions', () => {
    db.insertKnowledgeEntry(
      makeEntry({ type: 'doc', title: 'README', file_path: '/project/README.md' })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    expect(refs).toHaveLength(0);
  });

  it('should track bidirectional references as separate entries', () => {
    // Controllers reference Models
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'UserController',
        file_path: '/project/app/Controllers/UserController.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              {
                symbolName: 'User',
                targetUri: 'file:///project/app/Models/User.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );
    // Models reference Controllers (reverse dependency)
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'User',
        file_path: '/project/app/Models/User.php',
        metadata: {
          lsp: {
            symbols: [],
            definitions: [
              {
                symbolName: 'UserController',
                targetUri: 'file:///project/app/Controllers/UserController.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    expect(refs).toHaveLength(2);

    const cToM = refs.find(
      (r) => r.sourceDir === 'app/Controllers' && r.targetDir === 'app/Models'
    );
    const mToC = refs.find(
      (r) => r.sourceDir === 'app/Models' && r.targetDir === 'app/Controllers'
    );
    expect(cToM).toBeDefined();
    expect(mToC).toBeDefined();
    expect(cToM!.referenceCount).toBe(1);
    expect(mToC!.referenceCount).toBe(1);
  });

  it('should handle entries with empty definitions array', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Test',
        file_path: '/project/src/Test.php',
        metadata: {
          lsp: {
            symbols: [{ name: 'Test', kind: 5, kindLabel: 'Class' }],
            definitions: [],
          },
        },
      })
    );

    const entries = db.getAllKnowledgeEntries();
    const refs = extractCrossReferences(entries, contentRoot);

    expect(refs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// enrichContext (EnrichContextFn implementation)
// ---------------------------------------------------------------------------

describe('enrichContext', () => {
  it('should return full context with tree, file counts, and existing experts', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'User',
        file_path: '/project/app/Models/User.php',
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Post',
        file_path: '/project/app/Models/Post.php',
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Controller',
        file_path: '/project/app/Controllers/PostController.php',
      })
    );

    const tree = 'project/\n├── app/\n│   ├── Models/\n│   └── Controllers/';
    const result = enrichContext(tree, db, { rootPath: contentRoot });

    // Tree is passed through
    expect(result.tree).toBe(tree);

    // File counts aggregated by directory
    expect(result.fileCountsByDirectory['app/Models']).toBe(2);
    expect(result.fileCountsByDirectory['app/Controllers']).toBe(1);

    // No existing experts
    expect(result.existingExperts).toHaveLength(0);
  });

  it('should include existing experts from the database', () => {
    db.insertExpert({
      slug: 'auth-expert',
      name: 'Auth Expert',
      mount_path: '/project/app/Auth',
    });
    db.insertExpert({
      slug: 'billing-expert',
      name: 'Billing Expert',
      mount_path: '/project/app/Billing',
    });

    const result = enrichContext('tree/', db, { rootPath: contentRoot });

    expect(result.existingExperts).toHaveLength(2);
    expect(result.existingExperts.map((e) => e.slug)).toContain('auth-expert');
    expect(result.existingExperts.map((e) => e.slug)).toContain('billing-expert');
    expect(result.existingExperts[0].mountPath).toBeDefined();
  });

  it('should include symbol summaries and cross-references from LSP data', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Invoice',
        file_path: '/project/app/Billing/Invoice.php',
        metadata: {
          lsp: {
            symbols: [{ name: 'Invoice', kind: 5, kindLabel: 'Class' }],
            definitions: [
              {
                symbolName: 'User',
                targetUri: 'file:///project/app/Models/User.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );

    const result = enrichContext('tree/', db, { rootPath: contentRoot });

    // Symbol summaries populated (optional field present when non-empty)
    expect(result.symbolSummaries).toBeDefined();
    expect(result.symbolSummaries!['app/Billing']).toContain('Invoice');

    // Cross-references populated (optional field present when non-empty)
    expect(result.crossReferences).toBeDefined();
    expect(result.crossReferences!.length).toBeGreaterThanOrEqual(1);
    expect(result.crossReferences![0].sourceDir).toBe('app/Billing');
    expect(result.crossReferences![0].targetDir).toBe('app/Models');
  });

  it('should return empty enrichment data for empty database', () => {
    const result = enrichContext('tree/', db, { rootPath: contentRoot });

    expect(result.tree).toBe('tree/');
    expect(Object.keys(result.fileCountsByDirectory)).toHaveLength(0);
    // symbolSummaries and crossReferences are omitted when empty
    expect(result.symbolSummaries).toBeUndefined();
    expect(result.crossReferences).toBeUndefined();
    expect(result.existingExperts).toHaveLength(0);
  });

  it('should use rootPath from options as content root for relative paths', () => {
    const customRoot = '/custom/root';
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'File',
        file_path: '/custom/root/src/lib/File.ts',
      })
    );

    const result = enrichContext('tree/', db, { rootPath: customRoot });

    expect(result.fileCountsByDirectory['src/lib']).toBe(1);
  });

  // Adapted from enrichDiscoveryContext integration tests

  it('should combine file counts, symbol summaries, and cross-references', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'User Model',
        file_path: '/project/app/Models/User.php',
        metadata: {
          lsp: {
            symbols: [{ name: 'User', kind: 5, kindLabel: 'Class' }],
            definitions: [
              {
                symbolName: 'HasFactory',
                targetUri: 'file:///project/vendor/laravel/HasFactory.php',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'doc',
        title: 'README',
        file_path: '/project/README.md',
        content: 'Project readme',
      })
    );

    const result = enrichContext('tree/', db, { rootPath: contentRoot });

    // File counts
    expect(result.fileCountsByDirectory['app/Models']).toBe(1);
    expect(result.fileCountsByDirectory['.']).toBe(1);

    // Symbol summaries
    expect(result.symbolSummaries).toBeDefined();
    expect(result.symbolSummaries!['app/Models']).toContain('User');

    // Cross-references
    expect(result.crossReferences).toBeDefined();
    expect(result.crossReferences!.length).toBeGreaterThanOrEqual(1);
    const ref = result.crossReferences!.find((r) => r.sourceDir === 'app/Models');
    expect(ref).toBeDefined();
    expect(ref!.targetDir).toBe('vendor/laravel');
  });

  it('should handle entries with no LSP metadata gracefully', () => {
    // Insert an entry with valid metadata, and one without
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Valid',
        file_path: '/project/app/Valid.ts',
        metadata: {
          lsp: {
            symbols: [{ name: 'ValidClass', kind: 5, kindLabel: 'Class' }],
            definitions: [],
          },
        },
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'doc',
        title: 'No LSP',
        file_path: '/project/app/NoLsp.md',
      })
    );

    const result = enrichContext('tree/', db, { rootPath: contentRoot });

    // File counts should include both entries
    expect(result.fileCountsByDirectory['app']).toBe(2);
    // Symbol summaries should only have the valid entry
    expect(result.symbolSummaries).toBeDefined();
    expect(result.symbolSummaries!['app']).toContain('ValidClass');
    // No cross-references (definitions array is empty)
    expect(result.crossReferences).toBeUndefined();
  });

  it('should produce correct enrichment for a multi-directory codebase', () => {
    // Auth module
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'AuthController',
        file_path: '/project/app/Auth/AuthController.ts',
        metadata: {
          lsp: {
            symbols: [{ name: 'AuthController', kind: 5, kindLabel: 'Class' }],
            definitions: [
              {
                symbolName: 'UserService',
                targetUri: 'file:///project/app/Users/UserService.ts',
                targetStartLine: 1,
              },
            ],
          },
        },
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'LoginForm',
        file_path: '/project/app/Auth/LoginForm.ts',
        metadata: {
          lsp: {
            symbols: [{ name: 'LoginForm', kind: 5, kindLabel: 'Class' }],
            definitions: [],
          },
        },
      })
    );
    // Users module
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'UserService',
        file_path: '/project/app/Users/UserService.ts',
        metadata: {
          lsp: {
            symbols: [
              { name: 'UserService', kind: 5, kindLabel: 'Class' },
              { name: 'UserRepository', kind: 11, kindLabel: 'Interface' },
            ],
            definitions: [],
          },
        },
      })
    );

    const result = enrichContext('tree/', db, { rootPath: contentRoot });

    // File counts
    expect(result.fileCountsByDirectory['app/Auth']).toBe(2);
    expect(result.fileCountsByDirectory['app/Users']).toBe(1);

    // Symbol summaries
    expect(result.symbolSummaries).toBeDefined();
    expect(result.symbolSummaries!['app/Auth']).toContain('AuthController');
    expect(result.symbolSummaries!['app/Auth']).toContain('LoginForm');
    expect(result.symbolSummaries!['app/Users']).toContain('UserService');
    expect(result.symbolSummaries!['app/Users']).toContain('UserRepository');

    // Cross-references: Auth → Users
    expect(result.crossReferences).toBeDefined();
    expect(result.crossReferences!).toHaveLength(1);
    expect(result.crossReferences![0].sourceDir).toBe('app/Auth');
    expect(result.crossReferences![0].targetDir).toBe('app/Users');
    expect(result.crossReferences![0].referenceCount).toBe(1);
  });
});
