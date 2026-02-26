import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import { createDefaultStages } from '../defaults.js';
import type {
  PipelineStages,
  DiscoveryContext,
  DiscoveryOptions,
  ProposedExpert,
} from '../types.js';
import type { KnowledgeEntryInsert } from '../../db/types.js';

// ── Fixtures ───────────────────────────────────────────────

function makeProposal(overrides: Partial<ProposedExpert> = {}): ProposedExpert {
  return {
    slug: 'invoicing',
    name: 'Invoicing System',
    mountPath: 'modules/Invoicing/',
    description: 'Manages invoice creation and payment tracking.',
    reasoning: 'High file count and clear domain boundary.',
    confidence: 0.92,
    ...overrides,
  };
}

function makeContext(tree = 'root/\n├── src/\n└── docs/'): DiscoveryContext {
  return {
    tree,
    fileCountsByDirectory: {},
    existingExperts: [],
  };
}

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

let testDir: string;
let dbDir: string;
let db: LuxDatabase;
let stages: PipelineStages;

beforeEach(() => {
  testDir = join(tmpdir(), `lux-stages-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbDir = join(tmpdir(), `lux-stages-db-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  db = new LuxDatabase(join(dbDir, 'test.db'));
  stages = createDefaultStages();
});

afterEach(() => {
  db.close();
  rmSync(testDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
// Stage 1: Tree Collection
// ══════════════════════════════════════════════════════════════

describe('Stage 1: collectTree', () => {
  it('returns a non-empty string for a directory with content', () => {
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'README.md'), '# Hello');

    const tree = stages.collectTree(testDir);

    expect(tree.length).toBeGreaterThan(0);
    expect(tree).toContain('src/');
    expect(tree).toContain('README.md');
  });

  it('starts with the root directory name', () => {
    mkdirSync(join(testDir, 'src'), { recursive: true });

    const tree = stages.collectTree(testDir);
    const rootName = basename(testDir);

    expect(tree.startsWith(`${rootName}/`)).toBe(true);
  });

  it('lists subdirectories with trailing slashes', () => {
    mkdirSync(join(testDir, 'modules'), { recursive: true });
    mkdirSync(join(testDir, 'config'), { recursive: true });

    const tree = stages.collectTree(testDir);

    expect(tree).toContain('modules/');
    expect(tree).toContain('config/');
  });

  it('lists files without trailing slashes', () => {
    writeFileSync(join(testDir, 'package.json'), '{}');
    writeFileSync(join(testDir, 'tsconfig.json'), '{}');

    const tree = stages.collectTree(testDir);

    expect(tree).toContain('package.json');
    expect(tree).toContain('tsconfig.json');
    // Files should NOT have trailing slashes
    expect(tree).not.toContain('package.json/');
  });

  it('includes nested directory contents', () => {
    mkdirSync(join(testDir, 'src', 'components'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'components', 'Button.tsx'), '');

    const tree = stages.collectTree(testDir);

    expect(tree).toContain('src/');
    expect(tree).toContain('components/');
    expect(tree).toContain('Button.tsx');
  });

  it('returns just the root name for an empty directory', () => {
    const tree = stages.collectTree(testDir);
    const rootName = basename(testDir);

    // Should contain root name and nothing else
    expect(tree.trim()).toBe(`${rootName}/`);
  });

  // ── Filtering ──────────────────────────────────────────

  it('ignores hidden files and directories (starting with .)', () => {
    mkdirSync(join(testDir, '.hidden-dir'), { recursive: true });
    writeFileSync(join(testDir, '.hidden-file'), 'secret');
    mkdirSync(join(testDir, 'visible'), { recursive: true });

    const tree = stages.collectTree(testDir);

    expect(tree).not.toContain('.hidden-dir');
    expect(tree).not.toContain('.hidden-file');
    expect(tree).toContain('visible/');
  });

  it('ignores .git directory', () => {
    mkdirSync(join(testDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });

    const tree = stages.collectTree(testDir);

    expect(tree).not.toContain('.git');
    expect(tree).toContain('src/');
  });

  it('ignores node_modules directory', () => {
    mkdirSync(join(testDir, 'node_modules', 'some-package'), { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });

    const tree = stages.collectTree(testDir);

    expect(tree).not.toContain('node_modules');
    expect(tree).toContain('src/');
  });

  it('ignores vendor directory', () => {
    mkdirSync(join(testDir, 'vendor', 'autoload'), { recursive: true });
    mkdirSync(join(testDir, 'app'), { recursive: true });

    const tree = stages.collectTree(testDir);

    expect(tree).not.toContain('vendor');
    expect(tree).toContain('app/');
  });

  it('ignores dist and build directories', () => {
    mkdirSync(join(testDir, 'dist'), { recursive: true });
    mkdirSync(join(testDir, 'build'), { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });

    const tree = stages.collectTree(testDir);

    expect(tree).not.toContain('dist');
    expect(tree).not.toContain('build');
    expect(tree).toContain('src/');
  });

  it('ignores __pycache__ directory', () => {
    mkdirSync(join(testDir, '__pycache__'), { recursive: true });
    mkdirSync(join(testDir, 'lib'), { recursive: true });

    const tree = stages.collectTree(testDir);

    expect(tree).not.toContain('__pycache__');
    expect(tree).toContain('lib/');
  });

  // ── Tree Formatting ────────────────────────────────────

  it('uses Unicode box-drawing characters for tree structure', () => {
    mkdirSync(join(testDir, 'alpha'), { recursive: true });
    mkdirSync(join(testDir, 'beta'), { recursive: true });

    const tree = stages.collectTree(testDir);

    // Should contain connector characters (├── or └──)
    expect(tree).toMatch(/[├└]──/);
  });

  it('uses └── for the last entry in a directory', () => {
    mkdirSync(join(testDir, 'alpha'), { recursive: true });
    mkdirSync(join(testDir, 'beta'), { recursive: true });

    const tree = stages.collectTree(testDir);

    // The last entry should use └──
    expect(tree).toContain('└──');
  });

  it('sorts entries alphabetically', () => {
    mkdirSync(join(testDir, 'zebra'), { recursive: true });
    mkdirSync(join(testDir, 'alpha'), { recursive: true });
    mkdirSync(join(testDir, 'middle'), { recursive: true });

    const tree = stages.collectTree(testDir);

    const alphaIdx = tree.indexOf('alpha/');
    const middleIdx = tree.indexOf('middle/');
    const zebraIdx = tree.indexOf('zebra/');

    expect(alphaIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(zebraIdx);
  });

  // ── Complex Structures ─────────────────────────────────

  it('handles a realistic project structure', () => {
    // Create a realistic TypeScript project structure
    mkdirSync(join(testDir, 'src', 'cli'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'db'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'utils'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'cli', 'index.ts'), '');
    writeFileSync(join(testDir, 'src', 'db', 'queries.ts'), '');
    writeFileSync(join(testDir, 'package.json'), '{}');
    writeFileSync(join(testDir, 'tsconfig.json'), '{}');
    // Ignored dirs
    mkdirSync(join(testDir, 'node_modules', 'lodash'), { recursive: true });
    mkdirSync(join(testDir, 'dist'), { recursive: true });
    mkdirSync(join(testDir, '.git', 'refs'), { recursive: true });

    const tree = stages.collectTree(testDir);

    // Source structure visible
    expect(tree).toContain('src/');
    expect(tree).toContain('cli/');
    expect(tree).toContain('db/');
    expect(tree).toContain('utils/');
    expect(tree).toContain('index.ts');
    expect(tree).toContain('queries.ts');
    expect(tree).toContain('package.json');
    expect(tree).toContain('tsconfig.json');

    // Ignored dirs not visible
    expect(tree).not.toContain('node_modules');
    expect(tree).not.toContain('dist');
    expect(tree).not.toContain('.git');
  });

  it('handles multiple files in the same directory', () => {
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'a.ts'), '');
    writeFileSync(join(testDir, 'src', 'b.ts'), '');
    writeFileSync(join(testDir, 'src', 'c.ts'), '');

    const tree = stages.collectTree(testDir);

    expect(tree).toContain('a.ts');
    expect(tree).toContain('b.ts');
    expect(tree).toContain('c.ts');
  });
});

// ══════════════════════════════════════════════════════════════
// Stage 2: Enrich Context
// ══════════════════════════════════════════════════════════════

describe('Stage 2: enrichContext', () => {
  const baseOptions: DiscoveryOptions = { rootPath: '/test/root' };

  it('passes through the tree string unchanged', () => {
    const tree = 'root/\n├── src/\n└── docs/';
    const context = stages.enrichContext(tree, db, baseOptions);

    expect(context.tree).toBe(tree);
  });

  it('returns empty fileCountsByDirectory when DB has no indexed entries', () => {
    const context = stages.enrichContext('tree', db, baseOptions);

    expect(context.fileCountsByDirectory).toEqual({});
  });

  it('returns no symbolSummaries when DB has no LSP data', () => {
    const context = stages.enrichContext('tree', db, baseOptions);

    expect(context.symbolSummaries).toBeUndefined();
  });

  it('returns no crossReferences when DB has no LSP data', () => {
    const context = stages.enrichContext('tree', db, baseOptions);

    expect(context.crossReferences).toBeUndefined();
  });

  // ── Existing Experts ───────────────────────────────────

  it('returns empty existingExperts when none are registered', () => {
    const context = stages.enrichContext('tree', db, baseOptions);

    expect(context.existingExperts).toEqual([]);
  });

  it('includes a single existing expert', () => {
    db.insertExpert({
      slug: 'auth',
      name: 'Auth Expert',
      mount_path: '/corpus/modules/Auth',
    });

    const context = stages.enrichContext('tree', db, baseOptions);

    expect(context.existingExperts).toHaveLength(1);
    expect(context.existingExperts[0]).toEqual({
      slug: 'auth',
      mountPath: '/corpus/modules/Auth',
    });
  });

  it('includes multiple existing experts', () => {
    db.insertExpert({
      slug: 'auth',
      name: 'Auth',
      mount_path: '/corpus/modules/Auth',
    });
    db.insertExpert({
      slug: 'invoicing',
      name: 'Invoicing',
      mount_path: '/corpus/modules/Invoicing',
    });
    db.insertExpert({
      slug: 'reporting',
      name: 'Reporting',
      mount_path: '/corpus/modules/Reporting',
    });

    const context = stages.enrichContext('tree', db, baseOptions);

    expect(context.existingExperts).toHaveLength(3);
    const slugs = context.existingExperts.map((e) => e.slug).sort();
    expect(slugs).toEqual(['auth', 'invoicing', 'reporting']);
  });

  it('maps mount_path to mountPath correctly', () => {
    db.insertExpert({
      slug: 'test',
      name: 'Test',
      mount_path: '/corpus/some/deep/path',
    });

    const context = stages.enrichContext('tree', db, baseOptions);

    expect(context.existingExperts[0].mountPath).toBe('/corpus/some/deep/path');
  });

  it('only includes slug and mountPath from experts (not model, status, etc.)', () => {
    db.insertExpert({
      slug: 'full',
      name: 'Full Expert',
      mount_path: '/corpus/full',
      model: 'claude-opus-4-20250514',
      status: 'active',
      claude_md_path: '/corpus/full/claude.md',
      memory_path: '/corpus/full/memory.md',
    });

    const context = stages.enrichContext('tree', db, baseOptions);
    const expert = context.existingExperts[0];

    expect(Object.keys(expert)).toEqual(['slug', 'mountPath']);
  });

  it('includes inactive experts in the context', () => {
    db.insertExpert({
      slug: 'active',
      name: 'Active',
      mount_path: '/corpus/active',
      status: 'active',
    });
    db.insertExpert({
      slug: 'inactive',
      name: 'Inactive',
      mount_path: '/corpus/inactive',
      status: 'inactive',
    });

    const context = stages.enrichContext('tree', db, baseOptions);

    expect(context.existingExperts).toHaveLength(2);
  });

  // ── Enrichment with indexed data ─────────────────────────

  it('enriches context with file counts, symbol summaries, and cross-references from DB', () => {
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'UserController',
        file_path: '/project/app/Controllers/UserController.php',
        metadata: {
          lsp: {
            symbols: [{ name: 'UserController', kind: 5, kindLabel: 'Class' }],
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

    const context = stages.enrichContext('tree/', db, { rootPath: '/project' });

    // File counts populated (not empty passthrough)
    expect(Object.keys(context.fileCountsByDirectory).length).toBeGreaterThan(0);
    expect(context.fileCountsByDirectory['app/Controllers']).toBe(1);
    expect(context.fileCountsByDirectory['app/Models']).toBe(1);

    // Symbol summaries populated
    expect(context.symbolSummaries).toBeDefined();
    expect(context.symbolSummaries!['app/Controllers']).toContain('UserController');
    expect(context.symbolSummaries!['app/Models']).toContain('User');

    // Cross-references populated
    expect(context.crossReferences).toBeDefined();
    expect(context.crossReferences!.length).toBeGreaterThanOrEqual(1);
    expect(context.crossReferences![0].sourceDir).toBe('app/Controllers');
    expect(context.crossReferences![0].targetDir).toBe('app/Models');

    // Tree is passed through
    expect(context.tree).toBe('tree/');
  });
});

// ══════════════════════════════════════════════════════════════
// Pipeline integration: collectTree → enrichContext with indexed data
// ══════════════════════════════════════════════════════════════

describe('Pipeline integration: collectTree → enrichContext with indexed data', () => {
  it('chains collectTree → enrichContext with real indexed data (not passthrough)', () => {
    // Create real directory structure
    mkdirSync(join(testDir, 'modules', 'Auth'), { recursive: true });
    mkdirSync(join(testDir, 'modules', 'Billing'), { recursive: true });
    mkdirSync(join(testDir, 'lib'), { recursive: true });
    writeFileSync(join(testDir, 'modules', 'Auth', 'Login.php'), '<?php class Login {}');
    writeFileSync(join(testDir, 'modules', 'Auth', 'Register.php'), '<?php class Register {}');
    writeFileSync(join(testDir, 'modules', 'Billing', 'Invoice.php'), '<?php class Invoice {}');
    writeFileSync(join(testDir, 'lib', 'helpers.php'), '<?php function helper() {}');
    writeFileSync(join(testDir, 'README.md'), '# Project');

    // Index files with LSP metadata into the database
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Login',
        file_path: join(testDir, 'modules', 'Auth', 'Login.php'),
        metadata: {
          lsp: {
            symbols: [
              { name: 'Login', kind: 5, kindLabel: 'Class' },
              { name: 'authenticate', kind: 6, kindLabel: 'Method' },
            ],
            definitions: [
              {
                symbolName: 'Invoice',
                targetUri: `file://${join(testDir, 'modules', 'Billing', 'Invoice.php')}`,
                targetStartLine: 10,
              },
            ],
          },
        },
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Register',
        file_path: join(testDir, 'modules', 'Auth', 'Register.php'),
        metadata: {
          lsp: {
            symbols: [{ name: 'Register', kind: 5, kindLabel: 'Class' }],
            definitions: [],
          },
        },
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'source',
        title: 'Invoice',
        file_path: join(testDir, 'modules', 'Billing', 'Invoice.php'),
        metadata: {
          lsp: {
            symbols: [{ name: 'Invoice', kind: 5, kindLabel: 'Class' }],
            definitions: [],
          },
        },
      })
    );
    db.insertKnowledgeEntry(
      makeEntry({
        type: 'doc',
        title: 'README',
        file_path: join(testDir, 'README.md'),
        content: '# Project',
      })
    );

    // Register an existing expert
    db.insertExpert({
      slug: 'lib-expert',
      name: 'Lib Expert',
      mount_path: join(testDir, 'lib'),
    });

    // Run Stages 1→2 through createDefaultStages()
    const tree = stages.collectTree(testDir);
    const context = stages.enrichContext(tree, db, { rootPath: testDir });

    // Stage 1 output: tree includes the real directory structure
    expect(context.tree).toContain('modules/');
    expect(context.tree).toContain('Auth/');
    expect(context.tree).toContain('Billing/');
    expect(context.tree).toContain('README.md');

    // Stage 2: file counts reflect indexed entries (NOT empty passthrough)
    expect(context.fileCountsByDirectory['modules/Auth']).toBe(2);
    expect(context.fileCountsByDirectory['modules/Billing']).toBe(1);
    expect(context.fileCountsByDirectory['.']).toBe(1); // README.md

    // Stage 2: symbol summaries from LSP metadata
    expect(context.symbolSummaries).toBeDefined();
    expect(context.symbolSummaries!['modules/Auth']).toContain('Login');
    expect(context.symbolSummaries!['modules/Auth']).toContain('Register');
    expect(context.symbolSummaries!['modules/Billing']).toContain('Invoice');

    // Stage 2: cross-references from LSP definitions
    expect(context.crossReferences).toBeDefined();
    const authToBilling = context.crossReferences!.find(
      (r) => r.sourceDir === 'modules/Auth' && r.targetDir === 'modules/Billing'
    );
    expect(authToBilling).toBeDefined();
    expect(authToBilling!.referenceCount).toBe(1);

    // Stage 2: existing experts included
    expect(context.existingExperts).toHaveLength(1);
    expect(context.existingExperts[0].slug).toBe('lib-expert');
  });

  it('produces empty enrichment when DB has no indexed entries (graceful degradation)', () => {
    // Create real directory structure (but don't index anything)
    mkdirSync(join(testDir, 'modules'), { recursive: true });
    writeFileSync(join(testDir, 'README.md'), '# Project');

    const tree = stages.collectTree(testDir);
    const context = stages.enrichContext(tree, db, { rootPath: testDir });

    // Tree is still populated from the file system
    expect(context.tree).toContain('modules/');

    // But all enrichment data is empty
    expect(Object.keys(context.fileCountsByDirectory)).toHaveLength(0);
    expect(context.symbolSummaries).toBeUndefined();
    expect(context.crossReferences).toBeUndefined();
    expect(context.existingExperts).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Stage 3: AI Analysis (real implementation — mocked at module level)
// ══════════════════════════════════════════════════════════════

const { mockAnalyze, mockReview, mockRegister } = vi.hoisted(() => ({
  mockAnalyze: vi.fn(),
  mockReview: vi.fn(),
  mockRegister: vi.fn(),
}));

vi.mock('../analyze.js', () => ({
  analyze: mockAnalyze,
}));

vi.mock('../review.js', () => ({
  review: mockReview,
}));

vi.mock('../register.js', () => ({
  register: mockRegister,
}));

describe('Stage 3: analyze (default)', () => {
  const baseOptions: DiscoveryOptions = { rootPath: '/test/root' };

  it('wires the analyze stage from the analyze module', () => {
    // createDefaultStages uses the real analyze function from analyze.js
    expect(stages.analyze).toBe(mockAnalyze);
  });

  it('returns a DiscoveryProposal when AI responds', async () => {
    mockAnalyze.mockResolvedValue({
      experts: [
        {
          slug: 'auth',
          name: 'Authentication',
          mountPath: 'modules/Auth/',
          description: 'Handles authentication.',
          reasoning: 'Clear boundary.',
          confidence: 0.85,
        },
      ],
      rationale: 'One domain found.',
    });

    const proposal = await stages.analyze(makeContext(), baseOptions);

    expect(proposal).toHaveProperty('experts');
    expect(proposal).toHaveProperty('rationale');
    expect(proposal.experts).toHaveLength(1);
    expect(proposal.experts[0].slug).toBe('auth');
  });

  it('returns empty experts when AI finds no boundaries', async () => {
    mockAnalyze.mockResolvedValue({
      experts: [],
      rationale: 'No clear boundaries.',
    });

    const proposal = await stages.analyze(makeContext(), baseOptions);

    expect(proposal.experts).toEqual([]);
  });

  it('is async and returns a Promise', () => {
    mockAnalyze.mockResolvedValue({ experts: [], rationale: 'ok' });

    const result = stages.analyze(makeContext(), baseOptions);

    expect(result).toBeInstanceOf(Promise);
  });

  it('propagates subprocess errors', async () => {
    mockAnalyze.mockRejectedValue(new Error('Claude CLI failed: connection error'));

    await expect(stages.analyze(makeContext(), baseOptions)).rejects.toThrow('Claude CLI failed');
  });
});

// ══════════════════════════════════════════════════════════════
// Stage 4: Interactive Review (real implementation — mocked at module level)
// ══════════════════════════════════════════════════════════════

describe('Stage 4: review (default)', () => {
  it('wires the review stage from the review module', () => {
    expect(stages.review).toBe(mockReview);
  });

  it('returns a ReviewResult when mock resolves', async () => {
    const proposals = [
      makeProposal({ slug: 'auth', confidence: 0.9 }),
      makeProposal({ slug: 'invoicing', confidence: 0.85 }),
    ];

    mockReview.mockResolvedValue({
      accepted: proposals,
      skipped: [],
    });

    const result = await stages.review(proposals);

    expect(result.accepted).toEqual(proposals);
    expect(result.skipped).toEqual([]);
  });

  it('returns empty arrays for empty proposals', async () => {
    mockReview.mockResolvedValue({ accepted: [], skipped: [] });

    const result = await stages.review([]);

    expect(result.accepted).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('is async and returns a Promise', () => {
    mockReview.mockResolvedValue({ accepted: [], skipped: [] });
    const result = stages.review([]);
    expect(result).toBeInstanceOf(Promise);
  });

  it('returns a ReviewResult with accepted and skipped arrays', async () => {
    mockReview.mockResolvedValue({
      accepted: [makeProposal()],
      skipped: [],
    });

    const result = await stages.review([makeProposal()]);

    expect(result).toHaveProperty('accepted');
    expect(result).toHaveProperty('skipped');
    expect(Array.isArray(result.accepted)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// Stage 5: Registration (real implementation — mocked at module level)
// ══════════════════════════════════════════════════════════════

describe('Stage 5: register (default)', () => {
  const baseOptions: DiscoveryOptions = { rootPath: '/test/root' };

  it('wires the register stage from the register module', () => {
    expect(stages.register).toBe(mockRegister);
  });

  it('returns RegisteredExpert[] when mock resolves', async () => {
    mockRegister.mockResolvedValue([
      {
        slug: 'auth',
        mountPath: '/test/modules/Auth',
        claudeMdPath: '/test/modules/Auth/claude.md',
      },
    ]);

    const result = await stages.register([makeProposal({ slug: 'auth' })], db, baseOptions);

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('auth');
  });

  it('returns empty array for empty accepted list', async () => {
    mockRegister.mockResolvedValue([]);

    const result = await stages.register([], db, baseOptions);

    expect(result).toEqual([]);
  });

  it('is async and returns a Promise', () => {
    mockRegister.mockResolvedValue([]);
    const result = stages.register([], db, baseOptions);
    expect(result).toBeInstanceOf(Promise);
  });
});

// ══════════════════════════════════════════════════════════════
// createDefaultStages: Integration
// ══════════════════════════════════════════════════════════════

describe('createDefaultStages', () => {
  it('returns an object implementing PipelineStages', () => {
    expect(stages).toHaveProperty('collectTree');
    expect(stages).toHaveProperty('enrichContext');
    expect(stages).toHaveProperty('analyze');
    expect(stages).toHaveProperty('review');
    expect(stages).toHaveProperty('register');
  });

  it('all stage functions have the correct arity', () => {
    // collectTree takes (rootPath, options?)
    expect(stages.collectTree.length).toBeGreaterThanOrEqual(1);
    // enrichContext takes (tree, db, options)
    expect(stages.enrichContext.length).toBeGreaterThanOrEqual(2);
    // analyze is a function (mocked in tests, real impl has arity 2)
    expect(typeof stages.analyze).toBe('function');
    // review is a function (mocked in tests, real impl has arity 1+)
    expect(typeof stages.review).toBe('function');
    // register is a function (mocked in tests, real impl has arity 3)
    expect(typeof stages.register).toBe('function');
  });

  it('stages can be used together in sequence (tree-only flow)', async () => {
    // Mock AI response for the analyze stage
    mockAnalyze.mockResolvedValue({
      experts: [
        {
          slug: 'modules',
          name: 'Modules',
          mountPath: 'modules/',
          description: 'Application modules.',
          reasoning: 'Groups Auth and Billing.',
          confidence: 0.8,
        },
      ],
      rationale: 'One domain found.',
    });

    // Set up a directory structure
    mkdirSync(join(testDir, 'modules', 'Auth'), { recursive: true });
    mkdirSync(join(testDir, 'modules', 'Billing'), { recursive: true });
    writeFileSync(join(testDir, 'modules', 'Auth', 'Controller.ts'), '');
    writeFileSync(join(testDir, 'modules', 'Billing', 'Service.ts'), '');

    // Stage 1: collect tree
    const tree = stages.collectTree(testDir);
    expect(tree).toContain('modules/');
    expect(tree).toContain('Auth/');
    expect(tree).toContain('Billing/');

    // Stage 2: enrich (empty DB — no indexed entries)
    const context = stages.enrichContext(tree, db, { rootPath: testDir });
    expect(context.tree).toBe(tree);
    expect(context.existingExperts).toEqual([]);

    // Stage 3: analyze (mocked)
    const proposal = await stages.analyze(context, { rootPath: testDir });
    expect(proposal.experts).toHaveLength(1);
    expect(proposal.experts[0].slug).toBe('modules');

    // Stage 4: review (mocked — accepts all)
    mockReview.mockResolvedValue({
      accepted: proposal.experts,
      skipped: [],
    });
    const reviewed = await stages.review(proposal.experts);
    expect(reviewed.accepted).toHaveLength(1);

    // Stage 5: register (stub)
    const registered = await stages.register(reviewed.accepted, db, { rootPath: testDir });
    expect(registered).toEqual([]);
  });
});
