import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { LuxDatabase } from '../index.js';

describe('Expert Session Manager', () => {
  const testDir = join(__dirname, 'fixtures', 'sessions-test');
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;
  let expertId: number;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    db = new LuxDatabase(dbPath);

    // Create an expert to attach sessions to
    expertId = db.insertExpert({
      slug: 'session-expert',
      name: 'Session Expert',
      mount_path: '/test/mount',
      model: 'claude-sonnet-4-20250514',
    });
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('insertExpertSession', () => {
    it('should create a session with default warm status', () => {
      const id = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-001',
      });

      expect(id).toBeGreaterThan(0);

      const session = db.getExpertSession(id);
      expect(session).toBeDefined();
      expect(session!.expert_id).toBe(expertId);
      expect(session!.session_ref).toBe('ref-001');
      expect(session!.status).toBe('warm');
    });

    it('should create a session with explicit status', () => {
      const id = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-002',
        status: 'active',
      });

      const session = db.getExpertSession(id);
      expect(session).toBeDefined();
      expect(session!.status).toBe('active');
    });

    it('should reject session for non-existent expert', () => {
      expect(() => {
        db.insertExpertSession({
          expert_id: 99999,
          session_ref: 'ref-bad',
        });
      }).toThrow();
    });

    it('should set spawned_at and last_active_at timestamps', () => {
      const id = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-ts',
      });

      const session = db.getExpertSession(id);
      expect(session).toBeDefined();
      expect(session!.spawned_at).toBeGreaterThan(0);
      expect(session!.last_active_at).toBeGreaterThan(0);
    });
  });

  describe('getExpertSession', () => {
    it('should return undefined for non-existent session', () => {
      const session = db.getExpertSession(99999);
      expect(session).toBeUndefined();
    });

    it('should return the correct session by ID', () => {
      const id1 = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-a',
      });
      const id2 = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-b',
      });

      const session1 = db.getExpertSession(id1);
      const session2 = db.getExpertSession(id2);

      expect(session1!.session_ref).toBe('ref-a');
      expect(session2!.session_ref).toBe('ref-b');
    });
  });

  describe('getSessionsByExpert', () => {
    it('should return empty array when no sessions exist', () => {
      const sessions = db.getSessionsByExpert(expertId);
      expect(sessions).toHaveLength(0);
    });

    it('should return all sessions for an expert', () => {
      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-1' });
      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-2' });
      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-3' });

      const sessions = db.getSessionsByExpert(expertId);
      expect(sessions).toHaveLength(3);
    });

    it('should not return sessions for a different expert', () => {
      const otherExpertId = db.insertExpert({
        slug: 'other-expert',
        name: 'Other Expert',
        mount_path: '/test/other',
        model: 'claude-sonnet-4-20250514',
      });

      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-mine' });
      db.insertExpertSession({ expert_id: otherExpertId, session_ref: 'ref-other' });

      const mine = db.getSessionsByExpert(expertId);
      const theirs = db.getSessionsByExpert(otherExpertId);

      expect(mine).toHaveLength(1);
      expect(mine[0].session_ref).toBe('ref-mine');
      expect(theirs).toHaveLength(1);
      expect(theirs[0].session_ref).toBe('ref-other');
    });
  });

  describe('getSessionsByStatus', () => {
    it('should filter sessions by status with expert info', () => {
      db.insertExpertSession({ expert_id: expertId, session_ref: 'warm-1' });
      db.insertExpertSession({ expert_id: expertId, session_ref: 'warm-2' });

      db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'active-1',
        status: 'active',
      });

      const warmSessions = db.getSessionsByStatus('warm');
      expect(warmSessions).toHaveLength(2);
      expect(warmSessions[0].expert_slug).toBe('session-expert');
      expect(warmSessions[0].expert_name).toBe('Session Expert');

      const activeSessions = db.getSessionsByStatus('active');
      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0].session_ref).toBe('active-1');
    });

    it('should return empty array for non-matching status', () => {
      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-1' });

      const sessions = db.getSessionsByStatus('idle');
      expect(sessions).toHaveLength(0);
    });
  });

  describe('getActiveSessionForExpert', () => {
    it('should return undefined when no warm sessions exist', () => {
      const session = db.getActiveSessionForExpert(expertId);
      expect(session).toBeUndefined();
    });

    it('should return a warm session when multiple exist', () => {
      db.insertExpertSession({ expert_id: expertId, session_ref: 'warm-first' });
      const secondId = db.insertExpertSession({ expert_id: expertId, session_ref: 'warm-second' });

      // Touch the second one to ensure it has a newer last_active_at
      db.touchExpertSession(secondId);

      const active = db.getActiveSessionForExpert(expertId);
      expect(active).toBeDefined();
      expect(active!.status).toBe('warm');
      // Should return one of the warm sessions
      expect(['warm-first', 'warm-second']).toContain(active!.session_ref);
    });

    it('should not return non-warm sessions', () => {
      db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'active-one',
        status: 'active',
      });

      const active = db.getActiveSessionForExpert(expertId);
      expect(active).toBeUndefined();
    });
  });

  describe('touchExpertSession', () => {
    it('should update last_active_at timestamp', () => {
      const id = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-touch',
      });

      const before = db.getExpertSession(id);
      expect(before).toBeDefined();

      // Touch the session
      db.touchExpertSession(id);

      const after = db.getExpertSession(id);
      expect(after).toBeDefined();
      expect(after!.last_active_at).toBeGreaterThanOrEqual(before!.last_active_at);
    });
  });

  describe('updateExpertSessionStatus', () => {
    it('should update session status', () => {
      const id = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-status',
      });

      expect(db.getExpertSession(id)!.status).toBe('warm');

      db.updateExpertSessionStatus(id, 'active');
      expect(db.getExpertSession(id)!.status).toBe('active');

      db.updateExpertSessionStatus(id, 'idle');
      expect(db.getExpertSession(id)!.status).toBe('idle');
    });

    it('should also update last_active_at on status change', () => {
      const id = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-ts-update',
      });

      const before = db.getExpertSession(id)!;
      db.updateExpertSessionStatus(id, 'active');
      const after = db.getExpertSession(id)!;

      expect(after.last_active_at).toBeGreaterThanOrEqual(before.last_active_at);
    });
  });

  describe('deleteExpertSession', () => {
    it('should delete a single session', () => {
      const id1 = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-keep',
      });
      const id2 = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'ref-delete',
      });

      db.deleteExpertSession(id2);

      expect(db.getExpertSession(id1)).toBeDefined();
      expect(db.getExpertSession(id2)).toBeUndefined();
    });

    it('should not throw when deleting non-existent session', () => {
      expect(() => db.deleteExpertSession(99999)).not.toThrow();
    });
  });

  describe('deleteSessionsByExpert', () => {
    it('should delete all sessions for an expert', () => {
      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-1' });
      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-2' });
      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-3' });

      expect(db.getSessionsByExpert(expertId)).toHaveLength(3);

      db.deleteSessionsByExpert(expertId);

      expect(db.getSessionsByExpert(expertId)).toHaveLength(0);
    });

    it('should not affect sessions of other experts', () => {
      const otherExpertId = db.insertExpert({
        slug: 'keep-expert',
        name: 'Keep Expert',
        mount_path: '/test/keep',
        model: 'claude-sonnet-4-20250514',
      });

      db.insertExpertSession({ expert_id: expertId, session_ref: 'ref-delete' });
      db.insertExpertSession({ expert_id: otherExpertId, session_ref: 'ref-keep' });

      db.deleteSessionsByExpert(expertId);

      expect(db.getSessionsByExpert(expertId)).toHaveLength(0);
      expect(db.getSessionsByExpert(otherExpertId)).toHaveLength(1);
    });
  });

  describe('session lifecycle', () => {
    it('should handle full session lifecycle: create -> activate -> idle -> delete', () => {
      // 1. Create warm session
      const id = db.insertExpertSession({
        expert_id: expertId,
        session_ref: 'lifecycle-ref',
      });
      expect(db.getExpertSession(id)!.status).toBe('warm');

      // 2. Activate
      db.updateExpertSessionStatus(id, 'active');
      expect(db.getExpertSession(id)!.status).toBe('active');

      // 3. Touch to keep alive
      db.touchExpertSession(id);

      // 4. Go idle
      db.updateExpertSessionStatus(id, 'idle');
      expect(db.getExpertSession(id)!.status).toBe('idle');

      // 5. Delete
      db.deleteExpertSession(id);
      expect(db.getExpertSession(id)).toBeUndefined();
    });
  });
});
