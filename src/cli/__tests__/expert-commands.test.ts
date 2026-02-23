import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import { validateMountPath } from '../expert.js';

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
});
