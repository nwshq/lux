import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { LuxDatabase } from '../index.js';

describe('Expert CRUD Operations', () => {
  const testDir = join(__dirname, 'fixtures', 'expert-crud-test');
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(dbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('insertExpert', () => {
    it('should insert an expert with all fields', () => {
      const id = db.insertExpert({
        slug: 'full-expert',
        name: 'Full Expert',
        mount_path: '/test/full',
        model: 'claude-opus-4-20250514',
        claude_md_path: '/test/full/CLAUDE.md',
        memory_path: '/test/full/memory.md',
        status: 'inactive',
      });

      expect(id).toBeGreaterThan(0);

      const expert = db.getExpert('full-expert');
      expect(expert).toBeDefined();
      expect(expert!.slug).toBe('full-expert');
      expect(expert!.name).toBe('Full Expert');
      expect(expert!.mount_path).toBe('/test/full');
      expect(expert!.model).toBe('claude-opus-4-20250514');
      expect(expert!.claude_md_path).toBe('/test/full/CLAUDE.md');
      expect(expert!.memory_path).toBe('/test/full/memory.md');
      expect(expert!.status).toBe('inactive');
    });

    it('should apply default model when not specified', () => {
      db.insertExpert({
        slug: 'default-model',
        name: 'Default Model Expert',
        mount_path: '/test/default',
      });

      const expert = db.getExpert('default-model');
      expect(expert).toBeDefined();
      expect(expert!.model).toBe('gpt-5.4');
    });

    it('should apply default active status when not specified', () => {
      db.insertExpert({
        slug: 'default-status',
        name: 'Default Status Expert',
        mount_path: '/test/default',
      });

      const expert = db.getExpert('default-status');
      expect(expert).toBeDefined();
      expect(expert!.status).toBe('active');
    });

    it('should set null for optional claude_md_path and memory_path', () => {
      db.insertExpert({
        slug: 'minimal',
        name: 'Minimal Expert',
        mount_path: '/test/minimal',
      });

      const expert = db.getExpert('minimal');
      expect(expert).toBeDefined();
      expect(expert!.claude_md_path).toBeNull();
      expect(expert!.memory_path).toBeNull();
    });

    it('should reject duplicate slugs', () => {
      db.insertExpert({
        slug: 'unique-slug',
        name: 'First Expert',
        mount_path: '/test/first',
      });

      expect(() => {
        db.insertExpert({
          slug: 'unique-slug',
          name: 'Duplicate Expert',
          mount_path: '/test/duplicate',
        });
      }).toThrow(/[Dd]uplicate/);
    });

    it('should set created_at and updated_at timestamps', () => {
      db.insertExpert({
        slug: 'timestamped',
        name: 'Timestamped Expert',
        mount_path: '/test/ts',
      });

      const expert = db.getExpert('timestamped');
      expect(expert).toBeDefined();
      expect(expert!.created_at).toBeGreaterThan(0);
      expect(expert!.updated_at).toBeGreaterThan(0);
    });
  });

  describe('getExpert', () => {
    it('should return undefined for non-existent slug', () => {
      const expert = db.getExpert('ghost');
      expect(expert).toBeUndefined();
    });

    it('should retrieve expert by slug', () => {
      db.insertExpert({
        slug: 'findme',
        name: 'Find Me',
        mount_path: '/test/find',
      });

      const expert = db.getExpert('findme');
      expect(expert).toBeDefined();
      expect(expert!.name).toBe('Find Me');
    });
  });

  describe('getAllExperts', () => {
    it('should return empty array when no experts exist', () => {
      const experts = db.getAllExperts();
      expect(experts).toHaveLength(0);
    });

    it('should return all experts ordered by name', () => {
      db.insertExpert({ slug: 'z-expert', name: 'Zara Expert', mount_path: '/test/z' });
      db.insertExpert({ slug: 'a-expert', name: 'Alpha Expert', mount_path: '/test/a' });
      db.insertExpert({ slug: 'm-expert', name: 'Mid Expert', mount_path: '/test/m' });

      const experts = db.getAllExperts();
      expect(experts).toHaveLength(3);
      expect(experts[0].name).toBe('Alpha Expert');
      expect(experts[1].name).toBe('Mid Expert');
      expect(experts[2].name).toBe('Zara Expert');
    });
  });

  describe('getExpertsByStatus', () => {
    it('should filter by active status', () => {
      db.insertExpert({
        slug: 'active-1',
        name: 'Active 1',
        mount_path: '/test/a1',
        status: 'active',
      });
      db.insertExpert({
        slug: 'active-2',
        name: 'Active 2',
        mount_path: '/test/a2',
        status: 'active',
      });
      db.insertExpert({
        slug: 'inactive-1',
        name: 'Inactive 1',
        mount_path: '/test/i1',
        status: 'inactive',
      });

      const active = db.getExpertsByStatus('active');
      expect(active).toHaveLength(2);
      active.forEach((e) => expect(e.status).toBe('active'));

      const inactive = db.getExpertsByStatus('inactive');
      expect(inactive).toHaveLength(1);
      expect(inactive[0].slug).toBe('inactive-1');
    });

    it('should return empty array for non-matching status', () => {
      db.insertExpert({ slug: 'only-active', name: 'Only Active', mount_path: '/test/oa' });

      const inactive = db.getExpertsByStatus('inactive');
      expect(inactive).toHaveLength(0);
    });
  });

  describe('updateExpert', () => {
    it('should update expert name', () => {
      db.insertExpert({ slug: 'updatable', name: 'Old Name', mount_path: '/test/u' });

      db.updateExpert('updatable', { name: 'New Name' });

      const expert = db.getExpert('updatable');
      expect(expert!.name).toBe('New Name');
    });

    it('should update expert model', () => {
      db.insertExpert({ slug: 'model-change', name: 'Model Change', mount_path: '/test/mc' });

      db.updateExpert('model-change', { model: 'claude-opus-4-20250514' });

      const expert = db.getExpert('model-change');
      expect(expert!.model).toBe('claude-opus-4-20250514');
    });

    it('should update expert status', () => {
      db.insertExpert({ slug: 'status-change', name: 'Status Change', mount_path: '/test/sc' });

      expect(db.getExpert('status-change')!.status).toBe('active');

      db.updateExpert('status-change', { status: 'inactive' });

      expect(db.getExpert('status-change')!.status).toBe('inactive');
    });

    it('should update claude_md_path and memory_path', () => {
      db.insertExpert({ slug: 'paths-update', name: 'Paths', mount_path: '/test/paths' });

      db.updateExpert('paths-update', {
        claude_md_path: '/test/paths/CLAUDE.md',
        memory_path: '/test/paths/memory.md',
      });

      const expert = db.getExpert('paths-update');
      expect(expert!.claude_md_path).toBe('/test/paths/CLAUDE.md');
      expect(expert!.memory_path).toBe('/test/paths/memory.md');
    });

    it('should preserve fields not included in update', () => {
      db.insertExpert({
        slug: 'preserve',
        name: 'Preserve Me',
        mount_path: '/test/preserve',
        model: 'claude-opus-4-20250514',
      });

      db.updateExpert('preserve', { name: 'Updated Name' });

      const expert = db.getExpert('preserve');
      expect(expert!.name).toBe('Updated Name');
      expect(expert!.model).toBe('claude-opus-4-20250514');
      expect(expert!.mount_path).toBe('/test/preserve');
    });
  });

  describe('deleteExpert', () => {
    it('should delete an expert by slug', () => {
      db.insertExpert({ slug: 'deletable', name: 'Deletable', mount_path: '/test/del' });
      expect(db.getExpert('deletable')).toBeDefined();

      db.deleteExpert('deletable');
      expect(db.getExpert('deletable')).toBeUndefined();
    });

    it('should not throw when deleting non-existent expert', () => {
      expect(() => db.deleteExpert('ghost')).not.toThrow();
    });

    it('should not affect other experts', () => {
      db.insertExpert({ slug: 'keep', name: 'Keep', mount_path: '/test/keep' });
      db.insertExpert({ slug: 'remove', name: 'Remove', mount_path: '/test/remove' });

      db.deleteExpert('remove');

      expect(db.getExpert('keep')).toBeDefined();
      expect(db.getExpert('remove')).toBeUndefined();
    });
  });

  describe('expert count in stats', () => {
    it('should include expert count in getStats', () => {
      const before = db.getStats();
      expect(before.experts).toBe(0);

      db.insertExpert({ slug: 'counted-1', name: 'Counted 1', mount_path: '/test/c1' });
      db.insertExpert({ slug: 'counted-2', name: 'Counted 2', mount_path: '/test/c2' });

      const after = db.getStats();
      expect(after.experts).toBe(2);
    });
  });

  describe('clearAll', () => {
    it('should clear all experts and sessions', () => {
      const expertId = db.insertExpert({
        slug: 'clearable',
        name: 'Clearable',
        mount_path: '/test/clear',
      });
      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-clear' });

      db.clearAll();

      expect(db.getAllExperts()).toHaveLength(0);
      expect(db.getStats().experts).toBe(0);
    });
  });
});
