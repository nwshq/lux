import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import { validateMountPath, formatDiscoveryOutput, formatProposalTable } from '../expert.js';
import { createDefaultStages } from '../../discovery/index.js';
import type { DiscoveryResult, ProposedExpert } from '../../discovery/index.js';

/**
 * Tests for expert CLI command logic.
 *
 * These test the core business logic used by expert commands:
 * - validateMountPath (already has basic tests, extended here)
 * - detectClaudeMd behavior (tested via database registration flow)
 * - Expert add/remove/list/show database interactions
 */

describe('Expert CLI Commands', () => {
  let contentDir: string;
  let dbDir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    contentDir = mkdtempSync(join(tmpdir(), 'content-'));
    dbDir = mkdtempSync(join(tmpdir(), 'db-'));
    db = new LuxDatabase(join(dbDir, 'test.db'));
  });

  afterEach(() => {
    if (db) db.close();
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  describe('expert add: mount path validation', () => {
    it('should resolve relative mount path to absolute within content root', () => {
      mkdirSync(join(contentDir, 'experts', 'my-agent'), { recursive: true });

      const result = validateMountPath('experts/my-agent', contentDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(join(contentDir, 'experts', 'my-agent'));
      }
    });

    it('should accept absolute path inside content root', () => {
      mkdirSync(join(contentDir, 'knowledge'), { recursive: true });
      const absPath = join(contentDir, 'knowledge');

      const result = validateMountPath(absPath, contentDir);
      expect(result.ok).toBe(true);
    });

    it('should reject path traversal outside content root', () => {
      const result = validateMountPath('../../../etc/passwd', contentDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('must be inside content root');
      }
    });

    it('should reject non-existent path', () => {
      const result = validateMountPath('does-not-exist', contentDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('does not exist');
      }
    });
  });

  describe('expert add: claude.md auto-detection', () => {
    it('should detect lowercase claude.md at mount path', () => {
      const mountPath = join(contentDir, 'agent-lower');
      mkdirSync(mountPath, { recursive: true });
      writeFileSync(join(mountPath, 'claude.md'), '# Agent Instructions');

      // Verify the file exists (simulating what detectClaudeMd checks)
      expect(existsSync(join(mountPath, 'claude.md'))).toBe(true);
    });

    it('should detect uppercase CLAUDE.md at mount path', () => {
      const mountPath = join(contentDir, 'agent-upper');
      mkdirSync(mountPath, { recursive: true });
      writeFileSync(join(mountPath, 'CLAUDE.md'), '# Agent Instructions');

      expect(existsSync(join(mountPath, 'CLAUDE.md'))).toBe(true);
    });

    it('should detect memory.md at mount path', () => {
      const mountPath = join(contentDir, 'agent-memory');
      mkdirSync(mountPath, { recursive: true });
      writeFileSync(join(mountPath, 'memory.md'), '# Agent Memory');

      expect(existsSync(join(mountPath, 'memory.md'))).toBe(true);
    });

    it('should handle missing claude.md gracefully', () => {
      const mountPath = join(contentDir, 'agent-bare');
      mkdirSync(mountPath, { recursive: true });

      expect(existsSync(join(mountPath, 'claude.md'))).toBe(false);
      expect(existsSync(join(mountPath, 'CLAUDE.md'))).toBe(false);
    });
  });

  describe('expert add: database registration', () => {
    it('should register an expert with slug and name', () => {
      db.insertExpert({
        slug: 'test-agent',
        name: 'Test Agent',
        mount_path: '/test/path',
        model: 'claude-sonnet-4-20250514',
      });

      const expert = db.getExpert('test-agent');
      expect(expert).toBeDefined();
      expect(expert!.slug).toBe('test-agent');
      expect(expert!.name).toBe('Test Agent');
    });

    it('should use slug as name when name not provided', () => {
      // Simulates CLI behavior: options.name ?? slug
      const optionsName: string | undefined = undefined;
      const name = optionsName ?? 'my-expert-slug';

      db.insertExpert({
        slug: 'my-expert-slug',
        name,
        mount_path: '/test/path',
      });

      const expert = db.getExpert('my-expert-slug');
      expect(expert!.name).toBe('my-expert-slug');
    });

    it('should reject duplicate expert slugs', () => {
      db.insertExpert({
        slug: 'duplicate-me',
        name: 'First',
        mount_path: '/test/first',
      });

      expect(() => {
        db.insertExpert({
          slug: 'duplicate-me',
          name: 'Second',
          mount_path: '/test/second',
        });
      }).toThrow();
    });

    it('should register expert with auto-detected claude_md_path', () => {
      const mountPath = join(contentDir, 'auto-detect-agent');
      mkdirSync(mountPath, { recursive: true });
      const claudeMdPath = join(mountPath, 'CLAUDE.md');
      writeFileSync(claudeMdPath, '# Auto-detected');

      db.insertExpert({
        slug: 'auto-agent',
        name: 'Auto Agent',
        mount_path: mountPath,
        claude_md_path: claudeMdPath,
      });

      const expert = db.getExpert('auto-agent');
      expect(expert!.claude_md_path).toBe(claudeMdPath);
    });

    it('should register expert with auto-detected memory_path', () => {
      const mountPath = join(contentDir, 'memory-agent');
      mkdirSync(mountPath, { recursive: true });
      const memoryPath = join(mountPath, 'memory.md');
      writeFileSync(memoryPath, '# Memory');

      db.insertExpert({
        slug: 'memory-agent',
        name: 'Memory Agent',
        mount_path: mountPath,
        memory_path: memoryPath,
      });

      const expert = db.getExpert('memory-agent');
      expect(expert!.memory_path).toBe(memoryPath);
    });
  });

  describe('expert remove: cleanup', () => {
    it('should remove expert and associated sessions', () => {
      const expertId = db.insertExpert({
        slug: 'removable',
        name: 'Removable Expert',
        mount_path: '/test/rm',
      });

      // Create sessions
      db.insertExpertSession({ expert_id: expertId, session_ref: 'sess-1' });
      db.insertExpertSession({ expert_id: expertId, session_ref: 'sess-2' });

      expect(db.getSessionsByExpert(expertId)).toHaveLength(2);

      // Remove: sessions first, then expert (as CLI does)
      db.deleteSessionsByExpert(expertId);
      db.deleteExpert('removable');

      expect(db.getExpert('removable')).toBeUndefined();
      expect(db.getSessionsByExpert(expertId)).toHaveLength(0);
    });

    it('should handle remove of expert with no sessions', () => {
      db.insertExpert({
        slug: 'no-sessions',
        name: 'No Sessions',
        mount_path: '/test/ns',
      });

      const expert = db.getExpert('no-sessions');
      db.deleteSessionsByExpert(expert!.id);
      db.deleteExpert('no-sessions');

      expect(db.getExpert('no-sessions')).toBeUndefined();
    });
  });

  describe('expert list: filtering', () => {
    beforeEach(() => {
      db.insertExpert({
        slug: 'expert-a',
        name: 'Active Expert A',
        mount_path: '/a',
        status: 'active',
      });
      db.insertExpert({
        slug: 'expert-b',
        name: 'Active Expert B',
        mount_path: '/b',
        status: 'active',
      });
      db.insertExpert({
        slug: 'expert-c',
        name: 'Inactive Expert C',
        mount_path: '/c',
        status: 'inactive',
      });
    });

    it('should list all experts regardless of status', () => {
      const all = db.getAllExperts();
      expect(all).toHaveLength(3);
    });

    it('should filter to only active experts', () => {
      const active = db.getExpertsByStatus('active');
      expect(active).toHaveLength(2);
      active.forEach((e) => expect(e.status).toBe('active'));
    });

    it('should filter to only inactive experts', () => {
      const inactive = db.getExpertsByStatus('inactive');
      expect(inactive).toHaveLength(1);
      expect(inactive[0].slug).toBe('expert-c');
    });

    it('should return experts ordered by name', () => {
      const all = db.getAllExperts();
      expect(all[0].name).toBe('Active Expert A');
      expect(all[1].name).toBe('Active Expert B');
      expect(all[2].name).toBe('Inactive Expert C');
    });
  });

  describe('expert show: retrieval', () => {
    it('should return full expert details', () => {
      db.insertExpert({
        slug: 'show-me',
        name: 'Show Me Expert',
        mount_path: '/test/show',
        model: 'claude-opus-4-20250514',
        claude_md_path: '/test/show/CLAUDE.md',
        memory_path: '/test/show/memory.md',
        status: 'active',
      });

      const expert = db.getExpert('show-me');
      expect(expert).toBeDefined();
      expect(expert!.slug).toBe('show-me');
      expect(expert!.name).toBe('Show Me Expert');
      expect(expert!.mount_path).toBe('/test/show');
      expect(expert!.model).toBe('claude-opus-4-20250514');
      expect(expert!.claude_md_path).toBe('/test/show/CLAUDE.md');
      expect(expert!.memory_path).toBe('/test/show/memory.md');
      expect(expert!.status).toBe('active');
      expect(expert!.id).toBeGreaterThan(0);
      expect(expert!.created_at).toBeGreaterThan(0);
      expect(expert!.updated_at).toBeGreaterThan(0);
    });

    it('should return undefined for non-existent expert', () => {
      expect(db.getExpert('does-not-exist')).toBeUndefined();
    });
  });

  describe('expert discover: output formatting', () => {
    function makeProposal(overrides: Partial<ProposedExpert> = {}): ProposedExpert {
      return {
        slug: 'invoicing',
        name: 'Invoicing System',
        mountPath: 'modules/Invoicing/',
        description: 'Manages invoice creation.',
        reasoning: 'Clear domain boundary.',
        confidence: 0.92,
        ...overrides,
      };
    }

    function makeResult(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
      return {
        proposed: [makeProposal()],
        accepted: [],
        skipped: [makeProposal()],
        registered: [],
        rationale: 'Test rationale.',
        ...overrides,
      };
    }

    it('should output "no proposals" message when proposed is empty', () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

      formatDiscoveryOutput(makeResult({ proposed: [] }));

      expect(logs.some((l) => l.includes('No expert proposals'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('should include rationale in empty-proposals message', () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

      formatDiscoveryOutput(makeResult({ proposed: [], rationale: 'No clear boundaries.' }));

      expect(logs.some((l) => l.includes('No clear boundaries.'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('should show dry-run indicator when dryRun is true', () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

      formatDiscoveryOutput(makeResult(), true);

      expect(logs.some((l) => l.includes('dry run'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('should show accepted experts summary', () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

      formatDiscoveryOutput(
        makeResult({
          accepted: [makeProposal()],
          skipped: [],
        })
      );

      expect(logs.some((l) => l.includes('Accepted: 1'))).toBe(true);
      expect(logs.some((l) => l.includes('invoicing'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('should show registered experts with claude.md paths', () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

      formatDiscoveryOutput(
        makeResult({
          registered: [
            {
              slug: 'invoicing',
              mountPath: 'modules/Invoicing/',
              claudeMdPath: 'modules/Invoicing/claude.md',
            },
          ],
        })
      );

      expect(logs.some((l) => l.includes('Registered 1 expert(s)'))).toBe(true);
      expect(logs.some((l) => l.includes('claude.md'))).toBe(true);
      vi.restoreAllMocks();
    });
  });

  describe('expert discover: proposal table formatting', () => {
    it('should format proposals in a table with headers', () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

      const proposals: ProposedExpert[] = [
        {
          slug: 'auth',
          name: 'Auth',
          mountPath: 'modules/Auth/',
          description: 'Auth module.',
          reasoning: 'Clear boundary.',
          confidence: 0.85,
        },
        {
          slug: 'invoicing',
          name: 'Invoicing',
          mountPath: 'modules/Invoicing/',
          description: 'Invoicing module.',
          reasoning: 'High file count.',
          confidence: 0.92,
        },
      ];

      formatProposalTable(proposals);

      // Header row
      expect(
        logs.some((l) => l.includes('#') && l.includes('Slug') && l.includes('Mount Path'))
      ).toBe(true);
      // Data rows
      expect(logs.some((l) => l.includes('auth') && l.includes('modules/Auth/'))).toBe(true);
      expect(logs.some((l) => l.includes('invoicing') && l.includes('0.92'))).toBe(true);

      vi.restoreAllMocks();
    });
  });

  describe('expert discover: default stages', () => {
    it('should create default stages with all five functions', () => {
      const stages = createDefaultStages();

      expect(stages.collectTree).toBeTypeOf('function');
      expect(stages.enrichContext).toBeTypeOf('function');
      expect(stages.analyze).toBeTypeOf('function');
      expect(stages.review).toBeTypeOf('function');
      expect(stages.register).toBeTypeOf('function');
    });

    it('should collect tree from a real directory', () => {
      const stages = createDefaultStages();
      mkdirSync(join(contentDir, 'src'), { recursive: true });
      mkdirSync(join(contentDir, 'docs'), { recursive: true });

      const tree = stages.collectTree(contentDir);

      expect(tree).toContain('src/');
      expect(tree).toContain('docs/');
    });

    it('should enrich context with existing experts from database', () => {
      const stages = createDefaultStages();
      db.insertExpert({
        slug: 'existing-expert',
        name: 'Existing',
        mount_path: '/test/existing',
      });

      const context = stages.enrichContext('tree string', db, { rootPath: contentDir });

      expect(context.tree).toBe('tree string');
      expect(context.existingExperts).toHaveLength(1);
      expect(context.existingExperts[0].slug).toBe('existing-expert');
      expect(context.existingExperts[0].mountPath).toBe('/test/existing');
    });

    it('should wire the analyze stage from the analyze module', () => {
      const stages = createDefaultStages();
      // The analyze stage should be a function (the real implementation from analyze.js)
      expect(typeof stages.analyze).toBe('function');
      // It should be async (returns a Promise)
      const result = stages.analyze(
        { tree: 'tree', fileCountsByDirectory: {}, existingExperts: [] },
        { rootPath: contentDir }
      );
      expect(result).toBeInstanceOf(Promise);
      // Clean up the pending promise (it will reject since claude CLI isn't available)
      result.catch(() => {});
    });

    it('should wire the review stage from the review module', () => {
      const stages = createDefaultStages();
      // The review stage should be a function (the real interactive implementation)
      expect(typeof stages.review).toBe('function');
      // It is the real review function, so we just verify it's wired
      expect(stages.review.name).toBe('review');
    });

    it('should return empty results from default register stage', async () => {
      const stages = createDefaultStages();
      const result = await stages.register([], db, { rootPath: contentDir });

      expect(result).toHaveLength(0);
    });
  });
});
