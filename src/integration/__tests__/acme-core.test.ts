import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GeneralScanner } from '../../scanner/general.js';
import { LuxDatabase } from '../../db/index.js';
import { initCorpus, collectDirectoryTree, parseAndValidateYaml } from '../../init/index.js';

/**
 * Integration tests that exercise the full Lux pipeline against the
 * auctic-core codebase — a real-world Laravel project.
 *
 * These tests are conditionally skipped when the auctic-core path
 * is not available (e.g., in CI environments).
 *
 * Key finding: The GeneralScanner is still tied to the CORPUS directory
 * structure (knowledge/10_clients, etc.) and produces empty results for
 * non-CORPUS codebases. This validates the need for the config-driven
 * scanner approach defined in lux.yaml's scanner.type_rules.
 */

const AUCTIC_CORE_PATH = '/path/to/auctic-core/vcs';
const pathExists = existsSync(AUCTIC_CORE_PATH);

describe.skipIf(!pathExists)('auctic-core integration', () => {
  let tmpDir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lux-auctic-integration-'));
    db = new LuxDatabase(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    if (db) db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('collectDirectoryTree', () => {
    it('should produce a non-empty tree from auctic-core', () => {
      const tree = collectDirectoryTree(AUCTIC_CORE_PATH);

      expect(tree).toBeTruthy();
      expect(tree.length).toBeGreaterThan(100);

      // Should contain known top-level items from auctic-core
      // Tree gets truncated at 200 entries, so check for early directories
      expect(tree).toMatch(/database\//);
      expect(tree).toMatch(/docs\//);
    });

    it('should respect depth and entry limits', () => {
      const tree = collectDirectoryTree(AUCTIC_CORE_PATH);
      const lines = tree.split('\n');

      // MAX_TREE_ENTRIES is 200 — tree shouldn't exceed it significantly
      expect(lines.length).toBeLessThanOrEqual(210);
    });

    it('should exclude .git and node_modules', () => {
      const tree = collectDirectoryTree(AUCTIC_CORE_PATH);

      expect(tree).not.toContain('.git/');
      expect(tree).not.toContain('node_modules/');
      expect(tree).not.toContain('vendor/');
    });
  });

  describe('existing lux.yaml schema compatibility', () => {
    it('should detect existing lux.yaml at auctic-core root', () => {
      const configPath = join(AUCTIC_CORE_PATH, 'lux.yaml');
      expect(existsSync(configPath)).toBe(true);
    });

    it('should partially parse auctic-core lux.yaml (version field passes, extra fields stripped)', () => {
      const raw = readFileSync(join(AUCTIC_CORE_PATH, 'lux.yaml'), 'utf-8');
      // The current LuxConfigSchema only knows about `version` and `scanner`.
      // auctic-core's yaml has `project` and `experts` sections which will be
      // stripped by Zod's default behavior (no strict mode).
      const config = parseAndValidateYaml(raw);

      expect(config.version).toBe(1);
      expect(config.scanner).toBeDefined();
      // The `project` and `experts` fields from auctic-core yaml are not in our schema
      // Zod strips unknown keys by default, so they silently disappear
      expect((config as Record<string, unknown>)['project']).toBeUndefined();
      expect((config as Record<string, unknown>)['experts']).toBeUndefined();
    });
  });

  describe('initCorpus with skipAi', () => {
    it('should generate default config for auctic-core directory structure', async () => {
      // Use a temp dir to avoid overwriting the real lux.yaml
      const initDir = mkdtempSync(join(tmpdir(), 'lux-init-auctic-'));

      try {
        // We can't use auctic-core directly (has existing lux.yaml),
        // so we test initCorpus against the temp dir
        const result = await initCorpus({
          rootPath: initDir,
          skipAi: true,
        });

        expect(result.configPath).toBe(join(initDir, 'lux.yaml'));
        expect(result.aiGenerated).toBe(false);
        expect(result.config.version).toBe(1);
        expect(result.config.scanner.include).toContain('**/*.md');
        expect(result.config.scanner.default_type).toBe('document');
      } finally {
        rmSync(initDir, { recursive: true, force: true });
      }
    });

    it('should refuse to overwrite existing config without force', async () => {
      await expect(
        initCorpus({ rootPath: AUCTIC_CORE_PATH, skipAi: true })
      ).rejects.toThrow('Config already exists');
    });
  });

  describe('GeneralScanner against auctic-core', () => {
    it('should scan without crashing', async () => {
      const scanner = new GeneralScanner(AUCTIC_CORE_PATH);
      const result = await scanner.scan();

      expect(result).toBeDefined();
      expect(result.clients).toBeInstanceOf(Array);
      expect(result.projects).toBeInstanceOf(Array);
      expect(result.communications).toBeInstanceOf(Array);
      expect(result.knowledge).toBeInstanceOf(Array);
    });

    it('should find no clients (no knowledge/10_clients directory)', async () => {
      const scanner = new GeneralScanner(AUCTIC_CORE_PATH);
      const result = await scanner.scan();

      // auctic-core has no knowledge/10_clients directory
      expect(result.clients).toHaveLength(0);
    });

    it('should find no projects (projects are nested under clients)', async () => {
      const scanner = new GeneralScanner(AUCTIC_CORE_PATH);
      const result = await scanner.scan();

      expect(result.projects).toHaveLength(0);
    });

    it('should find no communications (no communications directories)', async () => {
      const scanner = new GeneralScanner(AUCTIC_CORE_PATH);
      const result = await scanner.scan();

      expect(result.communications).toHaveLength(0);
    });

    it('should find no knowledge entries (no CORPUS knowledge directories)', async () => {
      const scanner = new GeneralScanner(AUCTIC_CORE_PATH);
      const result = await scanner.scan();

      // auctic-core has no knowledge/20_methodology, 30_specs, 40_architecture,
      // explorations, or implementation-payloads directories
      expect(result.knowledge).toHaveLength(0);
    });

    it('should demonstrate the scanner misses 92+ markdown files in auctic-core', async () => {
      const scanner = new GeneralScanner(AUCTIC_CORE_PATH);
      const result = await scanner.scan();

      // The scanner finds nothing because auctic-core doesn't follow CORPUS structure.
      // Yet auctic-core has 92+ markdown files (README.md, docs/, module readmes, etc.)
      // that a config-driven scanner would index.
      const totalFound =
        result.clients.length +
        result.projects.length +
        result.communications.length +
        result.knowledge.length;

      expect(totalFound).toBe(0);
    });
  });

  describe('index and search with empty results', () => {
    it('should index empty scan results without error', async () => {
      const scanner = new GeneralScanner(AUCTIC_CORE_PATH);
      const result = await scanner.scan();

      const counts = await scanner.index(db, result);

      expect(counts.clients).toBe(0);
      expect(counts.projects).toBe(0);
      expect(counts.communications).toBe(0);
      expect(counts.knowledge).toBe(0);
    });

    it('should return empty search results from empty index', async () => {
      const scanner = new GeneralScanner(AUCTIC_CORE_PATH);
      const result = await scanner.scan();
      await scanner.index(db, result);

      const searchResults = db.searchAllDocuments('auction');
      expect(searchResults).toHaveLength(0);
    });

    it('should report zero stats after indexing empty results', async () => {
      const scanner = new GeneralScanner(AUCTIC_CORE_PATH);
      const result = await scanner.scan();
      await scanner.index(db, result);

      const stats = db.getStats();
      expect(stats.clients).toBe(0);
      expect(stats.projects).toBe(0);
      expect(stats.communications).toBe(0);
      expect(stats.knowledge_entries).toBe(0);
    });
  });

  describe('full pipeline with manual document insertion', () => {
    it('should support manual document indexing for non-CORPUS content', async () => {
      // Simulate what a config-driven scanner would do:
      // read markdown files from auctic-core and insert them as knowledge entries
      const readmePath = join(AUCTIC_CORE_PATH, 'README.md');
      if (!existsSync(readmePath)) return;

      const content = readFileSync(readmePath, 'utf-8');

      db.insertKnowledgeEntry({
        type: 'readme',
        title: 'acme Core README',
        file_path: readmePath,
        content,
      });

      // Verify it's searchable
      const results = db.searchAllDocuments('acme');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toBe('acme Core README');
    });

    it('should support indexing module documentation', async () => {
      // Index a module README
      const paymentsReadme = join(AUCTIC_CORE_PATH, 'src/Module/Payments/README.md');
      if (!existsSync(paymentsReadme)) return;

      const content = readFileSync(paymentsReadme, 'utf-8');

      db.insertKnowledgeEntry({
        type: 'document',
        title: 'Payments Module',
        file_path: paymentsReadme,
        content,
      });

      const results = db.searchKnowledgeEntries('payment');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle batch indexing of module docs with search', async () => {
      // Index multiple module readmes to simulate config-driven scanning
      const moduleReadmes = [
        { path: 'src/Module/Payments/README.md', title: 'Payments Module' },
        { path: 'src/Module/Accounting/README.md', title: 'Accounting Module' },
        { path: 'src/Module/Customizations/README.md', title: 'Customizations Module' },
      ];

      let indexed = 0;
      for (const readme of moduleReadmes) {
        const fullPath = join(AUCTIC_CORE_PATH, readme.path);
        if (!existsSync(fullPath)) continue;

        const content = readFileSync(fullPath, 'utf-8');
        db.insertKnowledgeEntry({
          type: 'document',
          title: readme.title,
          file_path: fullPath,
          content,
        });
        indexed++;
      }

      if (indexed === 0) return;

      // Verify unified search works across all indexed docs
      const allDocs = db.searchAllDocuments('module');
      expect(allDocs.length).toBeGreaterThanOrEqual(1);

      // Verify stats reflect indexed documents
      const stats = db.getStats();
      expect(stats.knowledge_entries).toBe(indexed);
    });
  });
});
